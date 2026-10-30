//! Branch, remote and tag enumeration via `for-each-ref`.

use std::path::Path;

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

const REF_FORMAT: &str = "%(refname)%09%(objectname)%09%(objecttype)%09%(upstream)%09%(HEAD)%09%(symref)%09%(*objectname)";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Branch,
    RemoteBranch,
    Tag,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    /// Full ref name (`refs/heads/main`).
    pub full_name: String,
    /// Short display name (`main`, `origin/main`, `v1.0`).
    pub name: String,
    pub kind: RefKind,
    pub target_oid: String,
    /// Object an annotated tag peels to (`%(*objectname)`); `None` when the ref
    /// already points at its object. The history view navigates a tag by this
    /// oid: the tag object itself is not a commit row.
    pub peeled_oid: Option<String>,
    pub object_type: String,
    pub upstream: Option<String>,
    pub is_head: bool,
    pub remote: Option<String>,
    /// Target of a symbolic ref such as `refs/remotes/origin/HEAD`.
    pub symref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUrl {
    pub name: String,
    pub url: String,
    /// `fetch` or `push`.
    pub direction: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub head: Option<HeadRef>,
    pub entries: Vec<RefEntry>,
    pub remotes: Vec<String>,
    pub remote_urls: Vec<RemoteUrl>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadRef {
    pub full_name: String,
    pub name: String,
    pub oid: Option<String>,
}

/// Read every ref plus HEAD.
pub fn read_refs(runner: &GitRunner, worktree: &Path) -> Result<RefsSnapshot, AppError> {
    let spec =
        CommandSpec::new(GitSubcommand::ForEachRef, worktree).arg(format!("--format={REF_FORMAT}"));
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    let mut snapshot = parse_refs(&outcome.stdout.text_lossy())
        .map_err(|message| AppError::internal(format!("for-each-ref: {message}")))?;

    let remotes = runner.run(&CommandSpec::new(GitSubcommand::Remote, worktree).arg("-v"))?;
    if remotes.success() {
        snapshot.remote_urls = parse_remote_urls(&remotes.stdout.text_lossy());
    }
    Ok(snapshot)
}

/// Parse `git remote -v` output.
pub fn parse_remote_urls(input: &str) -> Vec<RemoteUrl> {
    let mut urls = Vec::new();
    for line in input.lines() {
        let mut fields = line.splitn(2, '\t');
        let Some(name) = fields.next().filter(|name| !name.is_empty()) else {
            continue;
        };
        let Some(rest) = fields.next() else {
            continue;
        };
        let (url, direction) = if let Some(url) = rest.strip_suffix(" (fetch)") {
            (url, "fetch")
        } else if let Some(url) = rest.strip_suffix(" (push)") {
            (url, "push")
        } else {
            continue;
        };
        urls.push(RemoteUrl {
            name: name.to_owned(),
            url: url.to_owned(),
            direction: direction.to_owned(),
        });
    }
    urls
}

/// Parse the tab-separated `for-each-ref` output.
pub fn parse_refs(input: &str) -> Result<RefsSnapshot, String> {
    let mut snapshot = RefsSnapshot::default();

    for line in input.lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 {
            return Err(format!("ligne for-each-ref incomplète: {line:?}"));
        }
        let full_name = fields[0];
        let target_oid = fields[1].to_owned();
        let object_type = fields[2].to_owned();
        let upstream = non_empty(fields[3]);
        let is_head = fields[4].trim() == "*";
        let symref = non_empty(fields[5]);
        let peeled_oid = non_empty(fields[6]);

        let (kind, name, remote) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
            (RefKind::Branch, name.to_owned(), None)
        } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
            let remote = name.split('/').next().map(str::to_owned);
            (RefKind::RemoteBranch, name.to_owned(), remote)
        } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
            (RefKind::Tag, name.to_owned(), None)
        } else {
            (RefKind::Other, full_name.to_owned(), None)
        };

        if is_head {
            snapshot.head = Some(HeadRef {
                full_name: full_name.to_owned(),
                name: name.clone(),
                oid: Some(target_oid.clone()),
            });
        }

        if let Some(remote) = &remote {
            if !snapshot.remotes.contains(remote) {
                snapshot.remotes.push(remote.clone());
            }
        }

        snapshot.entries.push(RefEntry {
            full_name: full_name.to_owned(),
            name,
            kind,
            target_oid,
            peeled_oid,
            object_type,
            upstream,
            is_head,
            remote,
            symref,
        });
    }

    snapshot.remotes.sort();
    Ok(snapshot)
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
refs/heads/main\tabc123\tcommit\trefs/remotes/origin/main\t*\t\t
refs/remotes/origin/HEAD\tabc123\tcommit\t\t\trefs/remotes/origin/main\t
refs/remotes/origin/main\tabc123\tcommit\t\t\t\t
refs/tags/v1.0\tdef456\ttag\t\t\t\t789abc
";

    #[test]
    fn parses_branches_remotes_and_tags() {
        let snapshot = parse_refs(SAMPLE).expect("parse");
        assert_eq!(snapshot.entries.len(), 4);
        assert_eq!(snapshot.remotes, vec!["origin"]);
        assert_eq!(
            snapshot.head.as_ref().map(|head| head.name.as_str()),
            Some("main")
        );

        let branch = &snapshot.entries[0];
        assert_eq!(branch.kind, RefKind::Branch);
        assert_eq!(branch.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert!(branch.is_head);
        assert_eq!(branch.peeled_oid, None);

        let remote_head = &snapshot.entries[1];
        assert_eq!(
            remote_head.symref.as_deref(),
            Some("refs/remotes/origin/main")
        );
        assert_eq!(remote_head.remote.as_deref(), Some("origin"));

        assert_eq!(snapshot.entries[3].kind, RefKind::Tag);
        // An annotated tag points at a tag object; the commit it peels to is
        // what the history view can reveal.
        assert_eq!(snapshot.entries[3].target_oid, "def456");
        assert_eq!(snapshot.entries[3].peeled_oid.as_deref(), Some("789abc"));
    }

    #[test]
    fn rejects_truncated_lines() {
        assert!(parse_refs("refs/heads/main\tabc").is_err());
    }

    #[test]
    fn parses_remote_urls() {
        let input = "origin\thttps://gitlab.example.test/group/app.git (fetch)\n\
                     origin\thttps://gitlab.example.test/group/app.git (push)\n";
        let urls = parse_remote_urls(input);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].name, "origin");
        assert_eq!(urls[0].direction, "fetch");
        assert_eq!(urls[1].direction, "push");
    }

    #[test]
    fn deduplicates_remotes() {
        let input = "refs/remotes/origin/a\t1\tcommit\t\t\t\t\n\
                     refs/remotes/origin/b\t2\tcommit\t\t\t\t\n\
                     refs/remotes/upstream/c\t3\tcommit\t\t\t\t\n";
        let snapshot = parse_refs(input).expect("parse");
        assert_eq!(snapshot.remotes, vec!["origin", "upstream"]);
    }
}
