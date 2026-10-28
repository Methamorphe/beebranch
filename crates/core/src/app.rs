use serde::Serialize;

/// Diagnostic payload exposed to the frontend.
///
/// This is a shared contract: keep the Rust field names and the TypeScript
/// `AppInfo` type in sync. `rename_all` keeps the JSON idiomatic for the
/// frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
}
