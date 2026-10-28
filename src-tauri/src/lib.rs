#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    beebranch_app::builder()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running BeeBranch");
}
