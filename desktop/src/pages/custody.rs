//! Custody: who holds the BTC, and proof that every gBTC is backed.

use gpui_kit::component::{ActiveTheme, Sizable, alert::Alert, progress::Progress, tag::Tag, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, copyable, mono, muted, page, row, section, stat};
use crate::api;
use crate::app::GavlApp;
use crate::format;

impl GavlApp {
    pub fn render_custody(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex().gap_8().child(self.render_committee(cx)).child(self.render_reserves(cx));
        page(
            "page-custody",
            "Custody",
            "No single machine holds the Bitcoin key. A threshold of committee members must co-sign every payout.",
            body,
            cx,
        )
    }

    fn render_committee(&self, cx: &App) -> impl IntoElement + use<> {
        let custody = self.snapshot.custody.clone().unwrap_or_default();
        let formed = custody.fund_key_on_chain.is_some() && !custody.committee.is_empty();
        let fund = custody.fund_address.clone().or_else(|| self.snapshot.market.as_ref().and_then(|m| m.fund_address.clone()));
        let my_bond = api::amount(&custody.my_bond);

        if !formed {
            return section(
                "Committee",
                None,
                Alert::info(
                    "committee-forming",
                    format!(
                        "Forming: {} nodes must run together to create the shared fund key. Until then nothing can be deposited.",
                        custody.min_committee.max(3)
                    ),
                ),
                cx,
            )
            .into_any_element();
        }

        let seats = custody.committee.iter().enumerate().map(|(i, id)| {
            let mine = custody.committee_id.as_deref() == Some(id.as_str());
            h_flex()
                .gap_3()
                .py_2()
                .items_center()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().w(px(72.)).text_sm().text_color(cx.theme().muted_foreground).child(format!("Seat {}", i + 1)))
                .child(mono(format::short_hex(id), cx).flex_1())
                .when(mine, |this| this.child(Tag::secondary().small().child("This node")))
        });

        let body = card(cx).child(
            v_flex()
                .gap_4()
                .child(
                    h_flex()
                        .gap_8()
                        .child(stat("Signing rule", format!("{} of {}", custody.threshold, custody.committee.len()), cx))
                        .child(stat("Epoch", if custody.epoch < 0 { "Genesis".into() } else { custody.epoch.to_string() }, cx))
                        .child(stat("This node", if custody.holds_share { "Holds a key share" } else { "Not a signer" }, cx))
                        .child(stat("Your bond", format::gbtc(my_bond), cx)),
                )
                .child(v_flex().children(seats))
                .when_some(fund, |this, fund| this.child(row("Fund address", copyable("copy-fund", &fund, cx), cx))),
        );
        section("Committee", None, body, cx).into_any_element()
    }

    fn render_reserves(&self, cx: &App) -> impl IntoElement + use<> {
        let Some(m) = self.snapshot.market.clone() else {
            return section("Reserves", None, muted("Unavailable while the daemon is offline.", cx), cx).into_any_element();
        };
        let reserves = api::amount(&m.reserves);
        let buckets = [
            ("Free balances", api::amount(&m.free), cx.theme().chart_1),
            ("Bonded by signers", api::amount(&m.bonded), cx.theme().chart_2),
            ("Staked in rounds", api::amount(&m.rounds_escrow), cx.theme().chart_3),
            ("Pending withdrawals", api::amount(&m.pending), cx.theme().chart_4),
            ("Shared pot", api::amount(&m.pot), cx.theme().chart_5),
        ];
        let sum: u128 = buckets.iter().map(|b| b.1).sum();
        let balanced = sum == reserves;
        let on_chain = m.on_chain_reserves.as_deref().map(api::amount);

        let bars = buckets.iter().enumerate().map(|(i, (label, value, color))| {
            let share = if reserves == 0 { 0.0 } else { *value as f32 / reserves as f32 * 100.0 };
            h_flex()
                .gap_4()
                .items_center()
                .py_1p5()
                .child(div().w(px(180.)).text_sm().child(*label))
                .child(div().flex_1().child(Progress::new(("bucket", i)).value(share).color(*color)))
                .child(div().w(px(160.)).text_sm().text_right().child(format::gbtc(*value)))
        });

        let checks = v_flex()
            .gap_1()
            .child(muted(
                if balanced {
                    "Balanced: the five buckets add up exactly to reserves.".to_string()
                } else {
                    format!("Out of balance by {} — report this.", format::gbtc(sum.abs_diff(reserves)))
                },
                cx,
            ))
            .when_some(on_chain, |this, chain| {
                let text = match m.reconciled {
                    Some(true) => format!("Matches the {} held on-chain by the fund.", format::gbtc(chain)),
                    _ => format!(
                        "On-chain fund holds {}; shortfall {}.",
                        format::gbtc(chain),
                        format::gbtc(m.shortfall.as_deref().map_or(0, api::amount))
                    ),
                };
                this.child(muted(text, cx))
            });

        let body = card(cx).child(
            v_flex()
                .gap_3()
                .child(stat("Reserves", format::gbtc(reserves), cx))
                .child(v_flex().children(bars))
                .child(checks),
        );
        section("Reserves", Some("Every gBTC sits in exactly one of these buckets."), body, cx).into_any_element()
    }
}
