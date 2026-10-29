//! Custom workspace backgrounds.
//!
//! The renderer loads wallpapers through a `data:` URL so the webview never
//! needs filesystem access: the user picks a file with the native dialog, the
//! backend reads it once and returns a self-contained URL. Animated GIFs work
//! because the webview animates `background-image` URLs by itself.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use beebranch_core::AppError;

/// Upper bound on the file we inline. GIF wallpapers are the bulky case; the
/// limit keeps the IPC payload (base64 adds ~33%) under a few dozen megabytes.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

const SUPPORTED: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
];

fn mime_for(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    SUPPORTED
        .iter()
        .find(|(name, _)| *name == extension)
        .map(|(_, mime)| *mime)
}

#[tauri::command]
pub async fn background_read(path: String) -> Result<String, AppError> {
    // Wallpapers run up to 32 MB: read them off the main thread like the other
    // commands that touch the filesystem.
    tauri::async_runtime::spawn_blocking(move || read_data_url(&path))
        .await
        .map_err(|error| {
            AppError::internal(format!("lecture du fond d'écran interrompue: {error}"))
        })?
}

fn read_data_url(path: &str) -> Result<String, AppError> {
    let file = Path::new(path);
    let mime = mime_for(file).ok_or_else(|| {
        AppError::invalid_input(
            "format d'image non pris en charge (png, jpg, gif, webp, avif, bmp)".to_owned(),
        )
    })?;

    let metadata = std::fs::metadata(file)
        .map_err(|error| AppError::invalid_input(format!("image introuvable ({path}): {error}")))?;
    if !metadata.is_file() {
        return Err(AppError::invalid_input(format!(
            "le fond d'écran sélectionné n'est pas un fichier: {path}"
        )));
    }
    if metadata.len() > MAX_BYTES {
        return Err(AppError::invalid_input(format!(
            "image trop volumineuse ({} Mo, maximum {} Mo)",
            metadata.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }

    let bytes = std::fs::read(file).map_err(|error| {
        AppError::invalid_input(format!(
            "lecture du fond d'écran impossible ({path}): {error}"
        ))
    })?;

    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::{mime_for, read_data_url};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::path::Path;

    #[test]
    fn recognises_supported_image_extensions() {
        assert_eq!(mime_for(Path::new("a/b/wall.png")), Some("image/png"));
        assert_eq!(mime_for(Path::new("a/b/WALL.GIF")), Some("image/gif"));
        assert_eq!(mime_for(Path::new("photo.jpeg")), Some("image/jpeg"));
        assert_eq!(mime_for(Path::new("anim.webp")), Some("image/webp"));
    }

    #[test]
    fn rejects_unsupported_or_extensionless_files() {
        assert_eq!(mime_for(Path::new("wall.tiff")), None);
        assert_eq!(mime_for(Path::new("wall")), None);
        assert_eq!(mime_for(Path::new("svg.svg")), None);
    }

    #[test]
    fn inlines_a_supported_image_as_a_data_url() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("wall.GIF");
        std::fs::write(&path, b"GIF89a-pixels").expect("write fixture");

        let url = read_data_url(path.to_str().expect("utf-8 path")).expect("data url");

        assert_eq!(
            url,
            format!(
                "data:image/gif;base64,{}",
                STANDARD.encode(b"GIF89a-pixels")
            )
        );
    }

    #[test]
    fn refuses_missing_files_and_foreign_formats() {
        assert!(read_data_url("/nonexistent/wall.png").is_err());
        // The extension check runs before touching the filesystem.
        assert!(read_data_url("/nonexistent/wall.tiff").is_err());
    }
}
