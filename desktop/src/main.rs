//! Gavl desktop: a native client for the local Gavl daemon, built on GPUI Kit (GPUI Fast engine).
//!
//! It is a client only. Every action goes through the daemon's HTTP API; set `GAVL_API` to point
//! at a daemon other than `http://127.0.0.1:6440`.

mod api;
mod app;
mod format;
mod pages;
mod status;

use std::borrow::Cow;

use gpui_kit::component::TitleBar;
use gpui_kit::*;

/// Default component icons, plus the few Lucide icons this app adds (see `assets/icons`).
struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let extra: Option<&'static [u8]> = match path {
            "icons/trending-up.svg" => Some(include_bytes!("../assets/icons/trending-up.svg")),
            "icons/trending-down.svg" => Some(include_bytes!("../assets/icons/trending-down.svg")),
            "icons/wallet.svg" => Some(include_bytes!("../assets/icons/wallet.svg")),
            "icons/shield-check.svg" => Some(include_bytes!("../assets/icons/shield-check.svg")),
            _ => None,
        };
        match extra {
            Some(bytes) => Ok(Some(Cow::Borrowed(bytes))),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}

fn main() {
    let base = std::env::var("GAVL_API").unwrap_or_else(|_| "http://127.0.0.1:6440".into());
    let client = api::Client::new(base.trim_end_matches('/'));

    gpui_kit::application().with_assets(Assets).run(move |cx| {
        gpui_kit::init(cx);
        let bounds = Bounds::centered(None, size(px(1180.), px(800.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(900.), px(600.))),
            ..TitleBar::window_options()
        };
        gpui_kit::open_window(options, cx, move |window, cx| cx.new(|cx| app::GavlApp::new(client, window, cx)))
            .expect("failed to open the Gavl window");
        cx.activate(true);
    });
}
