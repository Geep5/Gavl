//! One module per sidebar destination, plus the small layout vocabulary they share.

pub mod market;
mod network;
mod node;
mod swaps;
pub mod wallet;

use gpui_kit::component::{
    ActiveTheme, Icon, IconName, StyledExt, WindowExt, clipboard::Clipboard, h_flex,
    input::{InputEvent, InputState},
    scroll::ScrollableElement,
    v_flex,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::app::GavlApp;

/// Scrolling page body with a title and one-line purpose.
pub fn page(id: &'static str, title: &str, subtitle: &str, body: impl IntoElement, cx: &App) -> AnyElement {
    div().id(id).size_full().overflow_y_scrollbar().child(
        v_flex()
            .w_full()
            .max_w(px(960.))
            .px_8()
            .py_6()
            .gap_6()
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_2xl().font_semibold().child(title.to_owned()))
                    .child(div().text_sm().text_color(cx.theme().muted_foreground).child(subtitle.to_owned())),
            )
            .child(body),
    )
    .into_any_element()
}

/// A titled region. Description only when it changes a decision.
pub fn section(title: &str, description: Option<&str>, body: impl IntoElement, cx: &App) -> Div {
    v_flex()
        .gap_3()
        .child(
            v_flex()
                .gap_0p5()
                .child(div().text_base().font_semibold().child(title.to_owned()))
                .when_some(description, |this, d| {
                    this.child(div().text_sm().text_color(cx.theme().muted_foreground).child(d.to_owned()))
                }),
        )
        .child(body)
}

/// Bordered surface for a primary region. Never nest one inside another.
pub fn card(cx: &App) -> Div {
    div()
        .w_full()
        .p_4()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
}

/// Label over a value; used in stat rows.
pub fn stat(label: &str, value: impl Into<SharedString>, cx: &App) -> Div {
    v_flex()
        .gap_0p5()
        .min_w(px(120.))
        .child(div().text_xs().text_color(cx.theme().muted_foreground).child(label.to_owned()))
        .child(div().text_lg().font_semibold().child(value.into()))
}

pub fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div().text_sm().text_color(cx.theme().muted_foreground).child(text.into())
}

pub fn mono(text: impl Into<SharedString>, cx: &App) -> Div {
    div().font_family(cx.theme().mono_font_family.clone()).text_sm().child(text.into())
}

/// A key/address shown in full with a copy button; it wraps instead of truncating.
pub fn copyable(id: impl Into<ElementId>, value: &str, cx: &App) -> Div {
    h_flex()
        .gap_2()
        .items_center()
        .child(mono(value.to_owned(), cx).min_w_0())
        .child(
            Clipboard::new(id)
                .value(value.to_owned())
                .tooltip("Copy")
                .on_copied(|_, window, cx| window.push_notification("Copied", cx)),
        )
}

/// Label column + value column row.
pub fn row(label: &str, value: impl IntoElement, cx: &App) -> Div {
    h_flex()
        .w_full()
        .gap_4()
        .items_start()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(div().w(px(180.)).flex_shrink_0().text_sm().text_color(cx.theme().muted_foreground).child(label.to_owned()))
        .child(div().flex_1().min_w_0().child(value))
}

/// A single-line input whose edits re-render the app (forms validate live).
pub fn text_input(
    placeholder: &str,
    default: &str,
    window: &mut Window,
    cx: &mut Context<GavlApp>,
    subscriptions: &mut Vec<Subscription>,
) -> Entity<InputState> {
    let (placeholder, default) = (placeholder.to_owned(), default.to_owned());
    let state = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(default));
    subscriptions.push(cx.subscribe(&state, |_, _, _: &InputEvent, cx| cx.notify()));
    state
}

/// Small label above a form control.
pub fn field(label: &str, control: impl IntoElement, cx: &App) -> Div {
    v_flex()
        .gap_1()
        .child(div().text_xs().font_medium().text_color(cx.theme().muted_foreground).child(label.to_owned()))
        .child(control)
}

/// Inline validation / warning line under a form.
pub fn problem(text: impl Into<SharedString>, cx: &App) -> Div {
    div().text_sm().text_color(cx.theme().danger).child(text.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Done,
    Active,
    Pending,
    /// The path turned (refund): attention, not failure.
    Warn,
    Failed,
}

/// Horizontal progress stepper: numbered dots joined by rules.
pub fn stepper(steps: &[(String, Step)], cx: &App) -> Div {
    let theme = cx.theme();
    let mut row = h_flex().w_full().gap_2().items_center();
    for (i, (label, step)) in steps.iter().enumerate() {
        if i > 0 {
            let reached = matches!(step, Step::Done | Step::Active | Step::Warn | Step::Failed);
            row = row.child(div().h(px(1.)).flex_1().min_w(px(12.)).bg(if reached { theme.foreground.opacity(0.4) } else { theme.border }));
        }
        let (bg, fg, border) = match step {
            Step::Done => (theme.success, theme.success_foreground, theme.success),
            Step::Active => (theme.primary, theme.primary_foreground, theme.primary),
            Step::Pending => (theme.background, theme.muted_foreground, theme.border),
            Step::Warn => (theme.warning, theme.warning_foreground, theme.warning),
            Step::Failed => (theme.danger, theme.danger_foreground, theme.danger),
        };
        let mark = match step {
            Step::Done => Icon::new(IconName::Check).size_3().into_any_element(),
            Step::Failed => Icon::new(IconName::Close).size_3().into_any_element(),
            Step::Warn => div().child("!").into_any_element(),
            _ => div().child((i + 1).to_string()).into_any_element(),
        };
        let dot = div()
            .size(px(20.))
            .flex_shrink_0()
            .rounded_full()
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_color(fg)
            .text_xs()
            .font_semibold()
            .flex()
            .items_center()
            .justify_center()
            .child(mark);
        let text = div()
            .text_sm()
            .when(*step == Step::Pending, |d| d.text_color(theme.muted_foreground))
            .when(*step != Step::Pending, |d| d.font_medium())
            .child(label.clone());
        row = row.child(h_flex().flex_shrink_0().gap_1p5().items_center().child(dot).child(text));
    }
    row
}
