//! One module per sidebar destination, plus the small layout vocabulary they share.

mod custody;
mod network;
mod node;
mod rounds;
mod wallet;

use gpui_kit::component::{ActiveTheme, StyledExt, WindowExt, clipboard::Clipboard, h_flex, scroll::ScrollableElement, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

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
    copyable_as(id, value, value, cx)
}

/// Like [`copyable`], but shows `display` while copying the full `value`.
pub fn copyable_as(id: impl Into<ElementId>, display: &str, value: &str, cx: &App) -> Div {
    h_flex()
        .gap_2()
        .items_center()
        .child(mono(display.to_owned(), cx).min_w_0())
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
