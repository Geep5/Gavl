//! Wallet: balance and its idle clock, which account is active, deposit, withdraw.

use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable,
    alert::Alert,
    button::{Button, ButtonVariants},
    input::Input,
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::component::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, copyable, mono, muted, page, section, stat};
use crate::api;
use crate::app::{Busy, GavlApp};
use crate::format;

/// Blocks per demurrage day (1 block ≈ 60 s).
const BLOCKS_PER_DAY: u64 = 1_440;
/// Bitcoin's dust limit: a payout below this can't be broadcast.
const DUST_SATS: u128 = 546;
/// UI guardrail on the miner fee; the protocol itself doesn't cap it.
const MAX_FEE_SATS: u128 = 50_000;

impl GavlApp {
    pub fn render_wallet(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex()
            .gap_8()
            .child(self.render_balance(cx))
            .child(self.render_accounts(cx))
            .child(self.render_deposit(cx))
            .child(self.render_withdraw(cx));
        page("page-wallet", "Wallet", "gBTC is a 1:1 claim on testnet BTC held by the custody committee.", body, cx)
    }

    fn render_balance(&self, cx: &App) -> impl IntoElement + use<> {
        let balance = self.balance();
        let fee_in = self
            .snapshot
            .bridge
            .as_ref()
            .and_then(|m| m.idle_decay.as_ref())
            .filter(|_| balance > 0)
            .map(|d| d.fee_from_height.saturating_sub(self.height()));
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .gap_10()
                    .child(stat("Balance", format::gbtc(balance), cx))
                    .when_some(fee_in, |this, blocks| {
                        if blocks == 0 {
                            this.child(stat("Idle fee", "1% per 30 days", cx))
                        } else {
                            this.child(stat("Idle fee starts in", idle_left(blocks), cx))
                        }
                    }),
            )
            .child(match fee_in {
                Some(0) => muted(
                    "This balance has been idle for over 7 days, so it pays a small idle fee (1% per 30 days) to the shared pot. Receiving gBTC resets the clock.",
                    cx,
                )
                .into_any_element(),
                Some(blocks) if blocks < BLOCKS_PER_DAY => Alert::info(
                    "idle-soon",
                    format!("In {} your idle balance starts paying a small idle fee (1% per 30 days) to the shared pot.", idle_left(blocks)),
                )
                .into_any_element(),
                _ => muted("Gavl isn't a savings account: after 7 idle days a balance pays a small idle fee (1% per 30 days) to the shared pot.", cx).into_any_element(),
            })
    }

    fn render_accounts(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let active = self.snapshot.active.clone().unwrap_or_default();
        let switching = self.busy.contains(&Busy::SwitchAccount);
        let rows = self.snapshot.accounts.clone().into_iter().map(|account| {
            let is_active = account.pub_hex == active;
            let key = account.pub_hex.clone();
            h_flex()
                .gap_4()
                .py_2()
                .items_center()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().w(px(120.)).font_medium().child(account.label.clone()))
                .child(mono(format::short_hex(&account.pub_hex), cx).flex_1().text_color(cx.theme().muted_foreground))
                .child(if is_active {
                    Tag::secondary().small().child("Active").into_any_element()
                } else {
                    Button::new(SharedString::from(format!("use-{}", account.pub_hex)))
                        .small()
                        .label("Use")
                        .disabled(switching)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let key = key.clone();
                            this.run(Busy::SwitchAccount, window, cx, move |client| client.set_active(&key), |_, _| None);
                        }))
                        .into_any_element()
                })
        });
        section("Accounts", Some("Transfers, deposits and withdrawals use the active account."), v_flex().children(rows), cx)
    }

    fn render_deposit(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let bridge = self.snapshot.bridge.clone().unwrap_or_default();
        let Some(address) = bridge.deposit_address.clone() else {
            return section(
                "Deposit",
                None,
                Alert::info(
                    "custody-forming",
                    format!(
                        "Deposits open once a custody committee of {} nodes has formed and published the fund key.",
                        self.min_committee()
                    ),
                ),
                cx,
            )
            .into_any_element();
        };
        let txid = self.deposit_txid.read(cx).value().trim().to_string();
        let txid_ok = txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit());
        let claiming = self.busy.contains(&Busy::Claim);
        let network = if bridge.btc_network.is_empty() { "testnet".to_string() } else { bridge.btc_network.clone() };

        let body = card(cx).child(
            v_flex()
                .gap_4()
                .child(
                    v_flex()
                        .gap_1()
                        .child(h_flex().gap_2().items_center().child(div().text_sm().font_medium().child("Your deposit address")).child(Tag::secondary().small().child(network)))
                        .child(copyable("copy-deposit", &address, cx)),
                )
                .child(
                    v_flex()
                        .gap_2()
                        .child(div().text_sm().font_medium().child("Claim a deposit"))
                        .child(
                            h_flex()
                                .gap_2()
                                .child(Input::new(&self.deposit_txid).flex_1())
                                .child(
                                    Button::new("claim")
                                        .primary()
                                        .label("Claim")
                                        .disabled(!txid_ok)
                                        .loading(claiming)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            let txid = this.deposit_txid.read(cx).value().trim().to_string();
                                            this.claim_result = Some("Checking the transaction on-chain…".into());
                                            this.run(Busy::Claim, window, cx, move |client| client.claim_deposit(&txid), |this, v| {
                                                let credited = v.get("credited").and_then(|c| c.as_str()).map(api::amount).unwrap_or(0);
                                                this.claim_result = Some(if credited > 0 {
                                                    format!("Credited {}.", format::gbtc(credited))
                                                } else {
                                                    "No confirmed payment to your deposit address in that transaction yet.".into()
                                                });
                                                (credited > 0).then(|| format!("Credited {}", format::gbtc(credited)))
                                            });
                                        })),
                                ),
                        )
                        .child(muted(
                            self.claim_result.clone().unwrap_or_else(|| {
                                if !txid.is_empty() && !txid_ok {
                                    format!("A transaction id is 64 hex characters; this one has {}.", txid.len())
                                } else {
                                    "Send BTC to the address above, then paste the transaction id. gBTC is credited 1:1 once it confirms.".into()
                                }
                            }),
                            cx,
                        )),
                ),
        );
        section("Deposit", None, body, cx).into_any_element()
    }

    fn render_withdraw(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let bridge = self.snapshot.bridge.clone().unwrap_or_default();
        if bridge.deposit_address.is_none() {
            return div().into_any_element();
        }
        let custody = self.snapshot.custody.clone().unwrap_or_default();
        let balance = self.balance();
        let amount_text = self.withdraw_amount.read(cx).value().trim().to_string();
        let address = self.withdraw_address.read(cx).value().trim().to_string();
        let fee_text = self.withdraw_fee.read(cx).value().trim().to_string();
        let amount = amount_text.parse::<u128>().ok();
        let fee = fee_text.parse::<u128>().ok();

        let max_fee = amount.map_or(0, |a| a.saturating_sub(DUST_SATS).min(MAX_FEE_SATS));
        let problem: Option<String> = match (amount, fee) {
            _ if amount_text.is_empty() => None,
            (None, _) | (Some(0), _) => Some("Enter a whole-number amount.".into()),
            (Some(a), _) if a > balance => Some(format!("You only have {}.", format::gbtc(balance))),
            (_, None) => Some("Enter the miner fee in sats.".into()),
            (Some(a), Some(f)) if a < f + DUST_SATS => Some(format!("After the fee, the payout must be at least {DUST_SATS} sats.")),
            (_, Some(f)) if f > max_fee => Some(format!("The fee can be at most {} sats for this amount.", format::int(max_fee))),
            _ => None,
        };
        let ready = problem.is_none() && amount.is_some_and(|a| a > 0) && fee.is_some() && !address.is_empty();
        let summary = match (problem, amount, fee) {
            (Some(p), _, _) => p,
            (None, Some(a), Some(f)) if a > 0 => format!("You receive {} sats; the {} sat miner fee comes out of your payout.", format::int(a - f), format::int(f)),
            _ => format!(
                "Burns gBTC; {} of the {} committee members sign a Bitcoin transaction to your address.",
                custody.threshold.max(1),
                custody.committee.len().max(self.min_committee() as usize)
            ),
        };
        let withdrawing = self.busy.contains(&Busy::Withdraw);
        let processing = self.busy.contains(&Busy::ProcessPayouts);

        let field = |label: &str, input: AnyElement| v_flex().gap_1().child(div().text_sm().font_medium().child(label.to_owned())).child(input);
        let body = card(cx).child(
            v_flex()
                .gap_4()
                .child(
                    h_flex()
                        .gap_3()
                        .child(field("Amount (gBTC)", Input::new(&self.withdraw_amount).into_any_element()).w(px(180.)))
                        .child(field("Bitcoin address", Input::new(&self.withdraw_address).into_any_element()).flex_1())
                        .child(field("Miner fee (sats)", Input::new(&self.withdraw_fee).into_any_element()).w(px(150.))),
                )
                .child(
                    h_flex()
                        .gap_3()
                        .items_center()
                        .justify_between()
                        .child(muted(summary, cx).flex_1())
                        .child(
                            Button::new("withdraw")
                                .primary()
                                .label("Withdraw")
                                .disabled(!ready)
                                .loading(withdrawing)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let amount = this.withdraw_amount.read(cx).value().trim().parse::<u128>().unwrap_or(0);
                                    let fee = this.withdraw_fee.read(cx).value().trim().parse::<u128>().unwrap_or(0);
                                    let address = this.withdraw_address.read(cx).value().trim().to_string();
                                    this.run(Busy::Withdraw, window, cx, move |client| client.withdraw(amount, &address, fee), move |_, _| {
                                        Some(format!("Withdrawal of {} queued", format::gbtc(amount)))
                                    });
                                    this.withdraw_amount.update(cx, |state, cx| state.set_value("", window, cx));
                                })),
                        ),
                )
                .when(bridge.pending_count > 0, |this| {
                    this.child(
                        h_flex()
                            .gap_3()
                            .items_center()
                            .justify_between()
                            .pt_3()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .child(muted(
                                format!(
                                    "{} withdrawal{} ({}) waiting for the committee to sign and broadcast.",
                                    bridge.pending_count,
                                    if bridge.pending_count == 1 { "" } else { "s" },
                                    format::gbtc(api::amount(&bridge.pending))
                                ),
                                cx,
                            ))
                            .child(
                                Button::new("process-payouts")
                                    .label("Broadcast payouts")
                                    .loading(processing)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.run(Busy::ProcessPayouts, window, cx, |client| client.process_withdrawals(), |_, v| {
                                            v.get("txid").and_then(|t| t.as_str()).map(|t| format!("Broadcast {}", format::short_hex(t)))
                                        });
                                    })),
                            ),
                    )
                }),
        );
        section("Withdraw", None, body, cx).into_any_element()
    }
}

fn idle_left(blocks: u64) -> String {
    if blocks >= BLOCKS_PER_DAY {
        format!("{} days", blocks / BLOCKS_PER_DAY)
    } else {
        format!("{} hours", (blocks * 24).div_ceil(BLOCKS_PER_DAY).max(1))
    }
}
