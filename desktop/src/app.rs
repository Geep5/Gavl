//! The window's root view: owns the daemon snapshot, form state, and in-flight actions, and renders
//! the shell (title bar · sidebar · page · status bar). Pages live in `pages/`.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

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

use crate::api::{self, Client, NetEvent, OffersPage, Snapshot, Swap, Wallet};
use crate::format;
use crate::pages::{market::MarketForm, wallet::SendForm};
use crate::status::{self, Health};

/// Network events kept for the activity log.
const MAX_EVENTS: usize = 300;
const POLL_EVERY: Duration = Duration::from_secs(2);
/// Balances come from the chains' explorers via the daemon; poll them more gently.
const WALLETS_EVERY: Duration = Duration::from_secs(15);
/// Gavl's anchor target spacing (`ANCHOR_SECONDS`); deadlines are counted in anchors.
const ANCHOR_SECONDS: f64 = 60.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Market,
    Swaps,
    Wallet,
    Network,
    Node,
}

impl Page {
    pub const ALL: [Page; 5] = [Page::Market, Page::Swaps, Page::Wallet, Page::Network, Page::Node];

    fn label(self) -> &'static str {
        match self {
            Page::Market => "Market",
            Page::Swaps => "Swaps",
            Page::Wallet => "Wallet",
            Page::Network => "Network",
            Page::Node => "Node",
        }
    }

    fn icon(self) -> Icon {
        match self {
            Page::Market => Icon::empty().path("icons/trending-up.svg"),
            Page::Swaps => Icon::empty().path("icons/shield-check.svg"),
            Page::Wallet => Icon::empty().path("icons/wallet.svg"),
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
    PostOffer,
    Take,
    Cancel,
    Send,
}

pub enum Connection {
    Connecting,
    Online,
    Offline(String),
}

/// One optional daemon endpoint's latest result.
pub enum Feed<T> {
    Loading,
    /// The daemon answered 404: it doesn't serve this yet (e.g. no swap engine).
    Missing,
    Failed(String),
    Ready(T),
}

impl<T> Feed<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Feed::Ready(v) => Some(v),
            _ => None,
        }
    }

    /// A transient error after good data keeps the data; the next poll retries.
    fn update(&mut self, result: Result<Option<T>, String>) {
        *self = match result {
            Ok(Some(v)) => Feed::Ready(v),
            Ok(None) => Feed::Missing,
            Err(_) if matches!(self, Feed::Ready(_)) => return,
            Err(e) => Feed::Failed(e),
        };
    }
}

pub struct GavlApp {
    pub client: Client,
    pub page: Page,
    pub snapshot: Snapshot,
    pub connection: Connection,
    pub events: VecDeque<NetEvent>,
    events_cursor: u64,
    fetching: bool,
    pub offers: Feed<OffersPage>,
    pub swaps: Feed<Vec<Swap>>,
    pub wallets: Feed<Vec<Wallet>>,
    fetching_wallets: bool,
    /// When the wallets last loaded; `None` forces a reload on the next poll.
    pub wallets_at: Option<Instant>,
    pub market: MarketForm,
    pub send: SendForm,
    pub busy: HashSet<Busy>,
    _poll: Task<()>,
    _inputs: Vec<Subscription>,
}

impl GavlApp {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let poll = cx.spawn(async move |this, cx| {
            loop {
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(POLL_EVERY).await;
            }
        });

        let mut inputs = Vec::new();
        let market = MarketForm::new(window, cx, &mut inputs);
        let send = SendForm::new(window, cx, &mut inputs);

        Self {
            client,
            page: Page::Market,
            snapshot: Snapshot::default(),
            connection: Connection::Connecting,
            events: VecDeque::new(),
            events_cursor: 0,
            fetching: false,
            offers: Feed::Loading,
            swaps: Feed::Loading,
            wallets: Feed::Loading,
            fetching_wallets: false,
            wallets_at: None,
            market,
            send,
            busy: HashSet::new(),
            _poll: poll,
            _inputs: inputs,
        }
    }

    /// Pull `/api/state`, new events, the order board and swaps off the UI thread. Overlapping
    /// refreshes are dropped.
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
                    let offers = client.offers().map_err(|e| format!("{e:#}"));
                    let swaps = client.swaps().map_err(|e| format!("{e:#}"));
                    anyhow::Ok((state, events, offers, swaps))
                })
                .await;
            this.update(cx, |this, cx| {
                this.fetching = false;
                match result {
                    Ok((state, events, offers, swaps)) => {
                        this.snapshot = state;
                        if let Some(page) = events {
                            this.apply_events(page);
                        }
                        this.offers.update(offers);
                        this.swaps.update(swaps);
                        this.connection = Connection::Online;
                        if this.wallets_at.is_none_or(|at| at.elapsed() >= WALLETS_EVERY) {
                            this.refresh_wallets(cx);
                        }
                    }
                    Err(err) => this.connection = Connection::Offline(format!("{err:#}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Balances hit the chains' explorers, so they load on their own slower cadence.
    fn refresh_wallets(&mut self, cx: &mut Context<Self>) {
        if self.fetching_wallets {
            return;
        }
        self.fetching_wallets = true;
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_spawn(async move { client.wallets().map_err(|e| format!("{e:#}")) }).await;
            this.update(cx, |this, cx| {
                this.fetching_wallets = false;
                this.wallets_at = Some(Instant::now());
                this.wallets.update(result);
                cx.notify();
            })
            .ok();
        })
        .detach();
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
        D: FnOnce(&mut Self, Value, &mut Window, &mut Context<Self>) -> Option<String> + 'static,
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
                        if let Some(message) = done(this, value, window, cx) {
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

    /// Wall-clock seconds per Gavl anchor: measured when the daemon has a figure, else the target.
    pub fn anchor_seconds(&self) -> f64 {
        match self.snapshot.consensus.as_ref() {
            Some(c) if c.sec_per_anchor_measured && c.sec_per_anchor > 0. => c.sec_per_anchor,
            _ => ANCHOR_SECONDS,
        }
    }

    /// `anchors` from now as a rough span, e.g. `3h 20m`.
    pub fn anchors_span(&self, anchors: u64) -> String {
        format::span((anchors as f64 * self.anchor_seconds()).round() as u64)
    }

    pub fn summary(&self) -> status::Summary {
        let consensus = match self.connection {
            Connection::Online => self.snapshot.consensus.as_ref(),
            _ => None,
        };
        status::summarize(consensus)
    }

    pub fn active_key(&self) -> &str {
        self.snapshot.active.as_deref().unwrap_or_default()
    }

    /// Whether `pub_hex` is one of this daemon's identities.
    pub fn is_mine(&self, pub_hex: &str) -> bool {
        self.snapshot.accounts.iter().any(|a| a.pub_hex == pub_hex)
    }

    pub fn account_label(&self, pub_hex: &str) -> String {
        self.snapshot
            .accounts
            .iter()
            .find(|a| a.pub_hex == pub_hex)
            .map(|a| a.label.clone())
            .unwrap_or_else(|| format::short_hex(pub_hex))
    }

    pub fn active_label(&self) -> String {
        self.account_label(self.active_key())
    }

    pub fn wallet(&self, chain: api::Chain) -> Option<&Wallet> {
        self.wallets.ready()?.iter().find(|w| w.chain == chain)
    }

    /// Swaps still in progress.
    pub fn open_swaps(&self) -> usize {
        self.swaps.ready().map_or(0, |s| s.iter().filter(|s| !s.stage.is_final()).count())
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
        let open = self.open_swaps();
        let menu = SidebarMenu::new().children(Page::ALL.map(|page| {
            let item = SidebarMenuItem::new(page.label())
                .icon(page.icon())
                .active(self.page == page)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.page = page;
                    cx.notify();
                }));
            if page == Page::Swaps && open > 0 {
                let count = open.to_string();
                item.suffix(move |_, _| Tag::info().small().child(count.clone()))
            } else {
                item
            }
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
            Page::Market => self.render_market(window, cx),
            Page::Swaps => self.render_swaps(window, cx),
            Page::Wallet => self.render_wallet(window, cx),
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
