//! Rounds: the bull/bear decision. Price → the open round (pick a side, set a stake) → the live
//! round → recent results.

use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, StyledExt,
    alert::Alert,
    button::{Button, ButtonCustomVariant, ButtonGroup, ButtonVariants},
    input::Input,
    progress::Progress,
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::component::Selectable;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, muted, page, section, stat};
use crate::api::{self, Round, RoundResult, Side};
use crate::app::{Busy, GavlApp, Page};
use crate::format;

const PRESETS: [u128; 3] = [1_000, 10_000, 100_000];

impl GavlApp {
    pub fn render_rounds(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let rounds = self.snapshot.market.as_ref().and_then(|m| m.rounds.clone());
        let mut body = v_flex().gap_8().child(self.render_price(cx));
        match &rounds {
            None => body = body.child(muted("Round data appears once the daemon is reachable.", cx)),
            Some(r) => {
                body = body.child(self.render_open_round(r, cx));
                if let Some(live) = r.live.as_ref().filter(|l| l.entries > 0 || l.strike.is_some()) {
                    body = body.child(self.render_live_round(live, cx));
                }
                body = body.child(self.render_results(&r.history, cx));
            }
        }
        page(
            "page-rounds",
            "Rounds",
            "Call where the price goes over the next round. Winners split the entire losing pool; there's no house and no fee.",
            body,
            cx,
        )
    }

    fn render_price(&self, cx: &App) -> impl IntoElement + use<> {
        let (caret, color) = match self.price_direction() {
            1 => (Some(gpui_kit::assets::IconName::TrendingUp), cx.theme().chart_bullish),
            -1 => (Some(gpui_kit::assets::IconName::TrendingDown), cx.theme().chart_bearish),
            _ => (None, cx.theme().foreground),
        };
        h_flex()
            .justify_between()
            .items_end()
            .child(
                v_flex()
                    .gap_1()
                    .child(muted(self.market_label().replace('-', " / "), cx))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().text_3xl().font_semibold().child(self.price_text().unwrap_or_else(|| "No price yet".into())))
                            .when_some(caret, |this, icon| this.child(Icon::new(icon).text_color(color))),
                    ),
            )
            .child(stat("Your balance", format::gbtc(self.balance()), cx))
    }

    fn render_open_round(&mut self, rounds: &api::Rounds, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let Some(round) = rounds.entering.clone() else {
            return card(cx).child(muted("No round is open yet — the first one opens with the first block.", cx)).into_any_element();
        };
        let balance = self.balance();
        let min_stake = api::amount(&rounds.min_stake).max(1);
        let stake_text = self.stake.read(cx).value().to_string();
        let stake = stake_text.trim().parse::<u128>().ok();
        let my_side = round.my_side.as_deref().and_then(Side::from_wire);
        let (up, down) = (api::amount(&round.pool_up), api::amount(&round.pool_down));

        // Why entering is blocked, in the order a user can fix it.
        let blocked: Option<String> = if !rounds.entry_open {
            Some(format!("Entries for round #{} are closed. The next round opens in {}.", round.idx, format::clock(self.secs_until(round.locks_at))))
        } else if balance == 0 {
            Some("You have no gBTC. Deposit in Wallet to enter.".into())
        } else {
            match stake {
                None | Some(0) => Some("Enter a whole-number stake.".into()),
                Some(s) if s > balance => Some(format!("You only have {}.", format::gbtc(balance))),
                Some(s) if my_side.is_none() && s < min_stake => Some(format!("The minimum first entry is {}.", format::gbtc(min_stake))),
                _ => None,
            }
        };
        let can_enter = blocked.is_none();

        let side_button = |side: Side, cx: &mut Context<Self>| {
            let (mine, other, color, title, hint, icon) = match side {
                Side::Up => (up, down, cx.theme().chart_bullish, "Bull", "Price ends higher", gpui_kit::assets::IconName::TrendingUp),
                Side::Down => (down, up, cx.theme().chart_bearish, "Bear", "Price ends lower", gpui_kit::assets::IconName::TrendingDown),
            };
            let pays = match format::payout_multiple(mine, other) {
                Some(x) => format!("Pays {x:.2}×"),
                None => "First in sets the odds".into(),
            };
            let locked_out = my_side.is_some_and(|s| s != side);
            let variant = ButtonCustomVariant::new(cx)
                .color(color)
                .foreground(cx.theme().background)
                .hover(color.opacity(0.9))
                .active(color.opacity(0.8));
            Button::new(match side {
                Side::Up => "enter-bull",
                Side::Down => "enter-bear",
            })
            .custom(variant)
            .large()
            .flex_1()
            .h(px(112.))
            .disabled(!can_enter || locked_out)
            .loading(self.busy.contains(&Busy::Enter(side)))
            .tooltip(if locked_out { "You're on the other side this round" } else { hint })
            .child(
                v_flex()
                    .items_center()
                    .gap_1()
                    .child(h_flex().gap_2().items_center().child(Icon::new(icon)).child(div().text_xl().font_semibold().child(title)))
                    .child(div().text_sm().child(pays))
                    .child(div().text_xs().opacity(0.85).child(format!("{} in pool", format::gbtc(mine)))),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                let Some(stake) = this.stake.read(cx).value().trim().parse::<u128>().ok() else { return };
                let idx = Some(round.idx);
                this.run(
                    Busy::Enter(side),
                    window,
                    cx,
                    move |client| client.enter_round(side, stake, idx),
                    move |_, _| Some(format!("Entered {} with {}", title, format::gbtc(stake))),
                );
            }))
        };
        let bull = side_button(Side::Up, cx);
        let bear = side_button(Side::Down, cx);

        let countdown = if rounds.entry_open {
            format!("Entries close in {}", format::clock(self.secs_until(round.locks_at.saturating_sub(1))))
        } else {
            "Entries closed".into()
        };

        let stake_row = h_flex()
            .gap_3()
            .items_center()
            .child(div().text_sm().font_medium().child("Stake"))
            .child(Input::new(&self.stake).w(px(160.)).suffix(div().text_xs().text_color(cx.theme().muted_foreground).child("gBTC")))
            .child(
                ButtonGroup::new("stake-presets")
                    .small()
                    .outline()
                    .children(PRESETS.map(|p| {
                        Button::new(SharedString::from(format!("preset-{p}")))
                            .label(if p >= 1000 { format!("{}k", p / 1000) } else { p.to_string() })
                            .selected(stake == Some(p))
                    }))
                    .child(Button::new("preset-max").label("Max").selected(stake == Some(balance) && balance > 0).disabled(balance == 0))
                    .on_click(cx.listener(move |this, clicked: &Vec<usize>, window, cx| {
                        let Some(&ix) = clicked.first() else { return };
                        let value = PRESETS.get(ix).copied().unwrap_or(balance);
                        this.stake.update(cx, |state, cx| state.set_value(value.to_string(), window, cx));
                    })),
            );

        card(cx)
            .child(
                v_flex()
                    .gap_4()
                    .child(
                        h_flex()
                            .justify_between()
                            .items_center()
                            .child(div().text_lg().font_semibold().child(format!("Round #{}", round.idx)))
                            .child(Tag::secondary().child(countdown)),
                    )
                    .child(h_flex().gap_3().child(bull).child(bear))
                    .child(stake_row)
                    .when_some(blocked.filter(|_| rounds.entry_open), |this, reason| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(muted(reason, cx))
                                .when(balance == 0, |this| {
                                    this.child(
                                        Button::new("go-wallet").small().label("Open Wallet").on_click(cx.listener(|this, _, _, cx| {
                                            this.page = Page::Wallet;
                                            cx.notify();
                                        })),
                                    )
                                }),
                        )
                    })
                    .when_some(my_side, |this, side| {
                        this.child(Alert::info(
                            "my-entry",
                            format!(
                                "You're {} with {}. Another entry tops up the same side.",
                                if side == Side::Up { "Bull" } else { "Bear" },
                                format::gbtc(api::amount(&round.my_stake))
                            ),
                        ))
                    }),
            )
            .into_any_element()
    }

    fn render_live_round(&self, live: &Round, cx: &App) -> impl IntoElement + use<> {
        let (up, down) = (api::amount(&live.pool_up), api::amount(&live.pool_down));
        let total = up + down;
        let up_share = if total == 0 { 50.0 } else { up as f32 / total as f32 * 100.0 };
        let expo = self.snapshot.market.as_ref().map_or(0, |m| m.price_expo);
        let price = self.snapshot.market.as_ref().and_then(|m| m.price.clone());
        let leader = match (&live.strike, &price) {
            (Some(s), Some(p)) => Some(api::amount(p).cmp(&api::amount(s))),
            _ => None,
        };
        let leader_tag = match leader {
            Some(std::cmp::Ordering::Greater) => Tag::success().child("Bull leading"),
            Some(std::cmp::Ordering::Less) => Tag::danger().child("Bear leading"),
            Some(std::cmp::Ordering::Equal) => Tag::secondary().child("Even"),
            None => Tag::secondary().child("Waiting for strike price"),
        };
        let my_side = live.my_side.as_deref().and_then(Side::from_wire);

        section(
            &format!("Live · round #{}", live.idx),
            Some("Entries are locked. The round settles against the price at its close."),
            card(cx).child(
                v_flex()
                    .gap_4()
                    .child(
                        h_flex()
                            .gap_8()
                            .child(stat("Strike", live.strike.as_deref().and_then(|s| format::usd(s, expo)).unwrap_or_else(|| "—".into()), cx))
                            .child(stat("Now", self.price_text().unwrap_or_else(|| "—".into()), cx))
                            .child(stat("Settles in", format::clock(self.secs_until(live.closes_at)), cx))
                            .child(div().flex_1())
                            .child(leader_tag),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(Progress::new("live-split").value(up_share).color(cx.theme().chart_bullish))
                            .child(
                                h_flex()
                                    .justify_between()
                                    .child(div().text_sm().text_color(cx.theme().chart_bullish).child(format!("Bull {}", format::gbtc(up))))
                                    .child(div().text_sm().text_color(cx.theme().chart_bearish).child(format!("Bear {}", format::gbtc(down)))),
                            ),
                    )
                    .when_some(my_side, |this, side| {
                        this.child(muted(
                            format!(
                                "Your {} rides {}.",
                                format::gbtc(api::amount(&live.my_stake)),
                                if side == Side::Up { "Bull" } else { "Bear" }
                            ),
                            cx,
                        ))
                    }),
            ),
            cx,
        )
    }

    fn render_results(&self, history: &[RoundResult], cx: &App) -> impl IntoElement + use<> {
        let expo = self.snapshot.market.as_ref().map_or(0, |m| m.price_expo);
        let body = if history.is_empty() {
            muted("Settled rounds appear here.", cx).into_any_element()
        } else {
            v_flex()
                .children(history.iter().map(|h| {
                    let outcome = match h.outcome.as_str() {
                        "up" => Tag::success().small().child("Bull won"),
                        "down" => Tag::danger().small().child("Bear won"),
                        _ => Tag::secondary().small().child("Refunded"),
                    };
                    let prices = match (h.strike.as_deref(), h.close.as_deref()) {
                        (Some(s), Some(c)) => format!(
                            "{} → {}",
                            format::usd(s, expo).unwrap_or_default(),
                            format::usd(c, expo).unwrap_or_default()
                        ),
                        _ => String::new(),
                    };
                    let mine = match h.my_side.as_deref() {
                        None => String::new(),
                        Some(_) if h.outcome == "refund" => format!("Refunded {}", format::gbtc(api::amount(&h.my_stake))),
                        Some(side) if side == h.outcome => format!("You won {}", format::gbtc(api::amount(&h.my_payout))),
                        Some(_) => format!("You lost {}", format::gbtc(api::amount(&h.my_stake))),
                    };
                    h_flex()
                        .id(SharedString::from(format!("result-{}", h.idx)))
                        .gap_4()
                        .py_2()
                        .items_center()
                        .border_b_1()
                        .border_color(cx.theme().border)
                        .child(div().w(px(64.)).text_sm().text_color(cx.theme().muted_foreground).child(format!("#{}", h.idx)))
                        .child(div().w(px(110.)).child(outcome))
                        .child(div().flex_1().text_sm().child(prices))
                        .child(div().text_sm().font_medium().child(mine))
                }))
                .into_any_element()
        };
        section("Recent results", None, body, cx)
    }
}
