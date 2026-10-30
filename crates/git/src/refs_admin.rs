//! Tags and remotes management beyond the read model.
//!
//! Tag creation returns the annotated object identity so the UI can display
//! the tagger and message. Remote URLs are validated: no embedded password,
//! no control characters, explicit protocol allowlist.

use std::path::Path;
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub oid: String,
    pub object_type: String,
    pub annotated: bool,
    /// Commit the tag points to (peeled object) when annotated.
    pub target_oid: Option<String>,
    pub message: Option<String>,
    pub tagger: Option<String>,
    pub tagger_email: Option<String>,
    pub tagger_time: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReport {
    pub remote: String,
    pub reference: String,
    pub stdout: String,
    pub stderr: String,
}

pub fn validate_tag_name(runner: &GitRunner, worktree: &Path, name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(AppError::invalid_input(
            "le nom du tag est invalide".to_owned(),
        ));
    }
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::CheckRefFormat, worktree).arg(format!("refs/tags/{name}")),
    )?;
    if !outcome.success() {
        return Err(
            AppError::invalid_input(format!("Le nom de tag `{name}` est invalide."))
                .with_detail(outcome.stderr.redacted()),
        );
    }
    Ok(())
}

fn validate_remote_name(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.starts_with('.')
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::invalid_input(
            "Le nom du remote est invalide.".to_owned(),
        ));
    }
    Ok(())
}

/// Validate a remote URL. Credentials are refused rather than stored.
pub fn validate_remote_url(url: &str) -> Result<(), AppError> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(AppError::invalid_input(
            "L'URL du remote est vide ou invalide.".to_owned(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::invalid_input(
            "L'URL du remote ne peut pas contenir d'espace.".to_owned(),
        ));
    }
    // Only a password inside the userinfo is a credential. For scheme URLs the
    // protocol colon is not part of it (`ssh://git@host/repo`), and scp-like
    // syntax (`git@host:path`) has no colon before the `@` either.
    if let Some((head, _)) = trimmed.split_once('@') {
        let userinfo = head
            .rsplit_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(head);
        if userinfo.contains(':') {
            return Err(AppError::new(
                "remote.url_has_credentials",
                ErrorCategory::Input,
                "L'URL du remote ne doit pas contenir de mot de passe.",
            )
            .with_remediation(
                "Utilisez un credential helper ou une clé SSH ; aucun secret n'est stocké dans l'URL.",
            ));
        }
    }
    if let Some((scheme, _)) = trimmed.split_once("://") {
        let allowed = matches!(scheme, "https" | "http" | "ssh" | "git" | "file");
        if !allowed {
            return Err(AppError::invalid_input(format!(
                "Le protocole `{scheme}` n'est pas autorisé."
            )));
        }
    }
    Ok(())
}

pub fn list_tags(runner: &GitRunner, worktree: &Path) -> Result<Vec<TagInfo>, AppError> {
    let format = "%(refname:short)\t%(objectname)\t%(objecttype)\t%(*objectname)\t%(*objecttype)\t%(contents:subject)\t%(taggername)\t%(taggerdate:unix)\t%(taggeremail)";
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::ForEachRef, worktree)
                .arg(format!("--format={format}"))
                .arg("refs/tags"),
        )?
        .ensure_success()?;
    Ok(parse_tags(&outcome.stdout.text_lossy()))
}

fn parse_tags(text: &str) -> Vec<TagInfo> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 5 || fields[0].is_empty() {
                return None;
            }
            let annotated = fields[2] == "tag";
            let message = fields
                .get(5)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            let tagger = fields
                .get(6)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            let tagger_time = fields
                .get(7)
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| *value > 0);
            let tagger_email = fields
                .get(8)
                .map(|value| value.trim().trim_matches(['<', '>']).to_owned())
                .filter(|value| !value.is_empty());
            Some(TagInfo {
                name: fields[0].to_owned(),
                oid: fields[1].to_owned(),
                object_type: fields[2].to_owned(),
                annotated,
                target_oid: fields
                    .get(3)
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty()),
                message,
                tagger,
                tagger_email,
                tagger_time,
            })
        })
        .collect()
}

/// Create a tag. An empty message creates a lightweight tag; a message
/// creates an annotated tag and requires a tagger identity.
pub fn create_tag(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
    force: bool,
) -> Result<TagInfo, AppError> {
    validate_tag_name(runner, worktree, name)?;
    let target = target.unwrap_or("HEAD");
    crate::log::validate_revision(target)?;
    let trimmed = message.map(str::trim).filter(|value| !value.is_empty());
    let mut spec = CommandSpec::new(GitSubcommand::Tag, worktree);
    if force {
        spec = spec.arg("-f");
    }
    if let Some(message) = trimmed {
        spec = spec.arg("-a").arg(name).arg("-m").arg(message);
    } else {
        spec = spec.arg(name);
    }
    spec = spec.arg(target);
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        let stderr = outcome.stderr.text_lossy();
        if stderr.contains("AUTHOR") || stderr.contains("committer identity") {
            return Err(AppError::new(
                "tag.identity_missing",
                ErrorCategory::GitState,
                "Aucune identité Git n'est configurée pour signer le tag.",
            )
            .with_detail(stderr));
        }
        return Err(AppError::new(
            "tag.create_failed",
            ErrorCategory::GitState,
            "Le tag n'a pas pu être créé.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    list_tags(runner, worktree)?
        .into_iter()
        .find(|tag| tag.name == name)
        .ok_or_else(|| {
            AppError::internal(format!("le tag `{name}` est introuvable après création"))
        })
}

/// Commit a tag points at, peeled from the annotated object when needed.
fn tag_commit(runner: &GitRunner, worktree: &Path, name: &str) -> Result<String, AppError> {
    validate_tag_name(runner, worktree, name)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::RevParse, worktree)
            .arg("--verify")
            .arg(format!("refs/tags/{name}^{{commit}}")),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "tag.missing",
            ErrorCategory::GitState,
            "Le tag est introuvable.",
        )
        .with_detail(name.to_owned()));
    }
    Ok(outcome.stdout.text_lossy().trim().to_owned())
}

/// Turn a lightweight tag into an annotated one, keeping its commit.
pub fn annotate_tag(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    message: &str,
) -> Result<TagInfo, AppError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input(
            "Un tag annoté nécessite un message.".to_owned(),
        ));
    }
    let commit = tag_commit(runner, worktree, name)?;
    create_tag(runner, worktree, name, Some(trimmed), Some(&commit), true)
}

/// Move a tag forward to a descendant commit.
///
/// A tag only ever names an existing commit, so moving it is a fast-forward:
/// the current target must be an ancestor of the new one. The annotation, when
/// present, is preserved.
pub fn move_tag(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    target: &str,
) -> Result<TagInfo, AppError> {
    validate_tag_name(runner, worktree, name)?;
    crate::log::validate_revision(target)?;
    let current = tag_commit(runner, worktree, name)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::RevParse, worktree)
            .arg("--verify")
            .arg(format!("{target}^{{commit}}")),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "tag.unknown_target",
            ErrorCategory::Input,
            "La cible du tag est introuvable.",
        )
        .with_detail(target.to_owned()));
    }
    let next = outcome.stdout.text_lossy().trim().to_owned();
    if next == current {
        return list_tags(runner, worktree)?
            .into_iter()
            .find(|tag| tag.name == name)
            .ok_or_else(|| {
                AppError::new(
                    "tag.missing",
                    ErrorCategory::GitState,
                    "Le tag est introuvable.",
                )
                .with_detail(name.to_owned())
            });
    }
    // `target..current` empty ⇒ every commit reachable from the current target
    // is reachable from the new one: the move is a fast-forward.
    let behind = runner.run(
        &CommandSpec::new(GitSubcommand::RevList, worktree)
            .arg("--count")
            .arg(format!("{next}..{current}")),
    )?;
    if !behind.success() || behind.stdout.text_lossy().trim() != "0" {
        return Err(AppError::new(
            "tag.not_fast_forward",
            ErrorCategory::Input,
            "Un tag ne peut avancer que vers un commit descendant.",
        )
        .with_detail(format!("{current} → {next}")));
    }
    let message = list_tags(runner, worktree)?
        .into_iter()
        .find(|tag| tag.name == name)
        .and_then(|tag| tag.message);
    create_tag(
        runner,
        worktree,
        name,
        message.as_deref(),
        Some(&next),
        true,
    )
}

pub fn delete_tag(runner: &GitRunner, worktree: &Path, name: &str) -> Result<(), AppError> {
    validate_tag_name(runner, worktree, name)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Tag, worktree)
            .arg("-d")
            .arg(name),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "tag.delete_failed",
            ErrorCategory::GitState,
            "Le tag n'a pas pu être supprimé.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(())
}

pub fn push_tag(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    name: &str,
) -> Result<PushReport, AppError> {
    validate_remote_name(remote)?;
    validate_tag_name(runner, worktree, name)?;
    let reference = format!("refs/tags/{name}");
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Push, worktree)
            .arg("--progress")
            .arg(remote)
            .arg(&reference)
            .timeout(NETWORK_TIMEOUT),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "tag.push_failed",
            ErrorCategory::Network,
            "Le push du tag a échoué.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(PushReport {
        remote: remote.to_owned(),
        reference,
        stdout: outcome.stdout.text_lossy(),
        stderr: outcome.stderr.redacted(),
    })
}

/// Delete a tag on the remote only. The local tag is left in place, mirroring
/// The benchmark client's separate "delete from <remote>" action.
pub fn delete_tag_remote(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    name: &str,
) -> Result<PushReport, AppError> {
    validate_remote_name(remote)?;
    validate_tag_name(runner, worktree, name)?;
    let reference = format!("refs/tags/{name}");
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Push, worktree)
            .arg("--progress")
            .arg(remote)
            .arg(format!(":{reference}"))
            .timeout(NETWORK_TIMEOUT),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "tag.delete_remote_failed",
            ErrorCategory::Network,
            "Le tag n'a pas pu être supprimé du remote.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(PushReport {
        remote: remote.to_owned(),
        reference,
        stdout: outcome.stdout.text_lossy(),
        stderr: outcome.stderr.redacted(),
    })
}

pub fn list_remotes(runner: &GitRunner, worktree: &Path) -> Result<Vec<RemoteInfo>, AppError> {
    let outcome = runner
        .run(&CommandSpec::new(GitSubcommand::Remote, worktree).arg("-v"))?
        .ensure_success()?;
    Ok(parse_remotes(&outcome.stdout.text_lossy()))
}

fn parse_remotes(text: &str) -> Vec<RemoteInfo> {
    let mut remotes: Vec<RemoteInfo> = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else { continue };
        let Some(url) = fields.next() else { continue };
        let direction = fields.next().unwrap_or_default();
        let existing = remotes.iter_mut().find(|remote| remote.name == name);
        let remote = match existing {
            Some(remote) => remote,
            None => {
                remotes.push(RemoteInfo {
                    name: name.to_owned(),
                    fetch_url: None,
                    push_url: None,
                });
                remotes.last_mut().expect("just pushed")
            }
        };
        if direction == "(fetch)" {
            remote.fetch_url = Some(redact_remote_url(url));
        } else if direction == "(push)" {
            remote.push_url = Some(redact_remote_url(url));
        }
    }
    remotes
}

/// Hide an embedded password before a URL reaches the interface.
///
/// A repository configured outside BeeBranch may still carry
/// `https://user:secret@host`: the URL is displayed, so the secret never
/// leaves the backend.
fn redact_remote_url(url: &str) -> String {
    let Some((head, tail)) = url.split_once('@') else {
        return url.to_owned();
    };
    let (prefix, userinfo) = match head.rsplit_once("://") {
        Some((scheme, rest)) => (format!("{scheme}://"), rest),
        None => (String::new(), head),
    };
    match userinfo.split_once(':') {
        Some((user, _)) => format!("{prefix}{user}:***@{tail}"),
        None => url.to_owned(),
    }
}

pub fn add_remote(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    url: &str,
) -> Result<Vec<RemoteInfo>, AppError> {
    validate_remote_name(name)?;
    validate_remote_url(url)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("add")
            .arg(name)
            .arg(url),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "remote.add_failed",
            ErrorCategory::GitState,
            "Le remote n'a pas pu être ajouté.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    list_remotes(runner, worktree)
}

pub fn set_remote_url(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    url: &str,
    push: bool,
) -> Result<Vec<RemoteInfo>, AppError> {
    validate_remote_name(name)?;
    validate_remote_url(url)?;
    let mut spec = CommandSpec::new(GitSubcommand::Remote, worktree).arg("set-url");
    if push {
        spec = spec.arg("--push");
    }
    spec = spec.arg(name).arg(url);
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        return Err(AppError::new(
            "remote.set_url_failed",
            ErrorCategory::GitState,
            "L'URL du remote n'a pas pu être modifiée.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    list_remotes(runner, worktree)
}

pub fn remove_remote(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
) -> Result<Vec<RemoteInfo>, AppError> {
    validate_remote_name(name)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("remove")
            .arg(name),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "remote.remove_failed",
            ErrorCategory::GitState,
            "Le remote n'a pas pu être supprimé.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    list_remotes(runner, worktree)
}

pub fn prune_remote(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
) -> Result<Vec<RemoteInfo>, AppError> {
    validate_remote_name(name)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("prune")
            .arg(name)
            .timeout(NETWORK_TIMEOUT),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "remote.prune_failed",
            ErrorCategory::Network,
            "Le prune du remote a échoué.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    list_remotes(runner, worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags() {
        let text = "v1\t111\ttag\t222\tcommit\tRelease 1\tAlice\t1700000000\nlight\t333\tcommit\t\t\t\t\t\n";
        let tags = parse_tags(text);
        assert_eq!(tags.len(), 2);
        assert!(tags[0].annotated);
        assert_eq!(tags[0].target_oid.as_deref(), Some("222"));
        assert_eq!(tags[0].message.as_deref(), Some("Release 1"));
        assert!(!tags[1].annotated);
    }

    #[test]
    fn parses_remotes_and_rejects_credentials() {
        let text = "origin\thttps://example.test/a.git (fetch)\norigin\thttps://example.test/a.git (push)\n";
        let remotes = parse_remotes(text);
        assert_eq!(remotes.len(), 1);
        assert_eq!(
            remotes[0].fetch_url.as_deref(),
            Some("https://example.test/a.git")
        );
        assert_eq!(
            remotes[0].push_url.as_deref(),
            Some("https://example.test/a.git")
        );
        assert!(validate_remote_url("https://u:p@example.test/a.git").is_err());
        assert!(validate_remote_url("ext::sh -c evil").is_err());
        assert!(validate_remote_url("git@example.test:team/a.git").is_ok());
    }
}
