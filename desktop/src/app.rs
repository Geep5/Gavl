//! The window's root view: owns the daemon snapshot, form state, and in-flight actions, and renders
//! the shell (title bar · sidebar · page · status bar). Pages live in `pages/`.

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable, StyledExt, Theme, ThemeMode, TitleBar, WindowExt,
    alert::Alert,
    button::{Button, ButtonVariants},
    notification::Notification,
    sidebar::{Sidebar, SidebarFooter, SidebarMenu, SidebarMenuItem},
    status_bar::StatusBar,
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::*;
use serde_json::Value;

use crate::api::{self, Client, NetEvent, Snapshot};
use crate::format;
use crate::status::{self, Health};

/// Network events kept for the activity log.
const MAX_EVENTS: usize = 300;
const POLL_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Network,
    Node,
}

impl Page {
    pub const ALL: [Page; 2] = [Page::Network, Page::Node];

    fn label(self) -> &'static str {
        match self {
            Page::Network => "Network",
            Page::Node => "Node",
        }
    }

    fn icon(self) -> Icon {
        match self {
            Page::Network => Icon::new(IconName::Network),
            Page::Node => Icon::new(IconName::HardDrive),
        }
    }
}

/// An action that can be in flight; buttons show `loading` and refuse double-submits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Busy {
    SwitchAccount,
    Gossip,
    FleetUp,
    FleetDown,
}

pub enum Connection {
    Connecting,
    Online,
    Offline(String),
}

pub struct GavlApp {
    pub client: Client,
    pub page: Page,
    pub snapshot: Snapshot,
    pub connection: Connection,
    pub events: VecDeque<NetEvent>,
    events_cursor: u64,
    fetching: bool,
    pub busy: HashSet<Busy>,
    _poll: Task<()>,
}

impl GavlApp {
    pub fn new(client: Client, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let poll = cx.spawn(async move |this, cx| {
            loop {
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(POLL_EVERY).await;
            }
        });

        Self {
            client,
            page: Page::Network,
            snapshot: Snapshot::default(),
            connection: Connection::Connecting,
            events: VecDeque::new(),
            events_cursor: 0,
            fetching: false,
            busy: HashSet::new(),
            _poll: poll,
        }
    }

    /// Pull `/api/state` + new events off the UI thread. Overlapping refreshes are dropped.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.fetching {
            return;
        }
        self.fetching = true;
        let client = self.client.clone();
        let since = self.events_cursor;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let state = client.state()?;
                    let events = client.events(since).ok();
                    anyhow::Ok((state, events))
                })
                .await;
            this.update(cx, |this, cx| {
                this.fetching = false;
                match result {
                    Ok((state, events)) => {
                        this.apply_snapshot(state);
                        if let Some(page) = events {
                            this.apply_events(page);
                        }
                        this.connection = Connection::Online;
                    }
                    Err(err) => this.connection = Connection::Offline(format!("{err:#}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn apply_snapshot(&mut self, state: Snapshot) {
        self.snapshot = state;
    }

    fn apply_events(&mut self, page: api::EventPage) {
        if page.cursor < self.events_cursor {
            // The daemon restarted and its sequence reset; start the log over.
            self.events.clear();
        }
        self.events_cursor = page.cursor;
        for e in page.events {
            if self.events.back().is_some_and(|last| last.seq >= e.seq) {
                continue;
            }
            self.events.push_back(e);
        }
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }

    /// Run a daemon call off the UI thread. `done` maps the response to an optional success toast;
    /// errors always toast. The UI refreshes afterwards either way.
    pub fn run<F, D>(&mut self, busy: Busy, window: &mut Window, cx: &mut Context<Self>, call: F, done: D)
    where
        F: FnOnce(&Client) -> anyhow::Result<Value> + Send + 'static,
        D: FnOnce(&mut Self, Value) -> Option<String> + 'static,
    {
        if !self.busy.insert(busy) {
            return;
        }
        cx.notify();
        let client = self.client.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx.background_spawn(async move { call(&client) }).await;
            this.update_in(cx, |this, window, cx| {
                this.busy.remove(&busy);
                match result {
                    Ok(value) => {
                        if let Some(message) = done(this, value) {
                            window.push_notification(Notification::success(message), cx);
                        }
                    }
                    Err(err) => window.push_notification(Notification::error(format!("{err:#}")), cx),
                }
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ── derived reads shared by pages ──

    pub fn height(&self) -> u64 {
        self.snapshot.consensus.as_ref().and_then(|c| c.tip.as_ref()).map_or(0, |t| t.height)
    }

    pub fn summary(&self) -> status::Summary {
        let consensus = match self.connection {
            Connection::Online => self.snapshot.consensus.as_ref(),
            _ => None,
        };
        status::summarize(consensus)
    }

    pub fn active_label(&self) -> String {
        let active = self.snapshot.active.as_deref().unwrap_or_default();
        self.snapshot
            .accounts
            .iter()
            .find(|a| a.pub_hex == active)
            .map(|a| a.label.clone())
            .unwrap_or_else(|| format::short_hex(active))
    }

    /// Outline tags keep their text legible on both light and dark surfaces.
    pub fn health_tag(health: Health) -> Tag {
        match health {
            Health::Live => Tag::success(),
            Health::Starting => Tag::info(),
            Health::NoPeers => Tag::warning(),
            Health::Offline | Health::Disabled => Tag::danger(),
        }
        .outline()
    }

    // ── shell ──

    fn render_title_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let summary = self.summary();
        let dark = cx.theme().is_dark();
        let network = self.snapshot.consensus.as_ref().map(|c| c.network.clone()).unwrap_or_default();
        TitleBar::new()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().font_semibold().child("Gavl"))
                    .child(div().text_color(cx.theme().muted_foreground).child(network)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .pr_2()
                    .child(Self::health_tag(summary.health).small().child(summary.title))
                    .child(
                        Button::new("theme")
                            .ghost()
                            .small()
                            .icon(if dark { IconName::Sun } else { IconName::Moon })
                            .tooltip(if dark { "Light appearance" } else { "Dark appearance" })
                            .on_click(move |_, window, cx| {
                                let mode = if dark { ThemeMode::Light } else { ThemeMode::Dark };
                                Theme::change(mode, Some(window), cx);
                                window.refresh();
                            }),
                    ),
            )
            .into_any_element()
    }

    fn render_sidebar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let menu = SidebarMenu::new().children(Page::ALL.map(|page| {
            SidebarMenuItem::new(page.label())
                .icon(page.icon())
                .active(self.page == page)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.page = page;
                    cx.notify();
                }))
        }));
        Sidebar::new("nav")
            .collapsible(false)
            .child(menu)
            .footer(
                SidebarFooter::new().child(div().text_xs().text_color(cx.theme().muted_foreground).child(self.active_label())),
            )
            .into_any_element()
    }

    /// Details only; the title bar already carries the health tag.
    fn render_status_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mut bar = StatusBar::new();
        match (&self.connection, self.snapshot.consensus.as_ref()) {
            (Connection::Online, Some(c)) => {
                bar = bar
                    .left(format!("Block {}", format::int(self.height() as u128)))
                    .left(format!("Finalized {}", format::int(c.finalized_height.unwrap_or(0) as u128)))
                    .left(format!("{} peer{}", c.peers, status::plural(c.peers)))
                    .left(status::proof_mode(c).to_string());
            }
            (Connection::Offline(err), _) => {
                bar = bar.left(div().text_color(cx.theme().muted_foreground).child(format!("{} — {err}", self.client.base())));
            }
            _ => bar = bar.left("Connecting…"),
        }
        bar.into_any_element()
    }

    fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match self.page {
            Page::Network => self.render_network(window, cx),
            Page::Node => self.render_node(window, cx),
        }
    }
}

impl Render for GavlApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title_bar = self.render_title_bar(cx);
        let sidebar = self.render_sidebar(cx);
        let page = self.render_page(window, cx);
        let offline = matches!(self.connection, Connection::Offline(_)).then(|| {
            Alert::error(
                "daemon-offline",
                format!("Can't reach the Gavl daemon at {}. Start it with `npm run dev` in the Gavl repo; this window reconnects on its own.", self.client.base()),
            )
            .banner()
        });
        let status_bar = self.render_status_bar(cx);
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(title_bar)
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_start()
                    .child(sidebar)
                    .child(v_flex().flex_1().min_w_0().h_full().children(offline).child(div().flex_1().min_h_0().child(page))),
            )
            .child(status_bar)
    }
}
