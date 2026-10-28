//! Signed updates and rollback.
//!
//! Artifact signatures are verified by `tauri-plugin-updater` before any
//! installation. The updater endpoint is signed-manifest based; an unsigned or
//! tampered artifact is refused with `update.signature_invalid`. Rollback
//! reuses the same verification against a `rollback.json` manifest that pins
//! the previous release.

use beebranch_core::{AppError, Confirmation, ErrorCategory};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusDto {
    pub current_version: String,
    pub endpoint: Option<String>,
    pub rollback_endpoint: Option<String>,
    pub signature_required: bool,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub current_version: String,
    pub version: String,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub download_url: String,
    pub rollback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallDto {
    pub previous_version: String,
    pub installed_version: String,
    pub restarting: bool,
}

/// Signed-manifest endpoint. The release workflow injects the GitHub Releases
/// asset URL at compile time; local builds fall back to the default host.
const DEFAULT_UPDATE_ENDPOINT: &str = "https://updates.beebranch.fr/latest.json";
const LATEST_MANIFEST: &str = "/latest.json";

fn endpoint_text() -> &'static str {
    option_env!("BEEBRANCH_UPDATE_ENDPOINT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPDATE_ENDPOINT)
}

fn endpoint() -> Option<String> {
    Some(endpoint_text().to_owned())
}

fn rollback_of(endpoint: &str) -> Option<String> {
    endpoint
        .strip_suffix(LATEST_MANIFEST)
        .map(|base| format!("{base}/rollback.json"))
}

fn rollback_endpoint() -> Option<String> {
    rollback_of(endpoint_text())
}

fn parse_endpoint(value: &str, code: &'static str, message: &str) -> Result<Url, AppError> {
    let url: Url = value.parse().map_err(|error: url::ParseError| {
        AppError::new(code, ErrorCategory::Input, message).with_detail(error.to_string())
    })?;
    // `tauri.conf.json` used to let the plugin reject plain HTTP. The endpoint
    // is now injected at build time, so the same rule is enforced here and
    // loopback stays allowed for local manifest testing.
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !loopback {
        return Err(AppError::new(code, ErrorCategory::Input, message)
            .with_detail(format!("protocole refusé : {value}")));
    }
    Ok(url)
}

/// The updater must consult the same endpoint that `update_status` reports;
/// otherwise a build can advertise one host and fetch from another.
fn endpoint_url() -> Result<Url, AppError> {
    parse_endpoint(
        endpoint_text(),
        "update.invalid_endpoint",
        "L'endpoint de mise à jour est invalide.",
    )
}

fn rollback_url() -> Result<Url, AppError> {
    let endpoint = rollback_endpoint().ok_or_else(|| {
        AppError::new(
            "update.rollback_unconfigured",
            ErrorCategory::Input,
            "Aucun endpoint de rollback n'est configuré.",
        )
    })?;
    parse_endpoint(
        &endpoint,
        "update.invalid_endpoint",
        "L'endpoint de rollback est invalide.",
    )
}

fn updater_error(error: tauri_plugin_updater::Error) -> AppError {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    let code = if lower.contains("signature") || lower.contains("minisign") {
        "update.signature_invalid"
    } else if lower.contains("tls") || lower.contains("certificate") {
        "update.tls"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "update.timeout"
    } else {
        "update.failed"
    };
    AppError::new(
        code,
        ErrorCategory::Network,
        "La mise à jour a échoué.",
    )
    .with_detail(text)
    .with_remediation(
        "Aucun binaire non signé n'est installé. Vérifiez le manifeste et la signature de publication.",
    )
}

fn ensure_confirmed(confirmation: &Confirmation) -> Result<(), AppError> {
    if confirmation.acknowledged {
        Ok(())
    } else {
        Err(AppError::new(
            "confirmation.required",
            ErrorCategory::Input,
            "Confirmez explicitement l'installation de la mise à jour.",
        ))
    }
}

#[tauri::command]
pub async fn update_status() -> Result<UpdateStatusDto, AppError> {
    Ok(UpdateStatusDto {
        current_version: beebranch_core::APP_VERSION.to_owned(),
        endpoint: endpoint(),
        rollback_endpoint: rollback_endpoint(),
        signature_required: true,
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfoDto>, AppError> {
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint_url()?])
        .map_err(updater_error)?
        .build()
        .map_err(updater_error)?;
    let update = updater.check().await.map_err(updater_error)?;
    Ok(update.map(|update| UpdateInfoDto {
        current_version: update.current_version,
        version: update.version,
        published_at: update.date.map(|date| date.to_string()),
        notes: update.body,
        download_url: update.download_url.to_string(),
        rollback: false,
    }))
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    confirmation: Confirmation,
) -> Result<UpdateInstallDto, AppError> {
    ensure_confirmed(&confirmation)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint_url()?])
        .map_err(updater_error)?
        .build()
        .map_err(updater_error)?;
    let update = updater
        .check()
        .await
        .map_err(updater_error)?
        .ok_or_else(|| {
            AppError::new(
                "update.none",
                ErrorCategory::Network,
                "Aucune mise à jour n'est disponible.",
            )
        })?;
    let current_version = update.current_version.clone();
    let installed_version = update.version.clone();
    let handle = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = handle.emit(
                    "update://progress",
                    serde_json::json!({ "downloaded": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(updater_error)?;
    Ok(UpdateInstallDto {
        previous_version: current_version,
        installed_version,
        restarting: false,
    })
}

#[tauri::command]
pub async fn update_rollback(
    app: AppHandle,
    confirmation: Confirmation,
) -> Result<UpdateInstallDto, AppError> {
    ensure_confirmed(&confirmation)?;
    let url = rollback_url()?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(updater_error)?
        .version_comparator(|_current, _remote| true)
        .build()
        .map_err(updater_error)?;
    let update = updater
        .check()
        .await
        .map_err(updater_error)?
        .ok_or_else(|| {
            AppError::new(
                "update.rollback_unavailable",
                ErrorCategory::Network,
                "Aucune version antérieure signée n'est disponible.",
            )
        })?;
    let current_version = update.current_version.clone();
    let installed_version = update.version.clone();
    let handle = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = handle.emit(
                    "update://progress",
                    serde_json::json!({ "downloaded": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(updater_error)?;
    Ok(UpdateInstallDto {
        previous_version: current_version,
        installed_version,
        restarting: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_manifest_sits_next_to_latest() {
        assert_eq!(
            rollback_of("https://github.com/bee/beebranch/releases/latest/download/latest.json")
                .as_deref(),
            Some("https://github.com/bee/beebranch/releases/latest/download/rollback.json")
        );
        assert_eq!(rollback_of("https://updates.example/root.json"), None);
    }

    #[test]
    fn plain_http_is_refused_outside_loopback() {
        let refused = parse_endpoint(
            "http://updates.example/latest.json",
            "update.invalid_endpoint",
            "invalide",
        );
        assert!(refused.is_err(), "cleartext endpoint must be refused");
        assert!(
            parse_endpoint(
                "http://localhost:8080/latest.json",
                "update.invalid_endpoint",
                "invalide"
            )
            .is_ok(),
            "loopback stays available for local manifest testing"
        );
        assert!(parse_endpoint(
            "https://updates.example/latest.json",
            "update.invalid_endpoint",
            "invalide"
        )
        .is_ok());
    }

    #[test]
    fn the_advertised_endpoint_is_the_one_that_gets_fetched() {
        assert_eq!(endpoint().as_deref(), Some(endpoint_text()));
        assert_eq!(endpoint_url().map(|url| url.to_string()).ok(), endpoint());
    }
}
