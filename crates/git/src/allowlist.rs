use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Component, Path};

use crate::error::GitError;
use crate::redaction;

/// Git subcommands the process layer is allowed to execute.
///
/// The enum is the allowlist. Adding a variant is an explicit, reviewable
/// decision; no subcommand can be built from a free-form string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitSubcommand {
    Version,
    Lfs,
    RevParse,
    RevList,
    WriteTree,
    ReadTree,
    UpdateRef,
    CheckRefFormat,
    LsFiles,
    Init,
    Clone,
    FastImport,
    Status,
    ForEachRef,
    Log,
    Show,
    DiffTree,
    Diff,
    Blame,
    CatFile,
    Add,
    Rm,
    Restore,
    Apply,
    Commit,
    Switch,
    Branch,
    Fetch,
    Pull,
    Push,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Reset,
    Stash,
    Worktree,
    Submodule,
    Tag,
    Remote,
    LsRemote,
    Config,
    Grep,
}

impl GitSubcommand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Lfs => "lfs",
            Self::RevParse => "rev-parse",
            Self::RevList => "rev-list",
            Self::WriteTree => "write-tree",
            Self::ReadTree => "read-tree",
            Self::UpdateRef => "update-ref",
            Self::CheckRefFormat => "check-ref-format",
            Self::LsFiles => "ls-files",
            Self::Init => "init",
            Self::Clone => "clone",
            Self::FastImport => "fast-import",
            Self::Status => "status",
            Self::ForEachRef => "for-each-ref",
            Self::Log => "log",
            Self::Show => "show",
            Self::DiffTree => "diff-tree",
            Self::Diff => "diff",
            Self::Blame => "blame",
            Self::CatFile => "cat-file",
            Self::Add => "add",
            Self::Rm => "rm",
            Self::Restore => "restore",
            Self::Apply => "apply",
            Self::Commit => "commit",
            Self::Switch => "switch",
            Self::Branch => "branch",
            Self::Fetch => "fetch",
            Self::Pull => "pull",
            Self::Push => "push",
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
            Self::Reset => "reset",
            Self::Stash => "stash",
            Self::Worktree => "worktree",
            Self::Submodule => "submodule",
            Self::Tag => "tag",
            Self::Remote => "remote",
            Self::LsRemote => "ls-remote",
            Self::Config => "config",
            Self::Grep => "grep",
        }
    }

    /// Read-only subcommands receive `--no-optional-locks`.
    pub(crate) const fn is_read_only(self) -> bool {
        matches!(
            self,
            Self::Version
                | Self::Lfs
                | Self::RevParse
                | Self::RevList
                | Self::CheckRefFormat
                | Self::LsFiles
                | Self::Status
                | Self::ForEachRef
                | Self::Log
                | Self::Show
                | Self::DiffTree
                | Self::Diff
                | Self::Blame
                | Self::CatFile
                | Self::LsRemote
                | Self::Grep
        )
    }

    const fn allows_positionals(self) -> bool {
        !matches!(self, Self::Version)
    }
}

impl fmt::Display for GitSubcommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueRule {
    /// Exact flag, no value.
    None,
    /// Exact option whose value is the next argument.
    Next,
    /// Option requiring an inline `=value`.
    Inline,
    /// Exact flag, or inline `=value`.
    OptionalInline,
}

#[derive(Debug, Clone, Copy)]
struct Rule {
    name: &'static str,
    value: ValueRule,
}

const fn flag(name: &'static str) -> Rule {
    Rule {
        name,
        value: ValueRule::None,
    }
}

const fn value(name: &'static str) -> Rule {
    Rule {
        name,
        value: ValueRule::Next,
    }
}

const fn inline(name: &'static str) -> Rule {
    Rule {
        name,
        value: ValueRule::Inline,
    }
}

const fn optional_inline(name: &'static str) -> Rule {
    Rule {
        name,
        value: ValueRule::OptionalInline,
    }
}

impl GitSubcommand {
    fn rules(self) -> &'static [Rule] {
        match self {
            Self::Version => const { &[flag("--build-options")] },
            Self::Lfs => const { &[] },
            Self::RevParse => {
                const {
                    &[
                        flag("--show-toplevel"),
                        flag("--absolute-git-dir"),
                        flag("--git-common-dir"),
                        flag("--git-dir"),
                        flag("--is-bare-repository"),
                        flag("--is-inside-work-tree"),
                        flag("--is-inside-git-dir"),
                        flag("--is-shallow-repository"),
                        flag("--show-superproject-working-tree"),
                        flag("--show-cdup"),
                        flag("--show-prefix"),
                        flag("--show-object-format"),
                        flag("--verify"),
                        flag("--quiet"),
                        flag("-q"),
                        flag("--symbolic"),
                        flag("--symbolic-full-name"),
                        optional_inline("--abbrev-ref"),
                        optional_inline("--short"),
                        inline("--path-format"),
                        value("--git-path"),
                        value("--default"),
                        value("--resolve-git-dir"),
                    ]
                }
            }
            Self::RevList => {
                const {
                    &[
                        flag("--count"),
                        flag("--all"),
                        flag("--left-right"),
                        flag("--no-merges"),
                        flag("--first-parent"),
                        flag("--reverse"),
                        inline("--max-count"),
                        value("-n"),
                    ]
                }
            }
            Self::WriteTree => const { &[] },
            Self::ReadTree => {
                const {
                    &[
                        flag("--empty"),
                        flag("--reset"),
                        flag("-m"),
                        flag("-u"),
                        flag("--no-sparse-checkout"),
                    ]
                }
            }
            Self::UpdateRef => {
                const { &[flag("-d"), flag("--no-deref"), flag("--stdin"), flag("-z")] }
            }
            Self::CheckRefFormat => {
                const {
                    &[
                        flag("--branch"),
                        flag("--allow-onelevel"),
                        flag("--no-allow-onelevel"),
                        flag("--refspec-pattern"),
                        flag("--normalize"),
                    ]
                }
            }
            Self::LsFiles => {
                const {
                    &[
                        flag("-z"),
                        flag("--error-unmatch"),
                        flag("--cached"),
                        flag("--stage"),
                        flag("--deleted"),
                        flag("--modified"),
                        flag("--others"),
                        flag("--ignored"),
                        inline("--exclude-standard"),
                    ]
                }
            }
            Self::Init => const { &[flag("--quiet"), flag("--bare"), inline("--initial-branch")] },
            Self::Clone => {
                const {
                    &[
                        flag("--progress"),
                        flag("--quiet"),
                        flag("--verbose"),
                        flag("--single-branch"),
                        flag("--no-single-branch"),
                        flag("--shallow-submodules"),
                        flag("--no-tags"),
                        flag("--tags"),
                        flag("--no-checkout"),
                        optional_inline("--recurse-submodules"),
                        inline("--depth"),
                        inline("--filter"),
                        value("--branch"),
                        value("-b"),
                        value("--origin"),
                    ]
                }
            }
            Self::FastImport => const { &[flag("--quiet"), flag("--force"), flag("--done")] },
            Self::Status => {
                const {
                    &[
                        flag("--porcelain=v2"),
                        flag("-z"),
                        flag("--branch"),
                        flag("--untracked-files=all"),
                        flag("--untracked-files=normal"),
                        flag("--ignore-submodules=none"),
                        flag("--ignore-submodules=all"),
                        flag("--find-renames"),
                        flag("--no-renames"),
                        flag("--show-stash"),
                        flag("--ignored=no"),
                        flag("--ignored=matching"),
                        flag("--ignored"),
                    ]
                }
            }
            Self::ForEachRef => {
                const {
                    &[
                        inline("--format"),
                        inline("--sort"),
                        inline("--count"),
                        inline("--points-at"),
                        inline("--merged"),
                        inline("--no-merged"),
                        inline("--contains"),
                        inline("--no-contains"),
                    ]
                }
            }
            Self::Log => {
                const {
                    &[
                        flag("--parents"),
                        flag("--date-order"),
                        flag("--topo-order"),
                        flag("--reverse"),
                        flag("--first-parent"),
                        flag("--all"),
                        flag("--not"),
                        flag("--name-status"),
                        flag("--name-only"),
                        flag("--no-renames"),
                        flag("--follow"),
                        flag("--no-walk"),
                        flag("--fixed-strings"),
                        flag("--regexp-ignore-case"),
                        flag("-i"),
                        inline("--format"),
                        inline("--max-count"),
                        inline("--skip"),
                        inline("--since"),
                        inline("--until"),
                        inline("--author"),
                        inline("--grep"),
                        inline("--diff-filter"),
                        flag("-z"),
                        flag("-M"),
                        flag("--find-renames"),
                        value("-n"),
                    ]
                }
            }
            Self::Show => {
                const {
                    &[
                        flag("-s"),
                        flag("--no-patch"),
                        flag("--name-status"),
                        flag("--name-only"),
                        flag("--stat"),
                        flag("--numstat"),
                        flag("-z"),
                        flag("--no-renames"),
                        inline("--format"),
                    ]
                }
            }
            Self::DiffTree => {
                const {
                    &[
                        flag("--no-commit-id"),
                        flag("--name-status"),
                        flag("--name-only"),
                        flag("--numstat"),
                        flag("-r"),
                        flag("-z"),
                        flag("--root"),
                        flag("--no-renames"),
                        flag("-M"),
                        flag("--find-renames"),
                        flag("-p"),
                        flag("--patch"),
                    ]
                }
            }
            Self::Diff => {
                const {
                    &[
                        flag("--no-color"),
                        flag("--no-ext-diff"),
                        flag("--no-textconv"),
                        flag("--cached"),
                        flag("--staged"),
                        flag("--stat"),
                        flag("--name-status"),
                        flag("--name-only"),
                        flag("--numstat"),
                        flag("-z"),
                        flag("--no-renames"),
                        inline("--unified"),
                        value("-U"),
                    ]
                }
            }
            Self::Blame => {
                const {
                    &[
                        flag("--line-porcelain"),
                        flag("-w"),
                        flag("--root"),
                        value("-L"),
                    ]
                }
            }
            Self::CatFile => {
                const {
                    &[
                        flag("-t"),
                        flag("-s"),
                        flag("-e"),
                        flag("-p"),
                        flag("--batch"),
                        flag("--batch-check"),
                    ]
                }
            }
            Self::Add => {
                const {
                    &[
                        flag("-A"),
                        flag("--all"),
                        flag("-u"),
                        flag("--update"),
                        flag("-N"),
                        flag("--intent-to-add"),
                        flag("-f"),
                        flag("--force"),
                    ]
                }
            }
            Self::Rm => const { &[flag("--cached"), flag("-r"), flag("--quiet"), flag("-q")] },
            Self::Restore => {
                const {
                    &[
                        flag("--staged"),
                        flag("-S"),
                        flag("--worktree"),
                        flag("-W"),
                        inline("--source"),
                        value("-s"),
                    ]
                }
            }
            Self::Apply => {
                const {
                    &[
                        flag("--cached"),
                        flag("--index"),
                        flag("--reverse"),
                        flag("-R"),
                        flag("--recount"),
                        flag("--check"),
                        flag("--3way"),
                        flag("-3"),
                        flag("--whitespace=nowarn"),
                    ]
                }
            }
            Self::Commit => {
                const {
                    &[
                        value("-F"),
                        inline("--file"),
                        flag("--amend"),
                        flag("--no-edit"),
                        flag("--allow-empty"),
                        flag("--allow-empty-message"),
                        flag("--cleanup=strip"),
                    ]
                }
            }
            Self::Switch => {
                const {
                    &[
                        value("-c"),
                        value("--create"),
                        value("-C"),
                        value("--force-create"),
                        value("--orphan"),
                        flag("--detach"),
                        flag("-d"),
                        flag("-f"),
                        flag("--force"),
                        flag("--guess"),
                        flag("--no-guess"),
                        flag("--track"),
                        flag("-t"),
                        flag("--no-track"),
                    ]
                }
            }
            Self::Branch => {
                const {
                    &[
                        flag("-d"),
                        flag("-D"),
                        flag("-m"),
                        flag("-M"),
                        flag("-a"),
                        flag("-r"),
                        flag("-v"),
                        flag("-vv"),
                        flag("--list"),
                        flag("--show-current"),
                        flag("--unset-upstream"),
                        inline("--format"),
                        inline("--contains"),
                        inline("--no-contains"),
                        optional_inline("--merged"),
                        optional_inline("--no-merged"),
                        inline("--points-at"),
                        inline("--sort"),
                        inline("--set-upstream-to"),
                        value("-u"),
                    ]
                }
            }
            Self::Fetch => {
                const {
                    &[
                        flag("--prune"),
                        flag("-p"),
                        flag("--progress"),
                        flag("--all"),
                        flag("--tags"),
                        flag("--no-tags"),
                        flag("--prune-tags"),
                        flag("--force"),
                        flag("-f"),
                        flag("--dry-run"),
                        flag("--quiet"),
                        flag("-q"),
                        flag("--atomic"),
                        flag("--no-recurse-submodules"),
                        inline("--depth"),
                    ]
                }
            }
            Self::Pull => {
                const {
                    &[
                        flag("--progress"),
                        flag("--ff-only"),
                        flag("--rebase"),
                        flag("--no-rebase"),
                        flag("--autostash"),
                        flag("--no-autostash"),
                        flag("--ff"),
                        flag("--no-ff"),
                    ]
                }
            }
            Self::Push => {
                const {
                    &[
                        flag("--progress"),
                        flag("--set-upstream"),
                        flag("-u"),
                        flag("--delete"),
                        flag("-d"),
                        flag("--tags"),
                        flag("--dry-run"),
                        flag("-n"),
                        inline("--force-with-lease"),
                    ]
                }
            }
            Self::Merge => {
                const {
                    &[
                        value("-m"),
                        inline("--message"),
                        flag("--no-edit"),
                        flag("--ff-only"),
                        flag("--no-ff"),
                        flag("--ff"),
                        flag("--squash"),
                        flag("--abort"),
                        flag("--continue"),
                        flag("--quit"),
                        flag("--no-commit"),
                    ]
                }
            }
            Self::Rebase => {
                const {
                    &[
                        flag("--interactive"),
                        flag("-i"),
                        flag("--autosquash"),
                        flag("--update-refs"),
                        flag("--no-update-refs"),
                        flag("--continue"),
                        flag("--skip"),
                        flag("--abort"),
                        flag("--quit"),
                        flag("--autostash"),
                        flag("--no-autostash"),
                        flag("--no-edit"),
                        flag("--no-autosquash"),
                        flag("--keep-empty"),
                        flag("--root"),
                        flag("--rebase-merges"),
                        flag("--no-rebase-merges"),
                        inline("--empty"),
                        value("--onto"),
                    ]
                }
            }
            Self::CherryPick | Self::Revert => {
                const {
                    &[
                        flag("--continue"),
                        flag("--skip"),
                        flag("--abort"),
                        flag("--quit"),
                        flag("--no-commit"),
                        flag("-n"),
                        flag("--edit"),
                        flag("-e"),
                        flag("--no-edit"),
                    ]
                }
            }
            Self::Reset => {
                const {
                    &[
                        flag("--soft"),
                        flag("--mixed"),
                        flag("--hard"),
                        flag("--keep"),
                        flag("--merge"),
                    ]
                }
            }
            Self::Stash => {
                const {
                    &[
                        value("-m"),
                        inline("--message"),
                        flag("--include-untracked"),
                        flag("-u"),
                        flag("--all"),
                        flag("-a"),
                        flag("--index"),
                        flag("--keep-index"),
                        flag("--no-keep-index"),
                        flag("--staged"),
                        flag("--list"),
                        flag("--drop"),
                        flag("--apply"),
                        flag("--pop"),
                        flag("--quiet"),
                        inline("--format"),
                    ]
                }
            }
            Self::Worktree => {
                const {
                    &[
                        flag("--porcelain"),
                        flag("--force"),
                        flag("-f"),
                        flag("--detach"),
                        flag("--lock"),
                        flag("--unlock"),
                        flag("--prune"),
                        flag("--dry-run"),
                        flag("--no-checkout"),
                        flag("--all"),
                        inline("--reason"),
                        inline("--expire"),
                        value("-b"),
                    ]
                }
            }
            Self::Submodule => {
                const {
                    &[
                        flag("--recursive"),
                        flag("--porcelain"),
                        flag("--init"),
                        flag("--remote"),
                        flag("--force"),
                        flag("--checkout"),
                        flag("--merge"),
                        flag("--rebase"),
                        flag("--quiet"),
                        inline("--depth"),
                        flag("--summary-limit=0"),
                        value("-b"),
                        value("--branch"),
                    ]
                }
            }
            Self::Tag => {
                const {
                    &[
                        flag("-a"),
                        flag("-d"),
                        flag("--delete"),
                        flag("-l"),
                        flag("--list"),
                        flag("-f"),
                        flag("--force"),
                        flag("--no-sign"),
                        value("-m"),
                        inline("--message"),
                        inline("--format"),
                        inline("--sort"),
                    ]
                }
            }
            Self::Remote => {
                const {
                    &[
                        flag("-v"),
                        flag("--verbose"),
                        flag("--prune"),
                        flag("--push"),
                        flag("--add"),
                        flag("--delete"),
                        flag("--dry-run"),
                        flag("--tags"),
                        flag("--no-tags"),
                    ]
                }
            }
            Self::LsRemote => {
                const {
                    &[
                        flag("--heads"),
                        flag("--tags"),
                        flag("--refs"),
                        flag("--symref"),
                        flag("--get-url"),
                    ]
                }
            }
            Self::Grep => {
                const {
                    &[
                        flag("-n"),
                        flag("-I"),
                        flag("--no-color"),
                        flag("--fixed-strings"),
                        flag("-F"),
                        flag("-i"),
                        flag("--regexp-ignore-case"),
                        flag("--name-only"),
                        flag("-l"),
                        inline("--max-count"),
                        value("-e"),
                        value("-m"),
                    ]
                }
            }
            Self::Config => {
                const {
                    &[
                        flag("--get"),
                        flag("--get-all"),
                        flag("--get-regexp"),
                        flag("--unset"),
                        flag("--unset-all"),
                        flag("--add"),
                        flag("--replace-all"),
                        flag("--list"),
                        flag("-l"),
                        flag("--local"),
                        flag("--global"),
                        flag("--system"),
                        flag("--worktree"),
                        flag("-z"),
                        flag("--null"),
                        flag("--name-only"),
                        flag("--show-origin"),
                        flag("--show-scope"),
                        flag("--bool"),
                        flag("--int"),
                        flag("--path"),
                        inline("--type"),
                        inline("--default"),
                    ]
                }
            }
        }
    }
}

/// Validate the subcommand arguments against the allowlist.
///
/// The function never mutates or rewrites arguments: it either accepts the
/// exact argv that will be passed to Git, or rejects it with a stable code.
pub(crate) fn validate(subcommand: GitSubcommand, args: &[OsString]) -> Result<(), GitError> {
    let rules = subcommand.rules();
    let mut after_separator = false;
    let mut expect_value = false;
    let mut index = 0;

    while index < args.len() {
        let argument = &args[index];
        reject_nul(argument)?;

        if expect_value {
            expect_value = false;
            index += 1;
            continue;
        }

        if after_separator {
            validate_path_argument(argument)?;
            index += 1;
            continue;
        }

        let Some(text) = argument.to_str() else {
            return Err(reject(argument, "argument non UTF-8 avant `--`"));
        };

        if text == "--" {
            after_separator = true;
            index += 1;
            continue;
        }

        if text.starts_with('-') {
            let Some(rule) = rules.iter().find(|rule| matches_rule(**rule, text)) else {
                return Err(reject(argument, "option non autorisée"));
            };
            if rule.value == ValueRule::Next {
                expect_value = true;
            }
        } else if !subcommand.allows_positionals() {
            return Err(reject(argument, "argument positionnel non autorisé"));
        }

        index += 1;
    }

    if expect_value {
        return Err(GitError::invalid_argument(format!(
            "valeur manquante pour la dernière option de `{}`",
            subcommand.as_str()
        )));
    }

    Ok(())
}

fn matches_rule(rule: Rule, text: &str) -> bool {
    let has_inline_value = text.len() > rule.name.len()
        && text.starts_with(rule.name)
        && text.as_bytes()[rule.name.len()] == b'=';

    match rule.value {
        ValueRule::None | ValueRule::Next => text == rule.name,
        ValueRule::Inline => has_inline_value,
        ValueRule::OptionalInline => text == rule.name || has_inline_value,
    }
}

fn reject_nul(argument: &OsStr) -> Result<(), GitError> {
    if argument.to_string_lossy().contains('\0') {
        return Err(reject(argument, "caractère NUL interdit"));
    }
    Ok(())
}

fn validate_path_argument(argument: &OsStr) -> Result<(), GitError> {
    let path = Path::new(argument);
    if path.as_os_str().is_empty() {
        return Err(reject(argument, "chemin vide"));
    }
    if path.is_absolute() {
        return Err(reject(argument, "chemin absolu interdit après `--`"));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(reject(argument, "remontée `..` interdite"));
            }
            Component::Normal(name) if name == OsStr::new(".git") => {
                return Err(reject(argument, "accès direct à `.git` interdit"));
            }
            _ => {}
        }
    }
    Ok(())
}

fn reject(argument: &OsStr, reason: &str) -> GitError {
    let shown = redaction::redact(&argument.to_string_lossy()).into_owned();
    let shown: String = shown.chars().take(200).collect();
    GitError::invalid_argument(format!("{reason} : {shown}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_documented_options() {
        assert!(validate(
            GitSubcommand::Status,
            &args(&["--porcelain=v2", "-z", "--branch", "--untracked-files=all"])
        )
        .is_ok());
        assert!(validate(
            GitSubcommand::Log,
            &args(&[
                "--date-order",
                "--parents",
                "--format=%H%x1f%P",
                "--max-count=500"
            ])
        )
        .is_ok());
        assert!(validate(
            GitSubcommand::RevParse,
            &args(&[
                "--show-toplevel",
                "--git-common-dir",
                "--is-bare-repository"
            ])
        )
        .is_ok());
    }

    #[test]
    fn accepts_benchmark_subcommands() {
        assert!(validate(
            GitSubcommand::Init,
            &args(&["--quiet", "--initial-branch=main"])
        )
        .is_ok());
        assert!(validate(GitSubcommand::RevList, &args(&["--count", "HEAD"])).is_ok());
        assert!(validate(GitSubcommand::FastImport, &args(&["--quiet", "--force"])).is_ok());
        assert!(validate(
            GitSubcommand::Merge,
            &args(&["--no-ff", "-m", "fusion", "branche"])
        )
        .is_ok());
        assert!(validate(GitSubcommand::Merge, &args(&["-m"])).is_err());
    }

    #[test]
    fn rejects_unknown_options() {
        assert_eq!(
            validate(GitSubcommand::Status, &args(&["--format=%H"]))
                .expect_err("must reject")
                .code(),
            crate::GitErrorCode::InvalidArgument
        );
        assert!(validate(GitSubcommand::Status, &args(&["--exec-path=/tmp"])).is_err());
        assert!(validate(GitSubcommand::Status, &args(&["--no-pager"])).is_err());
        assert!(validate(GitSubcommand::Status, &args(&["-c"])).is_err());
    }

    #[test]
    fn rejects_missing_option_values() {
        assert!(validate(GitSubcommand::Commit, &args(&["-F"])).is_err());
        assert!(validate(GitSubcommand::RevParse, &args(&["--git-path"])).is_err());
    }

    #[test]
    fn rejects_positionals_for_version() {
        assert!(validate(GitSubcommand::Version, &args(&["unexpected"])).is_err());
        assert!(validate(GitSubcommand::Version, &args(&["--build-options"])).is_ok());
    }

    #[test]
    fn rejects_unsafe_paths_after_separator() {
        assert!(validate(GitSubcommand::Add, &args(&["--", "../escape"])).is_err());
        assert!(validate(GitSubcommand::Add, &args(&["--", "src/../../escape"])).is_err());
        assert!(validate(GitSubcommand::Add, &args(&["--", ".git/config"])).is_err());
        let absolute = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };
        assert!(validate(GitSubcommand::Add, &args(&["--", absolute])).is_err());
        assert!(validate(GitSubcommand::Add, &args(&["--", ""])).is_err());
    }

    #[test]
    fn accepts_relative_paths_including_shell_metacharacters() {
        assert!(validate(
            GitSubcommand::Add,
            &args(&["--", "a b; touch pwned", "quote\" ' `id` $HOME"])
        )
        .is_ok());
    }

    #[test]
    fn values_are_consumed_without_being_parsed_as_options() {
        assert!(validate(GitSubcommand::Commit, &args(&["-F", "--not-an-option"])).is_ok());
    }

    #[test]
    fn duplicates_are_not_silently_accepted_as_commands() {
        assert!(validate(GitSubcommand::Version, &args(&["--upload-pack=x"])).is_err());
    }
}
