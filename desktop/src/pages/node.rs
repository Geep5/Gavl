//! Node: this machine's identities and settings, plus extra local nodes.

use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable,
    button::Button,
    tag::Tag,
    h_flex, v_flex,
};
use gpui_kit::component::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use super::{copyable, mono, muted, page, row, section};
use crate::app::{Busy, GavlApp};
use crate::format;
use crate::status;

impl GavlApp {
    pub fn render_node(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let body = v_flex().gap_8().child(self.render_identity(cx)).child(self.render_accounts(cx)).child(self.render_fleet(cx));
        page("page-node", "Node", "The keys and settings of the daemon this window is connected to.", body, cx)
    }

    fn render_identity(&self, cx: &App) -> impl IntoElement + use<> {
        let consensus = self.snapshot.consensus.clone().unwrap_or_default();
        let active = self.snapshot.active.clone().unwrap_or_default();
        let transport = match consensus.transport.as_deref() {
            Some("nostr") => match (consensus.relays_up, consensus.relays_total) {
                (Some(up), Some(total)) => format!("Nostr ({up} of {total} relays)"),
                _ => "Nostr".into(),
            },
            Some(other) => other.to_string(),
            None => "Local only".into(),
        };
        let body = v_flex()
            .child(row("Daemon", mono(self.client.base().to_owned(), cx), cx))
            .child(row("Account key", copyable("copy-account", &active, cx), cx))
            .when_some(consensus.node_key.clone(), |this, key| {
                this.child(row("Node address", copyable("copy-node", &key, cx), cx))
            })
            .child(row("Network", copyable("copy-channel", &consensus.network, cx), cx))
            .child(row("Proofs", div().text_sm().child(status::proof_mode(&consensus)), cx))
            .child(row("Transport", div().text_sm().child(transport), cx));
        section("Identity", Some("Share the node address with other computers so they can pin this node."), body, cx)
    }

    fn render_fleet(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let fleet = self.snapshot.fleet.clone().unwrap_or_default();
        let (adding, removing) = (self.busy.contains(&Busy::FleetUp), self.busy.contains(&Busy::FleetDown));

        let controls = h_flex()
            .gap_2()
            .items_center()
            .child(
                Button::new("fleet-down")
                    .small()
                    .label("Stop one")
                    .disabled(fleet.count == 0 || removing)
                    .loading(removing)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.run(Busy::FleetDown, window, cx, |client| client.fleet_down(), |_, _| Some("Stopped a local node".into()));
                    })),
            )
            .child(
                Button::new("fleet-up")
                    .small()
                    .label("Start one")
                    .disabled(fleet.count >= fleet.cap.max(1) || adding)
                    .loading(adding)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.run(Busy::FleetUp, window, cx, |client| client.fleet_up(), |_, _| Some("Started a local node".into()));
                    })),
            )
            .child(muted(format!("{} of {} running", fleet.count, fleet.cap), cx));

        let nodes = fleet.nodes.iter().map(|n| {
            let state = n.state.clone().unwrap_or_default();
            let tag = if state.producing {
                Tag::success().small().child("Producing")
            } else if state.farming {
                Tag::info().small().child("Farming")
            } else {
                Tag::secondary().small().child("Starting")
            };
            h_flex()
                .id(SharedString::from(format!("fleet-{}", n.name)))
                .gap_4()
                .py_2()
                .items_center()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().w(px(110.)).font_medium().child(n.name.clone()))
                .child(div().w(px(110.)).text_sm().text_color(cx.theme().muted_foreground).child(format!("port {}", n.port)))
                .child(
                    div()
                        .flex_1()
                        .text_sm()
                        .child(format!("block {} · {} peer{} · up {}", state.tip.unwrap_or(0), state.peers, status::plural(state.peers), format::ago(n.up_sec))),
                )
                .child(tag)
        });

        let body = v_flex()
            .gap_3()
            .child(controls)
            .child(if fleet.nodes.is_empty() {
                muted("Each local node gets its own identity, plot and data directory. They use real disk and CPU.", cx).into_any_element()
            } else {
                v_flex().children(nodes).into_any_element()
            });
        section("Local nodes", Some("Extra independent farmers on this machine, for testing a multi-node network."), body, cx)
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
        section("Accounts", Some("Orders and swaps use the active account."), v_flex().children(rows), cx)
    }
}
