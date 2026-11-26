//! System notification permission and delivery.
//!
//! The Tauri plugin reports desktop permission as always granted and never
//! asks the operating system. On a bundled macOS app that skips the system
//! dialog and posts through the deprecated notification center, which current
//! macOS often drops. BeeBranch asks `UNUserNotificationCenter` instead.
//! Windows toasts have no permission dialog: they are posted directly, and
//! only the installed application has an AppUserModelID of its own.

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermission {
    pub granted: bool,
    /// `system` when macOS was asked. `implicit` when the platform never asks.
    pub prompt: &'static str,
    /// `un` and `winrt` are posted by [`notification_show`]. `plugin` stays on
    /// the Tauri plugin (macOS development builds, Linux).
    pub channel: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationShow {
    pub title: String,
    pub body: String,
}

fn send_failed(detail: impl Into<String>) -> AppError {
    AppError::new(
        "notify.send_failed",
        ErrorCategory::Permission,
        "La notification n'a pas pu être affichée.",
    )
    .with_detail(detail)
    .with_remediation(
        "Sur Mac, autorisez BeeBranch dans Réglages Système > Notifications. Sous Windows, lancez l'application installée : le raccourci du menu Démarrer enregistre l'identité des toasts.",
    )
}

#[tauri::command]
pub fn notification_permission() -> NotificationPermission {
    platform::permission()
}

#[tauri::command]
pub fn notification_show(app: AppHandle, request: NotificationShow) -> Result<(), AppError> {
    let title = request.title.trim();
    let body = request.body.trim();
    if title.is_empty() || title.len() > 120 || body.len() > 512 {
        return Err(AppError::invalid_input(
            "notification: titre ou texte hors limites".to_owned(),
        ));
    }
    platform::show(&app, title, body)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{send_failed, NotificationPermission};
    use beebranch_core::AppError;
    use tauri::AppHandle;

    pub fn permission() -> NotificationPermission {
        // A development binary has no bundle identity. The plugin posts as
        // Terminal, which already has permission and never shows a dialog.
        if tauri::is_dev() || mac_usernotifications::check_bundle().is_err() {
            return NotificationPermission {
                granted: true,
                prompt: "implicit",
                channel: "plugin",
            };
        }
        match mac_usernotifications::blocking::request_auth() {
            Ok(true) => NotificationPermission {
                granted: true,
                prompt: "system",
                channel: "un",
            },
            _ => NotificationPermission {
                granted: false,
                prompt: "system",
                channel: "un",
            },
        }
    }

    pub fn show(_app: &AppHandle, title: &str, body: &str) -> Result<(), AppError> {
        mac_usernotifications::Notification::new()
            .title(title)
            .message(body)
            .send_blocking()
            .map(|_| ())
            .map_err(|error| send_failed(error.to_string()))
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{send_failed, NotificationPermission};
    use beebranch_core::AppError;
    use tauri::AppHandle;
    use tauri_winrt_notification::Toast;

    pub fn permission() -> NotificationPermission {
        NotificationPermission {
            granted: true,
            prompt: "implicit",
            channel: "winrt",
        }
    }

    fn app_id(app: &AppHandle) -> String {
        if tauri::is_dev() || built_from_target() {
            return Toast::POWERSHELL_APP_ID.to_owned();
        }
        app.config().identifier.clone()
    }

    /// `cargo` build directories have no Start-menu shortcut, so they cannot
    /// register BeeBranch's AppUserModelID. PowerShell's id still shows a toast.
    fn built_from_target() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(dir) = exe.parent() else {
            return false;
        };
        let text = dir.to_string_lossy();
        text.ends_with(r"target\debug") || text.ends_with(r"target\release")
    }

    pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), AppError> {
        Toast::new(&app_id(app))
            .title(title)
            .text2(body)
            .show()
            .map_err(|error| send_failed(format!("{error:?}")))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::NotificationPermission;
    use beebranch_core::AppError;
    use tauri::AppHandle;

    pub fn permission() -> NotificationPermission {
        NotificationPermission {
            granted: true,
            prompt: "implicit",
            channel: "plugin",
        }
    }

    pub fn show(_app: &AppHandle, _title: &str, _body: &str) -> Result<(), AppError> {
        Err(super::send_failed(
            "cette plateforme publie via le plugin".to_owned(),
        ))
    }
}
