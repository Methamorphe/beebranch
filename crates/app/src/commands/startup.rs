use tauri::State;

use crate::splash::StartupGate;

/// Called by the main window once React painted its first frame. Releases the
/// splash window so the main window can replace it.
#[tauri::command]
pub fn app_ready(gate: State<'_, StartupGate>) {
    tracing::info!("main window reported ready");
    gate.release();
}
