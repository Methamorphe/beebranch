use std::path::Path;
use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

/// Initialise console and rotating file logging.
///
/// Logs are redacted at the source: Git/GitLab errors never contain tokens and
/// diagnostic exports pass through `beebranch_core::redaction`.
pub fn init(data_dir: &Path) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let log_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_layer = match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("beebranch")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
    {
        Ok(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let _ = GUARD.set(guard);
            Some(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    .with_ansi(false)
                    .with_target(true),
            )
        }
        Err(_) => None,
    };

    let console = tracing_subscriber::fmt::layer()
        .with_target(false)
        .compact();

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(console)
        .with(file_layer)
        .try_init();
}
