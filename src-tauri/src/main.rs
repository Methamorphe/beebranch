#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless probe used by the release pipeline to prove an installed bundle
    // starts on a clean runner before the webview is initialized.
    if std::env::args_os().any(|argument| argument == "--version" || argument == "-V") {
        println!("BeeBranch {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    beebranch_lib::run();
}
