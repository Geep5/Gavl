//! Network: is this node in sync, who is it connected to, and what just happened.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::{
    ActiveTheme, Sizable,
    button::{Button, ButtonGroup},
    scroll::ScrollableElement,
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::component::{Selectable, StyledExt};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{card, copyable, muted, page, section, stat};
use crate::app::{Busy, GavlApp};
use crate::format;
use crate::status::{self, Health};

const GOSSIP_PRESETS: [(u32, &str); 3] = [(20, "20 s"), (60, "1 min"), (300, "5 min")];

impl GavlApp {
    pub fn render_network(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex()
            .gap_8()
            .child(self.render_sync(cx))
            .child(self.render_peers(cx))
            .child(self.render_activity(cx));
        page("page-network", "Network", "This node's view of the chain and the peers it syncs with over Nostr relays.", body, cx)
    }

    fn render_sync(&self, cx: &App) -> impl IntoElement + use<> {
        let summary = self.summary();
        let consensus = self.snapshot.consensus.clone().unwrap_or_default();
        let advice = match summary.health {
            Health::Offline => Some("Nothing below is current until the daemon is reachable."),
            Health::NoPeers => Some("Other computers must run the same command (same proof mode) with GAVL_NETWORK unset."),
            Health::Live if consensus.producers == 1 && consensus.peers > 0 && consensus.i_produce => Some(
                "So far every block came from this node. If that persists, compare the block number on each computer — a peer stuck behind is on its own chain.",
            ),
            _ => None,
        };
        let block_time = if consensus.sec_per_anchor_measured {
            format!("{:.0} s", consensus.sec_per_anchor)
        } else {
            "—".into()
        };
        card(cx).child(
            v_flex()
                .gap_4()
                .child(
                    h_flex()
                        .gap_3()
                        .items_center()
                        .child(Self::health_tag(summary.health).child(summary.title))
                        .child(muted(summary.detail, cx)),
                )
                .when_some(advice, |this, a| this.child(muted(a, cx)))
                .child(
                    h_flex()
                        .gap_8()
                        .flex_wrap()
                        .child(stat("Block", format::int(self.height() as u128), cx))
                        .child(stat("Finalized", format::int(consensus.finalized_height.unwrap_or(0) as u128), cx))
                        .child(stat("Producers", consensus.producers.to_string(), cx))
                        .child(stat("Blocks by this node", format::int(consensus.my_anchors as u128), cx))
                        .child(stat("Avg block time", block_time, cx))
                        .child(stat("Proofs", status::proof_mode(&consensus), cx)),
                ),
        )
    }

    fn render_peers(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let consensus = self.snapshot.consensus.clone().unwrap_or_default();
        let relays = match (consensus.relays_up, consensus.relays_total) {
            (Some(up), Some(total)) => format!("{up} of {total} relays reachable"),
            _ => "Relays unknown".into(),
        };
        let max = consensus.max_peers.map(|m| format!(" (max {m})")).unwrap_or_default();
        let description = format!("{} connected{max} · {relays}", consensus.peers);

        let peer_rows = consensus.peer_keys.iter().map(|key| {
            let pinned = consensus.pinned_peers.contains(key);
            h_flex()
                .gap_3()
                .py_2()
                .items_center()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().flex_1().min_w_0().child(copyable(SharedString::from(format!("copy-peer-{key}")), key, cx)))
                .when(pinned, |this| this.child(Tag::secondary().small().child("Pinned")))
        });
        let own = consensus.node_key.clone().map(|key| {
            v_flex()
                .gap_1()
                .pb_3()
                .child(div().text_sm().font_medium().child("This node"))
                .child(copyable("copy-own-key", &key, cx))
        });

        let current = consensus.gossip_interval_sec;
        let gossip = h_flex()
            .gap_3()
            .items_center()
            .pt_3()
            .child(div().text_sm().child("Re-announce presence every"))
            .child(
                ButtonGroup::new("gossip")
                    .small()
                    .outline()
                    .children(GOSSIP_PRESETS.map(|(secs, label)| {
                        Button::new(SharedString::from(format!("gossip-{secs}"))).label(label).selected(current == Some(secs))
                    }))
                    .on_click(cx.listener(|this, clicked: &Vec<usize>, window, cx| {
                        let Some(&(secs, _)) = clicked.first().and_then(|ix| GOSSIP_PRESETS.get(*ix)) else { return };
                        this.run(Busy::Gossip, window, cx, move |client| client.set_gossip_interval(secs), |_, _, _, _| None);
                    })),
            )
            .when_some(current.filter(|c| !GOSSIP_PRESETS.iter().any(|(s, _)| s == c)), |this, c| {
                this.child(muted(format!("currently {c} s"), cx))
            });

        let body = v_flex()
            .children(own)
            .child(div().text_sm().font_medium().child("Connected peers"))
            .child(if consensus.peer_keys.is_empty() {
                muted("None yet.", cx).into_any_element()
            } else {
                v_flex().children(peer_rows).into_any_element()
            })
            .child(gossip);
        section("Peers", Some(&description), body, cx)
    }

    fn render_activity(&self, cx: &App) -> impl IntoElement + use<> {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let rows = self.events.iter().rev().take(120).map(|e| {
            h_flex()
                .id(SharedString::from(format!("event-{}", e.seq)))
                .gap_3()
                .py_1()
                .items_start()
                .child(
                    div()
                        .w(px(44.))
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(format::ago(now_ms.saturating_sub(e.ts) / 1000)),
                )
                .child(div().w(px(96.)).flex_shrink_0().child(Tag::secondary().small().child(kind_label(&e.kind))))
                .child(div().flex_1().min_w_0().text_sm().child(e.text.clone()))
        });
        let body = if self.events.is_empty() {
            muted("Peer connections, new blocks and checkpoints appear here as they happen.", cx).into_any_element()
        } else {
            card(cx)
                .p_0()
                .child(v_flex().id("activity-log").h(px(320.)).px_4().py_2().overflow_y_scrollbar().children(rows))
                .into_any_element()
        };
        section("Activity", Some("Newest first."), body, cx)
    }
}

/// The daemon's event kinds are internal names; show what they mean.
fn kind_label(kind: &str) -> SharedString {
    match kind {
        "anchor" => "Block".into(),
        "peer" => "Peer".into(),
        "binding" => "Address".into(),
        "checkpoint" => "Checkpoint".into(),
        "replication" => "Replication".into(),
        "gossip" => "Gossip".into(),
        "net" => "Network".into(),
        "log" => "Log".into(),
        other => SharedString::from(other.to_owned()),
    }
}
