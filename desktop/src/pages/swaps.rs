//! Swaps: every match this daemon's identities are part of, with where it stands, what happens
//! next, and what happens if the other side walks away.

use gpui_kit::component::{Sizable, StyledExt, alert::Alert, button::Button, tag::Tag, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{Step, card, copyable, muted, page, row, section, stepper};
use crate::api::{Lock, Role, Stage, Swap};
use crate::app::{Feed, GavlApp, Page};
use crate::format;

/// The maker locks within about an hour of the taker (proof window + taker lock window).
const MAKER_LOCK_HINT: &str = "~1h";

fn stage_tag(stage: Stage) -> Tag {
    let (tag, text) = match stage {
        Stage::Proofs => (Tag::info(), "Proving funds"),
        Stage::WaitingTakerLock | Stage::WaitingMakerLock => (Tag::info(), "Waiting for lock"),
        Stage::Claiming => (Tag::info(), "Claiming"),
        Stage::WaitingCounterClaim => (Tag::info(), "Waiting for claim"),
        Stage::RefundPending => (Tag::warning(), "Refund pending"),
        Stage::Refunded => (Tag::secondary(), "Refunded"),
        Stage::Done => (Tag::success(), "Complete"),
        Stage::Cancelled => (Tag::secondary(), "Cancelled"),
        Stage::Failed => (Tag::danger(), "Failed"),
        Stage::Unknown => (Tag::secondary(), "Unknown"),
    };
    tag.outline().small().child(text)
}

/// The happy path for this role, in order.
fn path(s: &Swap) -> Vec<String> {
    let (my, their) = (s.my_chain.symbol(), s.their_chain.symbol());
    match s.role {
        Role::Taker => vec![
            "Proof of funds".into(),
            format!("You lock {my}"),
            format!("They lock {their}"),
            format!("You claim {their}"),
        ],
        Role::Maker => vec![
            "Proof of funds".into(),
            format!("They lock {their}"),
            format!("You lock {my}"),
            format!("They claim {my}"),
            format!("You claim {their}"),
        ],
    }
}

/// Steps completed on the happy path, judged from the locks (for terminal stages).
fn locks_reached(s: &Swap) -> usize {
    let (taker_lock, maker_lock) = match s.role {
        Role::Taker => (s.my_lock.is_some(), s.their_lock.is_some()),
        Role::Maker => (s.their_lock.is_some(), s.my_lock.is_some()),
    };
    if maker_lock {
        3
    } else if taker_lock {
        2
    } else {
        0
    }
}

/// The stepper rows for a swap; `None` when the stage is unknown to this build.
fn steps(s: &Swap) -> Option<Vec<(String, Step)>> {
    let labels = path(s);
    let mark = |done: usize| -> Vec<(String, Step)> {
        labels
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let step = match i.cmp(&done) {
                    std::cmp::Ordering::Less => Step::Done,
                    std::cmp::Ordering::Equal => Step::Active,
                    std::cmp::Ordering::Greater => Step::Pending,
                };
                (l.clone(), step)
            })
            .collect()
    };
    let completed_then = |done: usize, last: String, step: Step| -> Vec<(String, Step)> {
        let mut out: Vec<(String, Step)> = labels.iter().take(done).map(|l| (l.clone(), Step::Done)).collect();
        out.push((last, step));
        out
    };
    let my = s.my_chain.symbol();
    Some(match (s.stage, s.role) {
        (Stage::Proofs, _) => mark(0),
        (Stage::WaitingTakerLock, _) => mark(1),
        (Stage::WaitingMakerLock, _) => mark(2),
        (Stage::Claiming, Role::Taker) => mark(3),
        (Stage::WaitingCounterClaim, Role::Taker) | (Stage::Done, Role::Taker) => mark(4),
        (Stage::WaitingCounterClaim, Role::Maker) => mark(3),
        (Stage::Claiming, Role::Maker) => mark(4),
        (Stage::Done, Role::Maker) => mark(5),
        // Refunds only exist once my coins are locked: show the path up to my lock, then the refund.
        (Stage::RefundPending, _) => completed_then(my_lock_steps(s), format!("Refund {my}"), Step::Warn),
        (Stage::Refunded, _) => completed_then(my_lock_steps(s), format!("{my} refunded"), Step::Done),
        (Stage::Cancelled, _) => completed_then(locks_reached(s), "Cancelled".into(), Step::Failed),
        (Stage::Failed, _) => completed_then(locks_reached(s), "Failed".into(), Step::Failed),
        (Stage::Unknown, _) => return None,
    })
}

/// Happy-path steps up to and including my own lock.
fn my_lock_steps(s: &Swap) -> usize {
    match s.role {
        Role::Taker => 2,
        Role::Maker => 3,
    }
}

impl GavlApp {
    pub fn render_swaps(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = match &self.swaps {
            Feed::Loading => muted("Loading swaps…", cx).into_any_element(),
            Feed::Missing => card(cx)
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().font_medium().child("The swap engine isn't running on this daemon."))
                        .child(muted("Once it is, swaps from offers you take — and from takes of your offers — appear here and run on their own.", cx)),
                )
                .into_any_element(),
            Feed::Failed(err) => Alert::warning("swaps-error", format!("Couldn't load swaps: {err}")).into_any_element(),
            Feed::Ready(swaps) if swaps.is_empty() => card(cx)
                .child(
                    v_flex()
                        .gap_3()
                        .items_start()
                        .child(muted("No swaps yet. Take an offer on the Market page, or post your own.", cx))
                        .child(Button::new("swaps-go-market").small().label("Open Market").on_click(cx.listener(|this, _, _, cx| {
                            this.page = Page::Market;
                            cx.notify();
                        }))),
                )
                .into_any_element(),
            Feed::Ready(swaps) => {
                let (open, finished): (Vec<&Swap>, Vec<&Swap>) = swaps.iter().partition(|s| !s.stage.is_final());
                let open_cards: Vec<AnyElement> = open.iter().map(|s| self.render_swap(s, cx)).collect();
                let finished_cards: Vec<AnyElement> = finished.iter().map(|s| self.render_swap(s, cx)).collect();
                v_flex()
                    .gap_8()
                    .child(section(
                        "In progress",
                        Some("Gavl drives each step on its own. Keep the daemon running until these finish."),
                        if open_cards.is_empty() { muted("Nothing in progress.", cx).into_any_element() } else { v_flex().gap_4().children(open_cards).into_any_element() },
                        cx,
                    ))
                    .when(!finished_cards.is_empty(), |this| this.child(section("Finished", None, v_flex().gap_4().children(finished_cards), cx)))
                    .into_any_element()
            }
        };
        page("page-swaps", "Swaps", "Atomic swaps settle on Bitcoin and Litecoin directly: either both sides receive, or both get their coins back.", body, cx)
    }

    fn render_swap(&self, s: &Swap, cx: &App) -> AnyElement {
        let (my, their) = (s.my_chain.symbol(), s.their_chain.symbol());
        let title = format!("{} {my} → {} {their}", format::coin(s.my_amount), format::coin(s.their_amount));
        let role = match s.role {
            Role::Taker => "You took an offer",
            Role::Maker => "Your offer was taken",
        };
        let who = s
            .identity
            .as_deref()
            .filter(|_| self.snapshot.accounts.len() > 1)
            .map(|id| format!(" · as {}", self.account_label(id)))
            .unwrap_or_default();

        let header = h_flex()
            .gap_3()
            .items_center()
            .child(div().text_base().font_semibold().child(title))
            .child(stage_tag(s.stage))
            .child(div().flex_1())
            .child(muted(format!("{role}{who}"), cx));

        let mut details = v_flex();
        if let Some(lock) = &s.my_lock {
            details = details.child(row(&format!("Your {my} lock"), self.lock_cell(&format!("my-lock-{}", s.match_id), lock, cx), cx));
        }
        if let Some(lock) = &s.their_lock {
            details = details.child(row(&format!("Their {their} lock"), self.lock_cell(&format!("their-lock-{}", s.match_id), lock, cx), cx));
        }
        if let Some(txid) = &s.claim_txid {
            details = details.child(row(&format!("Your {their} claim"), copyable(SharedString::from(format!("claim-{}", s.match_id)), txid, cx), cx));
        }
        if let Some(txid) = &s.refund_txid {
            details = details.child(row(&format!("Your {my} refund"), copyable(SharedString::from(format!("refund-{}", s.match_id)), txid, cx), cx));
        }
        if let Some(d) = s.deadline.as_ref().filter(|_| !s.stage.is_final()) {
            let left = if d.anchors_left > 0 {
                format!("~{} left ({} block{})", self.anchors_span(d.anchors_left as u64), d.anchors_left, if d.anchors_left == 1 { "" } else { "s" })
            } else {
                "Due now".into()
            };
            details = details.child(row(&format!("Deadline · {}", format::humanize(&d.kind)), div().text_sm().child(left), cx));
        }
        if let (Some(n), Stage::RefundPending) = (s.refund_available_in_blocks, s.stage) {
            let text = if n > 0 {
                format!("In {n} {} block{} (~{})", s.my_chain.name(), if n == 1 { "" } else { "s" }, format::span(n as u64 * s.my_chain.block_seconds()))
            } else {
                "Now — broadcasting".into()
            };
            details = details.child(row("Refund available", div().text_sm().child(text), cx));
        }
        details = details.child(row("Match", copyable(SharedString::from(format!("match-{}", s.match_id)), &s.match_id, cx), cx));

        card(cx)
            .child(
                v_flex()
                    .gap_4()
                    .child(header)
                    .children(steps(s).map(|st| stepper(&st, cx)))
                    .child(
                        v_flex()
                            .gap_1()
                            .child(div().text_sm().child(self.swap_note(s)))
                            .when_some(s.note.clone().filter(|n| !n.is_empty()), |this, n| this.child(muted(n, cx))),
                    )
                    .child(details),
            )
            .into_any_element()
    }

    fn lock_cell(&self, id: &str, lock: &Lock, cx: &App) -> Div {
        let confirmations = match lock.confirmations {
            0 => "Unconfirmed".to_owned(),
            1 => "1 confirmation".to_owned(),
            n => format!("{n} confirmations"),
        };
        v_flex()
            .gap_0p5()
            .child(copyable(SharedString::from(id.to_owned()), &lock.txid, cx))
            .child(muted(format!("Output {} · {confirmations}", lock.vout), cx))
    }

    /// What is happening and what happens if the other side walks away, in plain words.
    fn swap_note(&self, s: &Swap) -> String {
        let (my, their) = (s.my_chain.symbol(), s.their_chain.symbol());
        let my_amt = format!("{} {my}", format::coin(s.my_amount));
        let their_amt = format!("{} {their}", format::coin(s.their_amount));
        let within = s
            .deadline
            .as_ref()
            .filter(|d| d.anchors_left > 0)
            .map(|d| format!(" within ~{}", self.anchors_span(d.anchors_left as u64)))
            .unwrap_or_default();
        let refund_after = s.role.refund_hours();
        match (s.stage, s.role) {
            (Stage::Proofs, Role::Taker) => format!(
                "Both sides are proving they hold the coins. Nothing is locked yet. If either side doesn't prove it{within}, the match cancels and nothing changes hands."
            ),
            (Stage::Proofs, Role::Maker) => format!(
                "Both sides are proving they hold the coins. Nothing is locked yet. If either side doesn't prove it{within}, the match cancels and your offer is listed again."
            ),
            (Stage::WaitingTakerLock, Role::Taker) => format!(
                "Gavl is locking your {my_amt} in the swap contract. It must be recorded{within}, or the match cancels."
            ),
            (Stage::WaitingTakerLock, Role::Maker) => format!(
                "Waiting for the other side to lock their {their}. If they don't{within}, the match cancels and your offer is listed again. None of your {my} is locked yet."
            ),
            (Stage::WaitingMakerLock, Role::Taker) => format!(
                "Your {my} is locked. Waiting for the other side to lock their {their}. If they don't within {MAKER_LOCK_HINT}, your {my} refunds automatically after {refund_after}h."
            ),
            (Stage::WaitingMakerLock, Role::Maker) => format!(
                "Their {their} is locked. Gavl is locking your {my_amt} now. Once both are locked the swap can only complete or refund."
            ),
            (Stage::Claiming, Role::Taker) => format!(
                "Both sides are locked. Gavl is claiming your {their_amt}; that reveals the secret the other side needs to claim your {my}."
            ),
            (Stage::Claiming, Role::Maker) => format!(
                "The other side claimed your {my}, revealing the secret. Gavl is claiming your {their_amt} now."
            ),
            (Stage::WaitingCounterClaim, Role::Taker) => format!(
                "You claimed {their_amt}. The other side now claims your {my} with the revealed secret; nothing left for you to do."
            ),
            (Stage::WaitingCounterClaim, Role::Maker) => format!(
                "Your {my} is locked. Waiting for the other side to claim it, which reveals the secret Gavl uses to claim your {their}. If they never claim, your {my} refunds automatically after {refund_after}h."
            ),
            (Stage::RefundPending, _) => {
                let when = match s.refund_available_in_blocks {
                    Some(n) if n > 0 => format!(
                        "becomes refundable in {n} {} block{} (~{})",
                        s.my_chain.name(),
                        if n == 1 { "" } else { "s" },
                        format::span(n as u64 * s.my_chain.block_seconds())
                    ),
                    Some(_) => "is refundable now".into(),
                    None => format!("becomes refundable {refund_after}h after it was locked"),
                };
                format!("The swap didn't complete. Your {my_amt} {when}; Gavl broadcasts the refund automatically. Keep the daemon running.")
            }
            (Stage::Refunded, _) => format!("The swap didn't complete. Your {my_amt} was refunded (less network fees)."),
            (Stage::Done, _) => format!("Swap complete. You received {their_amt}."),
            (Stage::Cancelled, _) if s.my_lock.is_none() => "Cancelled before any of your coins were locked. Nothing to do.".into(),
            (Stage::Cancelled, _) => "Cancelled.".into(),
            (Stage::Failed, _) => "Gavl couldn't finish this swap automatically.".into(),
            (Stage::Unknown, _) => "In progress.".into(),
        }
    }
}
