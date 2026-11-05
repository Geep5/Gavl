//! The window's root view: owns the daemon snapshot, form state, and in-flight actions, and renders
//! the shell (title bar · sidebar · page · status bar). Pages live in `pages/`.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable, StyledExt, Theme, ThemeMode, TitleBar, WindowExt,
    alert::Alert,
    button::{Button, ButtonVariants},
    input::InputState,
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
    Rounds,
    Wallet,
    Network,
    Custody,
    Node,
}

impl Page {
    pub const ALL: [Page; 5] = [Page::Rounds, Page::Wallet, Page::Network, Page::Custody, Page::Node];

    fn label(self) -> &'static str {
        match self {
            Page::Rounds => "Rounds",
            Page::Wallet => "Wallet",
            Page::Network => "Network",
            Page::Custody => "Custody",
            Page::Node => "Node",
        }
    }

    fn icon(self) -> Icon {
        match self {
            Page::Rounds => Icon::new(gpui_kit::assets::IconName::TrendingUp),
            Page::Wallet => Icon::new(gpui_kit::assets::IconName::Wallet),
            Page::Network => Icon::new(IconName::Network),
            Page::Custody => Icon::new(gpui_kit::assets::IconName::ShieldCheck),
            Page::Node => Icon::new(IconName::HardDrive),
        }
    }
}

/// An action that can be in flight; buttons show `loading` and refuse double-submits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Busy {
    Enter(api::Side),
    Claim,
    Withdraw,
    ProcessPayouts,
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
    /// Last tip height and when we first saw it — countdowns tick locally between blocks.
    tip_seen: (u64, Instant),
    /// Previous price, for the up/down caret.
    price_prev: Option<(String, i8)>,
    pub busy: HashSet<Busy>,

    pub stake: Entity<InputState>,
    pub deposit_txid: Entity<InputState>,
    pub withdraw_amount: Entity<InputState>,
    pub withdraw_address: Entity<InputState>,
    pub withdraw_fee: Entity<InputState>,
    pub claim_result: Option<String>,

    _poll: Task<()>,
    _tick: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl GavlApp {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let stake = cx.new(|cx| InputState::new(window, cx).placeholder("Stake").default_value("1000"));
        let deposit_txid = cx.new(|cx| InputState::new(window, cx).placeholder("Deposit transaction id (64 hex characters)"));
        let withdraw_amount = cx.new(|cx| InputState::new(window, cx).placeholder("Amount"));
        let withdraw_address = cx.new(|cx| InputState::new(window, cx).placeholder("Bitcoin address (tb1…)"));
        let withdraw_fee = cx.new(|cx| InputState::new(window, cx).placeholder("Miner fee").default_value("1000"));

        // Re-render on edits so derived validation and summaries stay current.
        let mut subscriptions = Vec::new();
        for input in [&stake, &deposit_txid, &withdraw_amount, &withdraw_address, &withdraw_fee] {
            subscriptions.push(cx.observe(input, |_, _, cx| cx.notify()));
        }

        let poll = cx.spawn(async move |this, cx| {
            loop {
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(POLL_EVERY).await;
            }
        });
        // Countdowns are derived from the last tip + elapsed time; repaint once a second.
        let tick = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });

        Self {
            client,
            page: Page::Rounds,
            snapshot: Snapshot::default(),
            connection: Connection::Connecting,
            events: VecDeque::new(),
            events_cursor: 0,
            fetching: false,
            tip_seen: (0, Instant::now()),
            price_prev: None,
            busy: HashSet::new(),
            stake,
            deposit_txid,
            withdraw_amount,
            withdraw_address,
            withdraw_fee,
            claim_result: None,
            _poll: poll,
            _tick: tick,
            _subscriptions: subscriptions,
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
        let height = state.consensus.as_ref().and_then(|c| c.tip.as_ref()).map_or(0, |t| t.height);
        if height != self.tip_seen.0 {
            self.tip_seen = (height, Instant::now());
        }
        if let Some(price) = state.market.as_ref().and_then(|m| m.price.clone()) {
            let dir = match &self.price_prev {
                Some((prev, dir)) if *prev == price => *dir,
                Some((prev, _)) => (api::amount(&price) as i128 - api::amount(prev) as i128).signum() as i8,
                None => 0,
            };
            self.price_prev = Some((price, dir));
        }
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
        self.tip_seen.0
    }

    pub fn sec_per_block(&self) -> f64 {
        self.snapshot.consensus.as_ref().map(|c| c.sec_per_anchor).filter(|s| *s > 0.0).unwrap_or(60.0)
    }

    /// Estimated seconds until the chain reaches `height`, ticking down between blocks.
    pub fn secs_until(&self, height: u64) -> u64 {
        let blocks = height.saturating_sub(self.tip_seen.0) as f64;
        let elapsed = self.tip_seen.1.elapsed().as_secs_f64();
        (blocks * self.sec_per_block() - elapsed).max(0.0).round() as u64
    }

    pub fn balance(&self) -> u128 {
        self.snapshot.market.as_ref().map_or(0, |m| api::amount(&m.my_gbtc))
    }

    pub fn price_text(&self) -> Option<String> {
        let m = self.snapshot.market.as_ref()?;
        format::usd(m.price.as_deref()?, m.price_expo)
    }

    /// -1 / 0 / +1 versus the previous price.
    pub fn price_direction(&self) -> i8 {
        self.price_prev.as_ref().map_or(0, |(_, d)| *d)
    }

    pub fn market_label(&self) -> String {
        self.snapshot
            .market
            .as_ref()
            .and_then(|m| m.market_info.as_ref())
            .map(|i| i.label.clone())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "BTC-USD".into())
    }

    pub fn min_committee(&self) -> u32 {
        self.snapshot.custody.as_ref().map(|c| c.min_committee).filter(|n| *n > 0).unwrap_or(3)
    }

    pub fn summary(&self) -> status::Summary {
        let consensus = match self.connection {
            Connection::Online => self.snapshot.consensus.as_ref(),
            _ => None,
        };
        status::summarize(consensus, self.min_committee())
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
            Health::Lobby { .. } | Health::NoPeers => Tag::warning(),
            Health::Offline | Health::Disabled => Tag::danger(),
        }
        .outline()
    }

    // ── shell ──

    fn render_title_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let summary = self.summary();
        let dark = cx.theme().is_dark();
        TitleBar::new()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().font_semibold().child("Gavl"))
                    .child(div().text_color(cx.theme().muted_foreground).child(self.market_label())),
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
                SidebarFooter::new().child(
                    v_flex()
                        .gap_0p5()
                        .child(div().text_xs().text_color(cx.theme().muted_foreground).child(self.active_label()))
                        .child(div().font_semibold().child(format::gbtc(self.balance()))),
                ),
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
        if let Some(price) = self.price_text() {
            bar = bar.right(format!("{} {price}", self.market_label()));
        }
        bar.into_any_element()
    }

    fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match self.page {
            Page::Rounds => self.render_rounds(window, cx),
            Page::Wallet => self.render_wallet(window, cx),
            Page::Network => self.render_network(window, cx),
            Page::Custody => self.render_custody(window, cx),
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
