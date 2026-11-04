//! Built-in terminal: a PTY owned by the backend.
//!
//! The renderer never passes a program or an argument: the shell comes from
//! the user's environment, runs in the repository worktree, and its output is
//! streamed as `data:` base64 events because a PTY emits arbitrary bytes.
//! Closing the view closes the PTY; the shell gets SIGHUP when the master is
//! dropped.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use beebranch_core::{AppError, ErrorCategory};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

pub struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub type TerminalRegistry = Arc<Mutex<HashMap<String, TerminalSession>>>;

/// A renderer can only open a handful of terminals: every one is a shell.
const MAX_SESSIONS: usize = 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub repo_id: String,
    /// Chosen by the renderer so output events can be filtered from the first
    /// byte, before the open call returns.
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalData {
    session_id: String,
    /// Base64-encoded bytes from the PTY.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    code: Option<i32>,
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TerminalOpenRequest,
) -> Result<TerminalOpened, AppError> {
    let session = state.session(&request.repo_id)?;
    let cwd = session.worktree().to_path_buf();
    let shell = default_shell();
    let registry = state.terminals.clone();
    let rows = request.rows.max(1);
    let cols = request.cols.max(1);
    validate_session_id(&request.session_id)?;
    let session_id = request.session_id;
    tauri::async_runtime::spawn_blocking(move || {
        open_pty(&app, registry, cwd, shell, session_id, rows, cols)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| AppError::invalid_input("données de terminal invalides".to_owned()))?;
    let registry = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = registry.lock().map_err(locked)?;
        let session = sessions.get_mut(&session_id).ok_or_else(not_found)?;
        session.writer.write_all(&bytes).map_err(io_error)?;
        session.writer.flush().map_err(io_error)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    let registry = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = registry.lock().map_err(locked)?;
        let session = sessions.get(&session_id).ok_or_else(not_found)?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::internal(format!("redimensionnement du terminal : {error}")))
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn terminal_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let registry = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let removed = registry.lock().map_err(locked)?.remove(&session_id);
        if let Some(mut session) = removed {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok::<(), AppError>(())
    })
    .await
    .map_err(crate::error::join_error)?
}

struct SpawnedShell {
    session: TerminalSession,
    reader: Box<dyn Read + Send>,
}

fn spawn_shell(
    cwd: &std::path::Path,
    shell: &str,
    rows: u16,
    cols: u16,
) -> Result<SpawnedShell, AppError> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            AppError::new(
                "terminal.open_failed",
                ErrorCategory::Internal,
                "Le terminal n'a pas pu être ouvert.",
            )
            .with_detail(error.to_string())
        })?;
    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(command).map_err(|error| {
        AppError::new(
            "terminal.shell_failed",
            ErrorCategory::Internal,
            "Le shell n'a pas pu être lancé.",
        )
        .with_detail(format!("{shell}: {error}"))
    })?;
    // The slave side belongs to the child; keeping it open would keep the
    // reader from ever seeing EOF.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::internal(format!("lecture du terminal impossible : {error}")))?;
    let writer = pair.master.take_writer().map_err(|error| {
        AppError::internal(format!("écriture dans le terminal impossible : {error}"))
    })?;
    Ok(SpawnedShell {
        session: TerminalSession {
            master: pair.master,
            writer,
            child,
        },
        reader,
    })
}

fn open_pty(
    app: &AppHandle,
    registry: TerminalRegistry,
    cwd: PathBuf,
    shell: String,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<TerminalOpened, AppError> {
    let SpawnedShell { session, reader } = spawn_shell(&cwd, &shell, rows, cols)?;
    if registry.lock().map_err(locked)?.len() >= MAX_SESSIONS {
        return Err(AppError::new(
            "terminal.limit",
            ErrorCategory::Busy,
            "Trop de terminaux sont ouverts (8 maximum).",
        ));
    }
    registry
        .lock()
        .map_err(locked)?
        .insert(session_id.clone(), session);
    stream(app.clone(), registry, session_id.clone(), reader);
    Ok(TerminalOpened {
        session_id,
        shell,
        cwd: cwd.display().to_string(),
    })
}

/// Read the PTY until it closes, emitting base64 chunks then the exit code.
fn stream(
    app: AppHandle,
    registry: TerminalRegistry,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let payload = TerminalData {
                        session_id: session_id.clone(),
                        data: STANDARD.encode(&buffer[..read]),
                    };
                    if app.emit("term://data", payload).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let code = registry
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&session_id))
            .and_then(|mut session| {
                let _ = session.child.kill();
                session
                    .child
                    .wait()
                    .ok()
                    .map(|status| status.exit_code() as i32)
            });
        let _ = app.emit("term://exit", TerminalExit { session_id, code });
    });
}

/// Session ids come from the renderer; keep them to a short opaque token so a
/// registry key can never be surprising.
fn validate_session_id(value: &str) -> Result<(), AppError> {
    let valid = !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        });
    if valid {
        Ok(())
    } else {
        Err(AppError::invalid_input(
            "identifiant de terminal invalide".to_owned(),
        ))
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_owned())
    }
}

fn not_found() -> AppError {
    AppError::new(
        "terminal.not_found",
        ErrorCategory::Input,
        "Ce terminal n'existe plus.",
    )
}

fn locked<T>(_: T) -> AppError {
    AppError::internal("registre de terminaux verrouillé".to_owned())
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "terminal.write_failed",
        ErrorCategory::Internal,
        "Le terminal n'accepte plus d'entrée.",
    )
    .with_detail(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Duration;

    #[test]
    #[cfg(unix)]
    fn the_pty_streams_shell_output() {
        let dir = std::env::temp_dir();
        let SpawnedShell {
            mut session,
            mut reader,
        } = spawn_shell(&dir, "/bin/sh", 24, 80).expect("pty");
        session
            .writer
            .write_all(b"echo beebranch-pty\nexit\n")
            .expect("write");
        session.writer.flush().expect("flush");
        let mut output = Vec::new();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            let mut collected = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        collected.extend_from_slice(&buffer[..read]);
                        if String::from_utf8_lossy(&collected).contains("beebranch-pty") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = sender.send(collected);
        });
        if let Ok(chunk) = receiver.recv_timeout(Duration::from_secs(5)) {
            output = chunk;
        }
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("beebranch-pty"), "output: {text:?}");
        let _ = session.child.kill();
        let _ = session.child.wait();
    }

    #[test]
    fn session_ids_are_validated() {
        assert!(validate_session_id("term-1-abc_DEF").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("../escape").is_err());
        assert!(validate_session_id(&"a".repeat(81)).is_err());
    }
}
