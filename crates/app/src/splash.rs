//! Startup splash window.
//!
//! The main window is created hidden (`visible: false` in `tauri.conf.json`)
//! so a small frameless splash window can play a short boot animation, the way
//! a game shows its logo before the real window appears. The splash is released
//! by [`crate::commands::startup::app_ready`] once the main window has painted
//! its first frame, and it can never outlive a broken frontend.

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{App, AppHandle, Manager, Runtime};

pub const SPLASH_LABEL: &str = "splash";
pub const MAIN_LABEL: &str = "main";

/// Guaranteed on-screen time for the animation, even when the frontend boots
/// faster than the splash draws itself. Covers the ~1.4 s sequence plus a full
/// pass of the progress bar.
const MIN_VISIBLE: Duration = Duration::from_millis(2400);
/// Hard stop on the wait for the frontend. Past this point the main window is
/// revealed regardless, so a rendering failure never leaves the app windowless.
const READY_TIMEOUT: Duration = Duration::from_secs(8);

/// Single-shot latch between the `app_ready` command and the splash thread.
#[derive(Default)]
pub struct StartupGate(Mutex<Option<Sender<()>>>);

impl StartupGate {
    /// Mark the main window as rendered. Safe to call more than once.
    pub fn release(&self) {
        let sender = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }
}

/// Create the latch and schedule the reveal of the main window.
pub fn init<R: Runtime>(app: &App<R>) {
    let (sender, receiver) = mpsc::channel();
    let destroyed = sender.clone();
    app.manage(StartupGate(Mutex::new(Some(sender))));

    let Some(splash) = app.get_webview_window(SPLASH_LABEL) else {
        tracing::warn!("splash window missing; revealing the main window immediately");
        reveal(app.handle());
        return;
    };
    // Closing the splash by any other means (⌘W, a dead webview) must reveal
    // the main window instead of waiting for the timeout.
    splash.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = destroyed.send(());
        }
    });

    let handle = app.handle().clone();
    let started = Instant::now();
    tracing::info!(
        min_visible_ms = MIN_VISIBLE.as_millis(),
        timeout_ms = READY_TIMEOUT.as_millis(),
        "splash window shown"
    );
    std::thread::spawn(move || {
        let ready = receiver.recv_timeout(READY_TIMEOUT).is_ok();
        let elapsed = started.elapsed();
        if !ready {
            tracing::warn!(
                timeout_ms = READY_TIMEOUT.as_millis(),
                "frontend did not report readiness; revealing the main window anyway"
            );
        }
        // Only hold the splash for its minimum lifetime while it is still up:
        // a splash the user closed must not delay the main window.
        if handle.get_webview_window(SPLASH_LABEL).is_some() {
            if let Some(remaining) = MIN_VISIBLE.checked_sub(elapsed) {
                std::thread::sleep(remaining);
            }
        }
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis(),
            frontend_ready = ready,
            "splash released"
        );
        reveal(&handle);
    });
}

fn reveal<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        match handle.get_webview_window(MAIN_LABEL) {
            Some(main) => {
                if let Err(error) = main.show() {
                    tracing::error!(%error, "failed to show the main window");
                }
                if let Err(error) = main.set_focus() {
                    tracing::warn!(%error, "failed to focus the main window");
                }
                tracing::info!(
                    visible = main.is_visible().unwrap_or(false),
                    "main window revealed"
                );
            }
            None => tracing::error!("main window missing at startup"),
        }
        if let Some(splash) = handle.get_webview_window(SPLASH_LABEL) {
            if let Err(error) = splash.close() {
                tracing::warn!(%error, "failed to close the splash window");
            }
        }
    });
}
