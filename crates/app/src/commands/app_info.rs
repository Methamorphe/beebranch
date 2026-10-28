use beebranch_core::{AppInfo, APP_NAME, APP_VERSION};
use tauri::State;

use crate::state::AppState;

/// Return lightweight diagnostics proving the Rust/WebView IPC path works.
#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: APP_NAME.to_owned(),
        version: APP_VERSION.to_owned(),
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        data_dir: state.paths.data_dir().display().to_string(),
    }
}
