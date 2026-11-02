//! External tools: editors, terminals and configured diff/merge tools.
//!
//! Programs are spawned directly with an argv vector: no shell, no `sh -c`,
//! no `cmd /c`. A missing program produces an explicit error.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use beebranch_core::AppError;
use beebranch_git::history;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::store_error;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Editor,
    Terminal,
    Diff,
    Merge,
}

impl ToolKind {
    fn preference_key(self) -> &'static str {
        match self {
            Self::Editor => "tools.editor",
            Self::Terminal => "tools.terminal",
            Self::Diff => "tools.diff",
            Self::Merge => "tools.merge",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub kind: ToolKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsReport {
    pub editors: Vec<ToolDescriptor>,
    pub terminals: Vec<ToolDescriptor>,
    pub diff_tools: Vec<ToolDescriptor>,
    pub merge_tools: Vec<ToolDescriptor>,
    pub configured: Vec<ToolDescriptor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfigInput {
    pub kind: ToolKind,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOpenInput {
    pub repo_id: String,
    pub kind: ToolKind,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlInput {
    pub url: String,
}

fn candidates(kind: ToolKind) -> Vec<ToolDescriptor> {
    let mut list = Vec::new();
    let mut push = |id: &str, label: &str, program: &str, args: Vec<&str>| {
        list.push(ToolDescriptor {
            id: id.to_owned(),
            label: label.to_owned(),
            program: program.to_owned(),
            args: args.into_iter().map(str::to_owned).collect(),
            kind,
        });
    };
    match kind {
        ToolKind::Editor => {
            for (id, label, program) in [
                ("code", "Visual Studio Code", "code"),
                ("cursor", "Cursor", "cursor"),
                ("zed", "Zed", "zed"),
                ("subl", "Sublime Text", "subl"),
                ("nvim", "Neovim", "nvim"),
                ("vim", "Vim", "vim"),
                ("nano", "Nano", "nano"),
            ] {
                push(id, label, program, vec!["{path}"]);
            }
        }
        ToolKind::Terminal => {
            #[cfg(target_os = "macos")]
            {
                push(
                    "terminal",
                    "Terminal",
                    "open",
                    vec!["-a", "Terminal", "{path}"],
                );
                push("iterm", "iTerm2", "open", vec!["-a", "iTerm", "{path}"]);
            }
            #[cfg(target_os = "linux")]
            {
                push(
                    "x-terminal-emulator",
                    "Terminal",
                    "x-terminal-emulator",
                    vec!["--working-directory={path}"],
                );
                push(
                    "gnome-terminal",
                    "GNOME Terminal",
                    "gnome-terminal",
                    vec!["--working-directory={path}"],
                );
                push("konsole", "Konsole", "konsole", vec!["--workdir", "{path}"]);
                push(
                    "alacritty",
                    "Alacritty",
                    "alacritty",
                    vec!["--working-directory", "{path}"],
                );
                push("kitty", "Kitty", "kitty", vec!["--directory", "{path}"]);
            }
            #[cfg(target_os = "windows")]
            {
                push("wt", "Windows Terminal", "wt", vec!["-d", "{path}"]);
            }
        }
        ToolKind::Diff => {
            for (id, label, program, args) in [
                ("meld", "Meld", "meld", vec!["{left}", "{right}"]),
                ("kdiff3", "KDiff3", "kdiff3", vec!["{left}", "{right}"]),
                (
                    "opendiff",
                    "FileMerge",
                    "opendiff",
                    vec!["{left}", "{right}"],
                ),
            ] {
                push(id, label, program, args);
            }
        }
        ToolKind::Merge => {
            for (id, label, program, args) in [
                (
                    "meld",
                    "Meld",
                    "meld",
                    vec!["{ours}", "{base}", "{theirs}", "--output={output}"],
                ),
                (
                    "kdiff3",
                    "KDiff3",
                    "kdiff3",
                    vec!["{ours}", "{base}", "{theirs}", "-o", "{output}"],
                ),
                (
                    "opendiff",
                    "FileMerge",
                    "opendiff",
                    vec![
                        "{ours}",
                        "{theirs}",
                        "-ancestor",
                        "{base}",
                        "-merge",
                        "{output}",
                    ],
                ),
            ] {
                push(id, label, program, args);
            }
        }
    }
    list
}

fn find_in_path(program: &str) -> Option<PathBuf> {
    if program.contains('/') || program.contains('\\') {
        let path = PathBuf::from(program);
        return path.is_file().then_some(path);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(program))
        .find(|candidate| candidate.is_file())
}

fn configured(state: &AppState, kind: ToolKind) -> Option<ToolDescriptor> {
    let raw = state
        .store
        .preference(kind.preference_key())
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let program = value.get("program")?.as_str()?.to_owned();
    let args = value
        .get("args")
        .and_then(|args| args.as_array())
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Some(ToolDescriptor {
        id: format!("configured-{}", kind.preference_key()),
        label: format!("{} configuré", tool_label(kind)),
        program,
        args,
        kind,
    })
}

fn tool_label(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Editor => "Éditeur",
        ToolKind::Terminal => "Terminal",
        ToolKind::Diff => "Outil de diff",
        ToolKind::Merge => "Outil de merge",
    }
}

fn available(kind: ToolKind) -> Vec<ToolDescriptor> {
    candidates(kind)
        .into_iter()
        .filter(|descriptor| find_in_path(&descriptor.program).is_some())
        .collect()
}

#[tauri::command]
pub fn tools_detect(state: State<'_, AppState>) -> ToolsReport {
    let configured_list = [
        ToolKind::Editor,
        ToolKind::Terminal,
        ToolKind::Diff,
        ToolKind::Merge,
    ]
    .into_iter()
    .filter_map(|kind| configured(&state, kind))
    .collect();
    ToolsReport {
        editors: available(ToolKind::Editor),
        terminals: available(ToolKind::Terminal),
        diff_tools: available(ToolKind::Diff),
        merge_tools: available(ToolKind::Merge),
        configured: configured_list,
    }
}

#[tauri::command]
pub fn tool_configure(
    state: State<'_, AppState>,
    input: ToolConfigInput,
) -> Result<ToolDescriptor, AppError> {
    if input.program.trim().is_empty() {
        return Err(AppError::invalid_input("programme vide".to_owned()));
    }
    if find_in_path(&input.program).is_none() {
        return Err(AppError::new(
            "tool.missing",
            beebranch_core::ErrorCategory::Input,
            format!("L'outil {} est introuvable.", input.program),
        )
        .with_remediation("Installez l'outil ou indiquez son chemin absolu."));
    }
    for argument in &input.args {
        if argument.contains('\0') {
            return Err(AppError::invalid_input(
                "argument d'outil invalide".to_owned(),
            ));
        }
    }
    let value = serde_json::json!({
        "program": input.program,
        "args": input.args,
    });
    state
        .store
        .set_preference(input.kind.preference_key(), &value.to_string())
        .map_err(store_error)?;
    Ok(ToolDescriptor {
        id: format!("configured-{}", input.kind.preference_key()),
        label: format!("{} configuré", tool_label(input.kind)),
        program: input.program,
        args: input.args,
        kind: input.kind,
    })
}

fn resolve_tool(state: &AppState, kind: ToolKind) -> Result<ToolDescriptor, AppError> {
    if let Some(descriptor) = configured(state, kind) {
        return Ok(descriptor);
    }
    available(kind).into_iter().next().ok_or_else(|| {
        AppError::new(
            "tool.missing",
            beebranch_core::ErrorCategory::Input,
            format!("Aucun outil {} n'est disponible.", tool_label(kind)),
        )
        .with_remediation("Installez un outil ou configurez-le dans les préférences.")
    })
}

fn expand(args: &[String], values: &[(&str, &str)]) -> Vec<String> {
    args.iter()
        .map(|argument| {
            let mut value = argument.clone();
            for (placeholder, replacement) in values {
                value = value.replace(placeholder, replacement);
            }
            value
        })
        .collect()
}

fn spawn(program: &str, args: &[String], cwd: &Path) -> Result<(), AppError> {
    let resolved = find_in_path(program).ok_or_else(|| {
        AppError::new(
            "tool.missing",
            beebranch_core::ErrorCategory::Input,
            format!("L'outil {program} est introuvable."),
        )
        .with_remediation("Installez l'outil ou corrigez la préférence.")
    })?;
    Command::new(resolved)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                "tool.spawn_failed",
                beebranch_core::ErrorCategory::Input,
                format!("Impossible de lancer {program}."),
            )
            .with_detail(error.to_string())
        })
}

fn temp_dir(state: &AppState) -> Result<PathBuf, AppError> {
    let dir = state.paths.data_dir().join("tmp");
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::internal(format!("dossier temporaire: {error}")))?;
    Ok(dir)
}

fn write_temp(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    let path = dir.join(name);
    std::fs::write(&path, bytes)
        .map_err(|error| AppError::internal(format!("écriture temporaire: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

fn validate_worktree_path(worktree: &Path, path: &str) -> Result<PathBuf, AppError> {
    beebranch_git::diff::validate_relative_path(path)?;
    Ok(worktree.join(path))
}

#[tauri::command]
pub async fn tool_open(state: State<'_, AppState>, input: ToolOpenInput) -> Result<(), AppError> {
    let session = state.session(&input.repo_id)?;
    let tool = resolve_tool(&state, input.kind)?;
    let worktree = session.worktree().to_path_buf();

    match input.kind {
        ToolKind::Editor => {
            let target = match input.path.as_deref() {
                Some(path) => validate_worktree_path(&worktree, path)?,
                None => worktree.clone(),
            };
            if !target.exists() {
                return Err(AppError::not_found(format!(
                    "Le fichier {} n'existe pas.",
                    target.display()
                )));
            }
            let target_text = target.display().to_string();
            let args = expand(&tool.args, &[("{path}", &target_text)]);
            spawn(&tool.program, &args, &worktree)
        }
        ToolKind::Terminal => {
            let target_text = worktree.display().to_string();
            let args = expand(&tool.args, &[("{path}", &target_text)]);
            spawn(&tool.program, &args, &worktree)
        }
        ToolKind::Diff => {
            let path = input
                .path
                .as_deref()
                .ok_or_else(|| AppError::invalid_input("chemin requis pour le diff".to_owned()))?;
            let base = input.base.as_deref().unwrap_or("index");
            let file = validate_worktree_path(&worktree, path)?;
            let left = read_side(&session, path, base)?;
            let right = match std::fs::read(&file) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => {
                    return Err(AppError::internal(format!(
                        "lecture de {}: {error}",
                        file.display()
                    )))
                }
            };
            let dir = temp_dir(&state)?;
            let left_path = write_temp(&dir, &format!("{}-left", sanitize(path)), &left)?;
            let right_path = write_temp(&dir, &format!("{}-right", sanitize(path)), &right)?;
            let left_text = left_path.display().to_string();
            let right_text = right_path.display().to_string();
            let args = expand(
                &tool.args,
                &[("{left}", &left_text), ("{right}", &right_text)],
            );
            spawn(&tool.program, &args, &worktree)
        }
        ToolKind::Merge => {
            let path = input
                .path
                .as_deref()
                .ok_or_else(|| AppError::invalid_input("chemin requis pour le merge".to_owned()))?;
            let target = validate_worktree_path(&worktree, path)?;
            let stages = tauri::async_runtime::spawn_blocking({
                let session = session.clone();
                let path = path.to_owned();
                move || history::conflict_stages(session.runner(), session.worktree(), &path)
            })
            .await
            .map_err(crate::error::join_error)??;
            let dir = temp_dir(&state)?;
            let base = write_temp(
                &dir,
                &format!("{}-base", sanitize(path)),
                stages.base.as_deref().unwrap_or_default(),
            )?;
            let ours = write_temp(
                &dir,
                &format!("{}-ours", sanitize(path)),
                stages.ours.as_deref().unwrap_or_default(),
            )?;
            let theirs = write_temp(
                &dir,
                &format!("{}-theirs", sanitize(path)),
                stages.theirs.as_deref().unwrap_or_default(),
            )?;
            let output = target.display().to_string();
            let args = expand(
                &tool.args,
                &[
                    ("{base}", &base.display().to_string()),
                    ("{ours}", &ours.display().to_string()),
                    ("{theirs}", &theirs.display().to_string()),
                    ("{output}", &output),
                ],
            );
            spawn(&tool.program, &args, &worktree)
        }
    }
}

fn read_side(
    session: &beebranch_git::session::RepoSession,
    path: &str,
    base: &str,
) -> Result<Vec<u8>, AppError> {
    let content = match base {
        "index" => history::index_content(session.runner(), session.worktree(), path)?,
        "head" => history::head_content(session.runner(), session.worktree(), path)?,
        "empty" => return Ok(Vec::new()),
        other => {
            return Err(AppError::invalid_input(format!(
                "base de diff inconnue: {other}"
            )))
        }
    };
    Ok(content.unwrap_or_default())
}

fn sanitize(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
pub fn open_external_url(input: UrlInput) -> Result<(), AppError> {
    let url = input.url.trim();
    if !url.starts_with("https://") {
        return Err(AppError::invalid_input(
            "seuls les liens https sont ouverts.".to_owned(),
        ));
    }
    if url
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(AppError::invalid_input("URL invalide".to_owned()));
    }
    launch_browser(url)
}

/// Hands the URL to the default browser of the platform.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn launch_browser(url: &str) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    spawn_browser(program, url)
}

/// `explorer.exe` is not a URL opener: it treats every argument as a shell
/// item and splits the list on commas, so a token page such as
/// `…/personal_access_tokens?scopes=api,read_user` opened a File Explorer
/// window on the wrong folder. `ShellExecuteW` hands the URL to the registered
/// `https` handler without parsing it as a command line.
#[cfg(target_os = "windows")]
fn launch_browser(url: &str) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let operation = wide("open");
    let target = wide(url);
    // SAFETY: both strings are NUL-terminated and outlive the call; the URL was
    // validated above and no window handle nor working directory is needed.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value above 32, an error code below.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "ouverture du navigateur: code {}",
            result as isize
        )))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn launch_browser(url: &str) -> Result<(), AppError> {
    let _ = url;
    Err(AppError::internal(
        "ouverture du navigateur non prise en charge".to_owned(),
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawn_browser(program: &str, url: &str) -> Result<(), AppError> {
    Command::new(program)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::internal(format!("ouverture du navigateur: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_only_known_placeholders() {
        let args = vec![
            "{path}".to_owned(),
            "{left}/{right}".to_owned(),
            "{unknown}".to_owned(),
        ];
        let expanded = expand(
            &args,
            &[("{path}", "/repo"), ("{left}", "a"), ("{right}", "b")],
        );
        assert_eq!(expanded, vec!["/repo", "a/b", "{unknown}"]);
    }

    #[test]
    fn sanitizes_temp_file_names() {
        assert_eq!(sanitize("src/main file.rs"), "src_main_file.rs");
        assert_eq!(sanitize("café.txt"), "caf_.txt");
    }

    #[test]
    fn rejects_paths_outside_the_worktree() {
        let root = std::path::Path::new("/tmp/repo");
        assert!(validate_worktree_path(root, "../escape").is_err());
        assert!(validate_worktree_path(root, ".git/config").is_err());
        assert!(validate_worktree_path(root, "src/main.rs").is_ok());
    }

    #[test]
    fn rejects_unsafe_urls() {
        assert!(crate::commands::tools::open_external_url(UrlInput {
            url: "file:///etc/passwd".into()
        })
        .is_err());
        assert!(crate::commands::tools::open_external_url(UrlInput {
            url: "https://example.test/a b".into()
        })
        .is_err());
    }
}
