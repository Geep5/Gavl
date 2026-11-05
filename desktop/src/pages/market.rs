//! Market: the order board. Take someone's offer, list your own, cancel it.

use gpui_kit::component::{
    ActiveTheme, Disableable, Selectable, Sizable,
    alert::Alert,
    button::{Button, ButtonGroup, ButtonVariants},
    input::{Input, InputState},
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, field, muted, page, problem, section, text_input};
use crate::api::{Chain, Offer, OffersPage};
use crate::app::{Busy, Feed, GavlApp, Page};
use crate::format;

/// Offers live at most 2880 anchors (`MAX_OFFER_TTL`), ~48h.
const MAX_EXPIRY_HOURS: u32 = 48;
const DEFAULT_EXPIRY_HOURS: &str = "24";
/// Anchors per hour at the 60 s target.
const ANCHORS_PER_HOUR: u32 = 60;

/// Which side of the board to show, from the viewer's side: `Buy(BTC)` = offers giving BTC.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    All,
    Buy(Chain),
}

impl Filter {
    const ALL: [Filter; 3] = [Filter::All, Filter::Buy(Chain::Bitcoin), Filter::Buy(Chain::Litecoin)];

    fn label(self) -> String {
        match self {
            Filter::All => "All offers".into(),
            Filter::Buy(c) => format!("Buy {} with {}", c.symbol(), c.other().symbol()),
        }
    }

    fn keeps(self, offer: &Offer) -> bool {
        match self {
            Filter::All => true,
            Filter::Buy(c) => offer.give.chain == c,
        }
    }
}

pub struct MarketForm {
    filter: Filter,
    /// The chain the new offer gives; it wants the other one.
    give: Chain,
    give_amount: Entity<InputState>,
    want_amount: Entity<InputState>,
    min_fill: Entity<InputState>,
    expiry_hours: Entity<InputState>,
    /// The offer whose take panel is open.
    taking: Option<String>,
    fill: Entity<InputState>,
}

impl MarketForm {
    pub fn new(window: &mut Window, cx: &mut Context<GavlApp>, subscriptions: &mut Vec<Subscription>) -> Self {
        Self {
            filter: Filter::All,
            give: Chain::Bitcoin,
            give_amount: text_input("0.01", "", window, cx, subscriptions),
            want_amount: text_input("1.2", "", window, cx, subscriptions),
            min_fill: text_input("Whole amount", "", window, cx, subscriptions),
            expiry_hours: text_input("24", DEFAULT_EXPIRY_HOURS, window, cx, subscriptions),
            taking: None,
            fill: text_input("Amount", "", window, cx, subscriptions),
        }
    }
}

/// A validated new offer, in base units and anchors.
#[derive(Debug, PartialEq, Eq)]
pub struct NewOffer {
    pub give: Chain,
    pub give_amount: u64,
    pub want_amount: u64,
    pub min_fill: u64,
    pub expires_in: u32,
}

/// Check the new-offer form the way the fold will (dust floors, min fill ≤ amount, TTL range).
pub fn validate_offer(give: Chain, give_text: &str, want_text: &str, min_text: &str, hours_text: &str) -> Result<NewOffer, String> {
    let want = give.other();
    let give_amount = format::parse_coin(give_text).map_err(|e| format!("You give: {}", e.message()))?;
    let want_amount = format::parse_coin(want_text).map_err(|e| format!("You want: {}", e.message()))?;
    if give_amount < give.dust() {
        return Err(format!("You give: at least {} {}.", format::coin(give.dust()), give.symbol()));
    }
    if want_amount < want.dust() {
        return Err(format!("You want: at least {} {}.", format::coin(want.dust()), want.symbol()));
    }
    let min_fill = if min_text.trim().is_empty() {
        give_amount
    } else {
        format::parse_coin(min_text).map_err(|e| format!("Minimum fill: {}", e.message()))?
    };
    if min_fill > give_amount {
        return Err("Minimum fill can't exceed the amount you give.".into());
    }
    if min_fill < give.dust() || format::pro_rata(min_fill, give_amount, want_amount) < want.dust() {
        return Err("Minimum fill is too small: one leg of the smallest swap would be below the dust limit.".into());
    }
    let hours: u32 = hours_text.trim().parse().map_err(|_| format!("Expires in: whole hours, 1–{MAX_EXPIRY_HOURS}."))?;
    if !(1..=MAX_EXPIRY_HOURS).contains(&hours) {
        return Err(format!("Expires in: whole hours, 1–{MAX_EXPIRY_HOURS}."));
    }
    Ok(NewOffer { give, give_amount, want_amount, min_fill, expires_in: hours * ANCHORS_PER_HOUR })
}

/// Check a fill against the offer the way the fold will. Returns `(fill, you pay)` in base units.
pub fn validate_take(offer: &Offer, fill_text: &str) -> Result<(u64, u64), String> {
    if offer.remaining < offer.min_fill {
        return Err("What's left of this offer is below its minimum fill; it can't be taken.".into());
    }
    let sym = offer.give.chain.symbol();
    let fill = format::parse_coin(fill_text).map_err(|e| e.message().to_owned())?;
    if fill < offer.min_fill {
        return Err(format!("At least {} {sym} (the offer's minimum fill).", format::coin(offer.min_fill)));
    }
    if fill > offer.remaining {
        return Err(format!("At most {} {sym} (what's left of the offer).", format::coin(offer.remaining)));
    }
    let pay = format::pro_rata(fill, offer.give.amount, offer.want.amount);
    if fill < offer.give.chain.dust() || pay < offer.want.chain.dust() {
        return Err("Too small: one side of the swap would be below the dust limit.".into());
    }
    Ok((fill, pay))
}

fn price_lines(give: Chain, give_amount: u64, want: Chain, want_amount: u64) -> (String, String) {
    let one_give = format::ratio(want_amount, give_amount).unwrap_or_else(|| "—".into());
    let one_want = format::ratio(give_amount, want_amount).unwrap_or_else(|| "—".into());
    (format!("1 {} = {one_give} {}", give.symbol(), want.symbol()), format!("1 {} = {one_want} {}", want.symbol(), give.symbol()))
}

impl GavlApp {
    pub fn render_market(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex()
            .gap_8()
            .children(self.render_open_swaps_callout(cx))
            .child(self.render_board(cx))
            .child(self.render_new_offer(cx))
            .child(self.render_my_offers(cx));
        page(
            "page-market",
            "Market",
            "Swap BTC and LTC directly with other people. No custody: each side locks coins on its own chain and either both receive or both get refunded.",
            body,
            cx,
        )
    }

    fn render_open_swaps_callout(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let open = self.open_swaps();
        (open > 0).then(|| {
            card(cx)
                .child(
                    h_flex()
                        .gap_3()
                        .items_center()
                        .child(div().flex_1().text_sm().child(format!(
                            "You have {open} swap{} in progress. Keep this daemon running until {} finished.",
                            if open == 1 { "" } else { "s" },
                            if open == 1 { "it has" } else { "they have" }
                        )))
                        .child(Button::new("go-swaps").small().label("View swaps").on_click(cx.listener(|this, _, _, cx| {
                            this.page = Page::Swaps;
                            cx.notify();
                        }))),
                )
                .into_any_element()
        })
    }

    /// The board, or a plain explanation of why it can't be shown.
    fn board_state(&self, cx: &App) -> Result<&OffersPage, AnyElement> {
        match &self.offers {
            Feed::Ready(page) => Ok(page),
            Feed::Loading => Err(muted("Loading the order board…", cx).into_any_element()),
            Feed::Missing => Err(muted("This daemon doesn't serve an order board. Update Gavl and restart the daemon.", cx).into_any_element()),
            Feed::Failed(err) => Err(Alert::warning("offers-error", format!("Couldn't load the order board: {err}")).into_any_element()),
        }
    }

    fn render_board(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let filter = self.market.filter;
        let filters = ButtonGroup::new("market-filter")
            .small()
            .outline()
            .children(Filter::ALL.map(|f| Button::new(SharedString::from(f.label())).label(f.label()).selected(filter == f)))
            .on_click(cx.listener(|this, clicked: &Vec<usize>, _, cx| {
                if let Some(f) = clicked.first().and_then(|ix| Filter::ALL.get(*ix)) {
                    this.market.filter = *f;
                    cx.notify();
                }
            }));

        let (description, list) = match self.board_state(cx) {
            Err(state) => (None, state),
            Ok(board) => {
                let height = board.height;
                let offers: Vec<Offer> = board.offers.iter().filter(|o| filter.keeps(o)).cloned().collect();
                let description = Some(match height {
                    Some(h) => format!("As of block {}. Prices are set by each maker; Gavl has no price feed.", format::int(h as u128)),
                    None => "Prices are set by each maker; Gavl has no price feed.".to_owned(),
                });
                let list = if offers.is_empty() {
                    let empty = if board.offers.is_empty() { "No offers yet. Post the first one below." } else { "No offers in this direction." };
                    muted(empty, cx).into_any_element()
                } else {
                    let header = h_flex()
                        .gap_4()
                        .pb_2()
                        .border_b_1()
                        .border_color(cx.theme().border)
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(div().w(px(150.)).child("You get"))
                        .child(div().w(px(150.)).child("You pay"))
                        .child(div().flex_1().child("Price"))
                        .child(div().w(px(150.)).child("Available"))
                        .child(div().w(px(64.)).child("Expires"))
                        .child(div().w(px(72.)));
                    let rows: Vec<AnyElement> = offers.iter().map(|o| self.render_offer_row(o, height, cx)).collect();
                    v_flex().child(header).children(rows).into_any_element()
                };
                (description, list)
            }
        };
        let body = v_flex().gap_3().child(filters).child(list);
        section("Order board", description.as_deref(), body, cx)
    }

    fn expires_label(&self, offer: &Offer, height: Option<u64>) -> String {
        match height {
            Some(h) => self.anchors_span(offer.expires_at.saturating_sub(h)),
            None => "—".into(),
        }
    }

    fn render_offer_row(&self, offer: &Offer, height: Option<u64>, cx: &mut Context<Self>) -> AnyElement {
        let (give, want) = (offer.give.chain, offer.want.chain);
        let (p1, p2) = price_lines(give, offer.give.amount, want, offer.want.amount);
        let open = self.market.taking.as_deref() == Some(offer.id.as_str());
        let mine = self.is_mine(&offer.maker);
        let action = if mine {
            Tag::secondary().small().child("Yours").into_any_element()
        } else {
            let id = offer.id.clone();
            let start = format::coin_input(offer.remaining);
            Button::new(SharedString::from(format!("take-{}", offer.id)))
                .small()
                .when(!open, |b| b.primary())
                .label(if open { "Close" } else { "Take" })
                .on_click(cx.listener(move |this, _, window, cx| {
                    if this.market.taking.as_deref() == Some(id.as_str()) {
                        this.market.taking = None;
                    } else {
                        this.market.taking = Some(id.clone());
                        let start = start.clone();
                        this.market.fill.update(cx, |s, cx| s.set_value(start, window, cx));
                    }
                    cx.notify();
                }))
                .into_any_element()
        };
        let amount = |units: u64, chain: Chain| {
            div().font_family(cx.theme().mono_font_family.clone()).text_sm().child(format!("{} {}", format::coin(units), chain.symbol()))
        };
        let row = h_flex()
            .gap_4()
            .py_2()
            .items_center()
            .child(div().w(px(150.)).child(amount(offer.give.amount, give)))
            .child(div().w(px(150.)).child(amount(offer.want.amount, want)))
            .child(v_flex().flex_1().min_w_0().text_xs().child(p1).child(div().text_color(cx.theme().muted_foreground).child(p2)))
            .child(
                v_flex()
                    .w(px(150.))
                    .child(amount(offer.remaining, give))
                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(format!("min {}", format::coin(offer.min_fill)))),
            )
            .child(div().w(px(64.)).text_sm().child(self.expires_label(offer, height)))
            .child(h_flex().w(px(72.)).justify_end().child(action));
        v_flex()
            .id(SharedString::from(format!("offer-{}", offer.id)))
            .border_b_1()
            .border_color(cx.theme().border)
            .child(row)
            .when(open, |this| this.child(self.render_take_panel(offer, cx)))
            .into_any_element()
    }

    fn render_take_panel(&self, offer: &Offer, cx: &mut Context<Self>) -> Div {
        let (get, pay_chain) = (offer.give.chain, offer.want.chain);
        let text = self.market.fill.read(cx).value();
        let check = validate_take(offer, &text);
        let busy = self.busy.contains(&Busy::Take);
        let balance = self.wallet(pay_chain).map(|w| w.confirmed);

        let set = |id: &str, label: &str, units: u64, cx: &mut Context<Self>| {
            let value = format::coin_input(units);
            Button::new(SharedString::from(format!("{id}-{}", offer.id))).ghost().small().label(label.to_owned()).on_click(cx.listener(
                move |this, _, window, cx| {
                    let value = value.clone();
                    this.market.fill.update(cx, |s, cx| s.set_value(value, window, cx));
                },
            ))
        };

        let summary = match &check {
            Ok((fill, pay)) => {
                let short = balance.is_some_and(|b| b < *pay);
                v_flex()
                    .gap_1()
                    .child(div().text_sm().child(format!(
                        "You pay {} {} and receive {} {}.",
                        format::coin(*pay),
                        pay_chain.symbol(),
                        format::coin(*fill),
                        get.symbol()
                    )))
                    .when(short, |this| {
                        this.child(problem(
                            format!("Your {} wallet holds {} {} confirmed — not enough to lock.", pay_chain.name(), format::coin(balance.unwrap_or(0)), pay_chain.symbol()),
                            cx,
                        ))
                    })
            }
            Err(msg) => v_flex().child(problem(msg.clone(), cx)),
        };

        let confirm = {
            let id = offer.id.clone();
            let fill = check.as_ref().ok().map(|(f, _)| *f);
            Button::new(SharedString::from(format!("confirm-take-{}", offer.id)))
                .primary()
                .small()
                .label("Take offer")
                .loading(busy)
                .disabled(fill.is_none() || busy)
                .on_click(cx.listener(move |this, _, window, cx| {
                    let Some(fill) = fill else { return };
                    let id = id.clone();
                    this.run(Busy::Take, window, cx, move |c| c.take(&id, fill), |this, _, _, _| {
                        this.market.taking = None;
                        Some("Offer taken. Follow the swap on the Swaps page.".into())
                    });
                }))
        };

        v_flex()
            .gap_3()
            .mb_3()
            .p_3()
            .rounded(cx.theme().radius)
            .bg(cx.theme().muted)
            .child(
                h_flex()
                    .gap_2()
                    .items_end()
                    .child(field(&format!("Amount of {} to take", get.symbol()), Input::new(&self.market.fill).w(px(200.)).suffix(get.symbol()), cx))
                    .child(set("min", "Min", offer.min_fill, cx))
                    .child(set("max", "All", offer.remaining, cx)),
            )
            .child(summary)
            .child(muted(
                format!(
                    "Taking posts to the board (this identity's write cooldown can take a minute). You then lock your {} first; if the other side never locks, it refunds to you automatically after 24h.",
                    pay_chain.symbol()
                ),
                cx,
            ))
            .child(h_flex().gap_2().child(confirm))
    }

    fn render_new_offer(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let form = &self.market;
        let (give, want) = (form.give, form.give.other());
        let check = validate_offer(
            give,
            &form.give_amount.read(cx).value(),
            &form.want_amount.read(cx).value(),
            &form.min_fill.read(cx).value(),
            &form.expiry_hours.read(cx).value(),
        );
        let busy = self.busy.contains(&Busy::PostOffer);
        let balance = self.wallet(give).map(|w| w.confirmed);

        let chain_picker = ButtonGroup::new("offer-give")
            .small()
            .outline()
            .children(Chain::ALL.map(|c| Button::new(SharedString::from(format!("give-{}", c.symbol()))).label(c.symbol()).selected(give == c)))
            .on_click(cx.listener(|this, clicked: &Vec<usize>, _, cx| {
                if let Some(c) = clicked.first().and_then(|ix| Chain::ALL.get(*ix)) {
                    this.market.give = *c;
                    cx.notify();
                }
            }));

        let empty = form.give_amount.read(cx).value().trim().is_empty() && form.want_amount.read(cx).value().trim().is_empty();
        let feedback = match &check {
            Ok(o) => {
                let (p1, p2) = price_lines(give, o.give_amount, want, o.want_amount);
                let short = balance.is_some_and(|b| b < o.give_amount);
                v_flex()
                    .gap_1()
                    .child(div().text_sm().child(format!("Price: {p1} · {p2}")))
                    .when(o.min_fill < o.give_amount, |this| {
                        this.child(muted(
                            format!(
                                "Takers can fill from {} {} up to the whole amount.",
                                format::coin(o.min_fill),
                                give.symbol()
                            ),
                            cx,
                        ))
                    })
                    .when(short, |this| {
                        this.child(problem(
                            format!("Your {} wallet holds {} {} confirmed; a taker could not be matched with funds you don't have.", give.name(), format::coin(balance.unwrap_or(0)), give.symbol()),
                            cx,
                        ))
                    })
            }
            Err(_) if empty => v_flex(),
            Err(msg) => v_flex().child(problem(msg.clone(), cx)),
        };

        let submit = {
            let offer = check.ok();
            Button::new("post-offer")
                .primary()
                .label("Post offer")
                .loading(busy)
                .disabled(offer.is_none() || busy)
                .on_click(cx.listener(move |this, _, window, cx| {
                    let Some(o) = offer.as_ref() else { return };
                    let (give, ga, wa, min, ttl) = (o.give, o.give_amount, o.want_amount, o.min_fill, o.expires_in);
                    this.run(Busy::PostOffer, window, cx, move |c| c.post_offer(give, ga, wa, min, ttl), |this, _, window, cx| {
                        for input in [&this.market.give_amount, &this.market.want_amount, &this.market.min_fill] {
                            input.update(cx, |s, cx| s.set_value("", window, cx));
                        }
                        Some("Offer posted. It appears on the board once the next block includes it.".into())
                    });
                }))
        };

        let balance_hint = balance.map(|b| format!("Available: {} {}", format::coin(b), give.symbol()));
        let body = card(cx).child(
            v_flex()
                .gap_4()
                .child(
                    h_flex()
                        .gap_4()
                        .items_end()
                        .flex_wrap()
                        .child(field("You give", chain_picker, cx))
                        .child(field(&format!("Amount of {}", give.symbol()), Input::new(&form.give_amount).w(px(200.)).suffix(give.symbol()), cx))
                        .child(field(&format!("For {}", want.symbol()), Input::new(&form.want_amount).w(px(200.)).suffix(want.symbol()), cx)),
                )
                .child(
                    h_flex()
                        .gap_4()
                        .items_end()
                        .flex_wrap()
                        .child(field(&format!("Minimum fill ({})", give.symbol()), Input::new(&form.min_fill).w(px(200.)).suffix(give.symbol()), cx))
                        .child(field("Expires in", Input::new(&form.expiry_hours).w(px(120.)).suffix("hours"), cx))
                        .children(balance_hint.map(|h| muted(h, cx).pb_1p5())),
                )
                .child(feedback)
                .child(muted(
                    format!(
                        "When someone takes it, they lock their {} first; then Gavl locks your {}. If they don't claim in time, your {} refunds automatically after 12h.",
                        want.symbol(),
                        give.symbol(),
                        give.symbol()
                    ),
                    cx,
                ))
                .child(h_flex().child(submit)),
        );
        section("New offer", Some("Posting pays this identity's write cooldown, which can take a minute."), body, cx)
    }

    fn render_my_offers(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let height = self.offers.ready().and_then(|b| b.height);
        let mine: Vec<Offer> = self.offers.ready().map(|b| b.offers.iter().filter(|o| self.is_mine(&o.maker)).cloned().collect()).unwrap_or_default();
        let active = self.active_key().to_owned();
        let cancelling = self.busy.contains(&Busy::Cancel);
        let rows = mine.iter().map(|o| {
            let (give, want) = (o.give.chain, o.want.chain);
            let own = o.maker == active;
            let id = o.id.clone();
            let cancel = Button::new(SharedString::from(format!("cancel-{}", o.id)))
                .small()
                .label("Cancel")
                .disabled(!own || cancelling)
                .loading(cancelling)
                .when(!own, |b| b.tooltip(format!("Posted by {}. Switch to it on the Node page to cancel.", self.account_label(&o.maker))))
                .on_click(cx.listener(move |this, _, window, cx| {
                    let id = id.clone();
                    this.run(Busy::Cancel, window, cx, move |c| c.cancel(&id), |_, _, _, _| {
                        Some("Cancel posted. Swaps already in progress continue.".into())
                    });
                }));
            h_flex()
                .id(SharedString::from(format!("my-offer-{}", o.id)))
                .gap_4()
                .py_2()
                .items_center()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(
                    div().flex_1().min_w_0().text_sm().child(format!(
                        "{} {} for {} {}",
                        format::coin(o.give.amount),
                        give.symbol(),
                        format::coin(o.want.amount),
                        want.symbol()
                    )),
                )
                .child(div().w(px(200.)).text_sm().child(format!("{} {} left", format::coin(o.remaining), give.symbol())))
                .child(div().w(px(90.)).text_sm().text_color(cx.theme().muted_foreground).child(format!("{} left", self.expires_label(o, height))))
                .child(cancel)
        });
        let body = if mine.is_empty() {
            muted(if self.offers.ready().is_some() { "You have no listed offers." } else { "—" }, cx).into_any_element()
        } else {
            v_flex().children(rows).into_any_element()
        };
        section("My offers", Some("Cancelling delists the rest of an offer; swaps already taken continue."), body, cx)
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob exports a `test` attribute that would shadow the std one.
    use super::{NewOffer, validate_offer, validate_take};
    use crate::api::{Chain, Leg, Offer};

    fn offer() -> Offer {
        // 0.01 BTC for 1.2 LTC, fills of at least 0.002 BTC, 0.006 BTC left.
        Offer {
            id: "o".into(),
            maker: "m".into(),
            give: Leg { chain: Chain::Bitcoin, amount: 1_000_000 },
            want: Leg { chain: Chain::Litecoin, amount: 120_000_000 },
            min_fill: 200_000,
            remaining: 600_000,
            expires_at: 0,
        }
    }

    #[test]
    fn take_checks_bounds_exactly() {
        let o = offer();
        assert_eq!(validate_take(&o, "0.006"), Ok((600_000, 72_000_000)));
        assert_eq!(validate_take(&o, "0.002"), Ok((200_000, 24_000_000)));
        assert!(validate_take(&o, "0.00199999").is_err());
        assert!(validate_take(&o, "0.00600001").is_err());
        assert!(validate_take(&o, "").is_err());
        let stuck = Offer { remaining: 100_000, ..offer() };
        assert!(validate_take(&stuck, "0.001").is_err());
    }

    #[test]
    fn offer_form_defaults_and_limits() {
        let o = validate_offer(Chain::Bitcoin, "0.01", "1.2", "", "24").unwrap();
        assert_eq!(o, NewOffer { give: Chain::Bitcoin, give_amount: 1_000_000, want_amount: 120_000_000, min_fill: 1_000_000, expires_in: 1440 });
        assert_eq!(validate_offer(Chain::Litecoin, "1.2", "0.01", "0.5", "48").unwrap().min_fill, 50_000_000);
        assert!(validate_offer(Chain::Bitcoin, "0.01", "1.2", "0.02", "24").is_err());
        assert!(validate_offer(Chain::Bitcoin, "0.01", "1.2", "", "49").is_err());
        assert!(validate_offer(Chain::Bitcoin, "0.01", "1.2", "", "0").is_err());
        assert!(validate_offer(Chain::Bitcoin, "0.00000329", "1", "", "24").is_err());
        // 100 sats is under BTC's 330-sat dust floor.
        assert!(validate_offer(Chain::Bitcoin, "0.01", "1.2", "0.000001", "24").is_err());
        // A 0.0001 LTC fill at 0.001 BTC per LTC pays 10 sats: the BTC leg is dust.
        assert!(validate_offer(Chain::Litecoin, "1", "0.001", "0.0001", "24").is_err());
    }
}
