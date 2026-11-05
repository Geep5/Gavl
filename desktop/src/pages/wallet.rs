//! Wallet: the active identity's BTC and LTC hot wallets — where to deposit, what's there, and
//! sending coins out.

use gpui_kit::component::{
    Disableable, Selectable, Sizable, StyledExt,
    alert::Alert,
    button::{Button, ButtonGroup, ButtonVariants},
    input::{Input, InputState},
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, copyable, field, muted, page, problem, section, stat, text_input};
use crate::api::{Chain, Wallet};
use crate::app::{Busy, Feed, GavlApp};
use crate::format;

pub struct SendForm {
    chain: Chain,
    to: Entity<InputState>,
    amount: Entity<InputState>,
    fee_rate: Entity<InputState>,
    /// The last successful send, shown until the next one.
    last: Option<(Chain, String)>,
}

impl SendForm {
    pub fn new(window: &mut Window, cx: &mut Context<GavlApp>, subscriptions: &mut Vec<Subscription>) -> Self {
        Self {
            chain: Chain::Bitcoin,
            to: text_input("Address", "", window, cx, subscriptions),
            amount: text_input("0.001", "", window, cx, subscriptions),
            fee_rate: text_input("Automatic", "", window, cx, subscriptions),
            last: None,
        }
    }
}

/// A validated send: base units and an optional fee rate (sat/vB).
#[derive(Debug, PartialEq)]
pub struct SendRequest {
    pub to: String,
    pub amount: u64,
    pub fee_rate: Option<f64>,
}

pub fn validate_send(chain: Chain, to: &str, amount: &str, fee_rate: &str, spendable: Option<u64>) -> Result<SendRequest, String> {
    let to = to.trim();
    if to.is_empty() {
        return Err("Enter the address to send to.".into());
    }
    if to.chars().any(char::is_whitespace) {
        return Err("The address can't contain spaces.".into());
    }
    let amount = format::parse_coin(amount).map_err(|e| e.message().to_owned())?;
    if amount == 0 {
        return Err("Enter an amount above zero.".into());
    }
    if let Some(have) = spendable.filter(|have| amount > *have) {
        return Err(format!("More than this wallet's {} {} confirmed.", format::coin(have), chain.symbol()));
    }
    let fee_rate = match fee_rate.trim() {
        "" => None,
        text => match text.parse::<f64>() {
            Ok(rate) if rate.is_finite() && rate >= 1. && rate <= 10_000. => Some(rate),
            _ => return Err("Fee rate: a number of sat/vB from 1 to 10000, or leave it blank.".into()),
        },
    };
    Ok(SendRequest { to: to.to_owned(), amount, fee_rate })
}

impl GavlApp {
    pub fn render_wallet(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex().gap_8().child(self.render_balances(cx)).child(self.render_send(cx));
        page(
            "page-wallet",
            "Wallet",
            "This identity's Bitcoin and Litecoin hot wallets. Swaps lock from here and pay out to here.",
            body,
            cx,
        )
    }

    fn render_balances(&self, cx: &App) -> impl IntoElement + use<> {
        let body = match &self.wallets {
            Feed::Loading => muted("Loading balances…", cx).into_any_element(),
            Feed::Missing => card(cx)
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().font_medium().child("This daemon doesn't run wallets yet."))
                        .child(muted("Once the swap engine is running, your deposit addresses and balances appear here.", cx)),
                )
                .into_any_element(),
            Feed::Failed(err) => Alert::warning("wallets-error", format!("Couldn't load balances: {err}")).into_any_element(),
            Feed::Ready(wallets) if wallets.is_empty() => muted("No wallets.", cx).into_any_element(),
            Feed::Ready(wallets) => v_flex().gap_4().children(wallets.iter().map(|w| wallet_card(w, cx))).into_any_element(),
        };
        let account = self.active_label();
        section("Balances", Some(&format!("For {account}. Refreshed every 15 seconds.")), body, cx)
    }

    fn render_send(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let form = &self.send;
        let chain = form.chain;
        let wallet = self.wallet(chain);
        let check = validate_send(
            chain,
            &form.to.read(cx).value(),
            &form.amount.read(cx).value(),
            &form.fee_rate.read(cx).value(),
            wallet.map(|w| w.confirmed),
        );
        let busy = self.busy.contains(&Busy::Send);
        let available = self.wallets.ready().is_some();
        let untouched = form.to.read(cx).value().trim().is_empty() && form.amount.read(cx).value().trim().is_empty();

        let picker = ButtonGroup::new("send-chain")
            .small()
            .outline()
            .children(Chain::ALL.map(|c| Button::new(SharedString::from(format!("send-{}", c.symbol()))).label(c.symbol()).selected(chain == c)))
            .on_click(cx.listener(|this, clicked: &Vec<usize>, _, cx| {
                if let Some(c) = clicked.first().and_then(|ix| Chain::ALL.get(*ix)) {
                    this.send.chain = *c;
                    cx.notify();
                }
            }));

        let submit = {
            let request = check.as_ref().ok().map(|r| (r.to.clone(), r.amount, r.fee_rate));
            Button::new("send-submit")
                .primary()
                .label(format!("Send {}", chain.symbol()))
                .loading(busy)
                .disabled(request.is_none() || busy || !available)
                .on_click(cx.listener(move |this, _, window, cx| {
                    let Some((to, amount, fee_rate)) = request.clone() else { return };
                    this.run(Busy::Send, window, cx, move |c| c.send(chain, &to, amount, fee_rate), move |this, value, window, cx| {
                        let txid = value.get("txid").and_then(|t| t.as_str()).unwrap_or_default().to_owned();
                        this.send.last = (!txid.is_empty()).then(|| (chain, txid));
                        for input in [&this.send.to, &this.send.amount] {
                            input.update(cx, |s, cx| s.set_value("", window, cx));
                        }
                        this.wallets_at = None;
                        Some(format!("Sent {} {}", format::coin(amount), chain.symbol()))
                    });
                }))
        };

        let last = form.last.clone().map(|(c, txid)| {
            v_flex()
                .gap_1()
                .child(muted(format!("Last {} transaction", c.name()), cx))
                .child(copyable("send-last-txid", &txid, cx))
        });

        let body = card(cx).child(
            v_flex()
                .gap_4()
                .child(field("Coin", picker, cx))
                .child(field("To", Input::new(&form.to).w_full(), cx))
                .child(
                    h_flex()
                        .gap_4()
                        .items_end()
                        .flex_wrap()
                        .child(field("Amount", Input::new(&form.amount).w(px(220.)).suffix(chain.symbol()), cx))
                        .child(field("Fee rate (optional)", Input::new(&form.fee_rate).w(px(160.)).suffix("sat/vB"), cx))
                        .children(wallet.map(|w| muted(format!("Available: {} {}", format::coin(w.confirmed), chain.symbol()), cx).pb_1p5())),
                )
                .when_some(check.as_ref().err().filter(|_| !untouched), |this, msg| this.child(problem(msg.clone(), cx)))
                .child(muted("Sending is final. Check the address — and that it is for the right coin and network.", cx))
                .child(h_flex().child(submit))
                .children(last),
        );
        section("Send", None, body, cx)
    }
}

fn wallet_card(w: &Wallet, cx: &App) -> Div {
    let sym = w.chain.symbol();
    let pending = match w.unconfirmed {
        0 => "—".to_owned(),
        n if n > 0 => format!("+{} {sym}", format::coin_signed(n)),
        n => format!("{} {sym}", format::coin_signed(n)),
    };
    card(cx).child(
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().text_base().font_semibold().child(w.chain.name()))
                    .when(!w.net.is_empty() && w.net != "mainnet", |this| this.child(Tag::warning().outline().small().child(w.net.clone()))),
            )
            .when_some(w.error.clone(), |this, err| this.child(problem(format!("Explorer unreachable, balance unknown: {err}"), cx)))
            .child(
                h_flex()
                    .gap_8()
                    .child(stat("Confirmed", format!("{} {sym}", format::coin(w.confirmed)), cx))
                    .child(stat("Pending", pending, cx)),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(muted(format!("Deposit address ({sym} only)"), cx))
                    .child(copyable(SharedString::from(format!("address-{}", w.chain.symbol())), &w.address, cx)),
            ),
    )
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob exports a `test` attribute that would shadow the std one.
    use super::{SendRequest, validate_send};
    use crate::api::Chain;

    #[test]
    fn send_validation() {
        let ok = validate_send(Chain::Bitcoin, " bcrt1qxyz ", "0.5", "", Some(100_000_000)).unwrap();
        assert_eq!(ok, SendRequest { to: "bcrt1qxyz".into(), amount: 50_000_000, fee_rate: None });
        assert_eq!(validate_send(Chain::Bitcoin, "a", "0.1", "2.5", None).unwrap().fee_rate, Some(2.5));
        assert!(validate_send(Chain::Bitcoin, "", "0.1", "", None).is_err());
        assert!(validate_send(Chain::Bitcoin, "a", "0", "", None).is_err());
        assert!(validate_send(Chain::Bitcoin, "a", "1.00000001", "", Some(100_000_000)).is_err());
        assert!(validate_send(Chain::Bitcoin, "a", "0.1", "0.5", None).is_err());
        assert!(validate_send(Chain::Bitcoin, "a", "0.1", "fast", None).is_err());
    }
}
