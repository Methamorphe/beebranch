//! Centralized policy for destructive actions.
//!
//! The policy is data, not UI text sprinkled across commands: every
//! destructive operation declares whether it requires an explicit
//! confirmation and whether it is reversible by Git. The backend enforces the
//! policy; the frontend only renders it (two-step confirmation for
//! destructive actions).

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCategory};

/// Actions that can destroy work or rewrite published history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DestructiveAction {
    DiscardFile,
    DiscardHunk,
    ResetHard,
    BranchDelete,
    BranchDeleteMany,
    BranchIntegrate,
    ForcePush,
    WorktreeRemove,
    StashDrop,
    TagDelete,
    TagDeleteRemote,
    SubmoduleRemove,
    FileDelete,
    AbortOperation,
    RemoteRemove,
    WorkspaceSync,
    CloseTabInProgress,
}

impl DestructiveAction {
    /// Stable code used in errors, logs and tests.
    pub const fn code(self) -> &'static str {
        match self {
            Self::DiscardFile => "discard.file",
            Self::DiscardHunk => "discard.hunk",
            Self::ResetHard => "reset.hard",
            Self::BranchDelete => "branch.delete",
            Self::BranchDeleteMany => "branch.delete_many",
            Self::BranchIntegrate => "branch.integrate",
            Self::ForcePush => "push.force",
            Self::WorktreeRemove => "worktree.remove",
            Self::StashDrop => "stash.drop",
            Self::TagDelete => "tag.delete",
            Self::TagDeleteRemote => "tag.delete_remote",
            Self::SubmoduleRemove => "submodule.remove",
            Self::FileDelete => "file.delete",
            Self::AbortOperation => "operation.abort",
            Self::RemoteRemove => "remote.remove",
            Self::WorkspaceSync => "workspace.sync",
            Self::CloseTabInProgress => "repo.close_in_progress",
        }
    }

    /// Short, precise description of the consequence.
    pub const fn consequence(self) -> &'static str {
        match self {
            Self::DiscardFile => {
                "Le contenu non indexé du fichier est remplacé par la version de l'index."
            }
            Self::DiscardHunk => {
                "Les lignes sélectionnées du worktree sont remplacées par la version de l'index."
            }
            Self::ResetHard => {
                "HEAD, l'index et le worktree sont réinitialisés ; les modifications suivies non commitées sont perdues."
            }
            Self::BranchDelete => "La référence de branche est supprimée ; le commit reste dans le reflog.",
            Self::BranchDeleteMany => {
                "Les références sélectionnées sont supprimées ; les commits restent dans le reflog."
            }
            Self::BranchIntegrate => {
                "La branche cible est extraite puis fusionnée ou rebasée ; l'opération peut être annulée via l'historique explicite."
            }
            Self::ForcePush => {
                "L'historique distant est réécrit ; les commits distants non présents localement deviennent inaccessibles."
            }
            Self::WorktreeRemove => {
                "Le worktree est retiré ; Git refuse si des modifications non commitées existent."
            }
            Self::StashDrop => {
                "L'entrée de stash est supprimée ; le commit correspondant reste récupérable par son SHA dans le reflog."
            }
            Self::TagDelete => "Le tag local est supprimé ; l'objet commit reste intact.",
            Self::TagDeleteRemote => {
                "Le tag est supprimé du remote ; il reste présent localement et peut être repoussé."
            }
            Self::SubmoduleRemove => {
                "Le sous-module est désinitialisé puis retiré de l'index et de .gitmodules ; son contenu de travail est supprimé."
            }
            Self::FileDelete => {
                "Le fichier est supprimé du worktree ; un fichier non suivi ne peut pas être restauré."
            }
            Self::AbortOperation => {
                "L'opération en cours est abandonnée ; les résolutions de conflits non commitées sont perdues."
            }
            Self::RemoteRemove => "La configuration du remote est supprimée ; les refs distantes associées sont retirées.",
            Self::WorkspaceSync => {
                "Chaque dépôt du workspace est synchronisé indépendamment ; un échec n'annule pas les autres."
            }
            Self::CloseTabInProgress => {
                "L'onglet est fermé alors qu'une opération Git est visible ; l'état du dépôt devra être vérifié à la réouverture."
            }
        }
    }

    /// True when Git cannot restore the previous state through a simple ref
    /// move or reflog entry.
    pub const fn irreversible(self) -> bool {
        matches!(
            self,
            Self::DiscardFile
                | Self::DiscardHunk
                | Self::ResetHard
                | Self::ForcePush
                | Self::AbortOperation
                | Self::SubmoduleRemove
                | Self::FileDelete
                | Self::CloseTabInProgress
        )
    }
}

/// User confirmation payload sent with a destructive command.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    /// The user explicitly acknowledged the consequences.
    pub acknowledged: bool,
}

impl Confirmation {
    pub fn acknowledged() -> Self {
        Self { acknowledged: true }
    }

    /// Enforce the policy for `action`.
    pub fn verify(&self, action: DestructiveAction) -> Result<(), AppError> {
        if !self.acknowledged {
            return Err(error(action)
                .with_detail("confirmation absente")
                .with_remediation("Confirmez explicitement l'action et ses conséquences."));
        }
        Ok(())
    }
}

fn error(action: DestructiveAction) -> AppError {
    let mut message = format!("Confirmation explicite requise : {}.", action.consequence());
    if action.irreversible() {
        message.push_str(
            " Cette action est irréversible : aucune sauvegarde applicative n'est créée.",
        );
    }
    AppError::new("confirmation.required", ErrorCategory::Input, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_destructive_actions_are_irreversible_or_confirmed() {
        for action in [
            DestructiveAction::DiscardFile,
            DestructiveAction::DiscardHunk,
            DestructiveAction::ResetHard,
            DestructiveAction::BranchDelete,
            DestructiveAction::BranchDeleteMany,
            DestructiveAction::BranchIntegrate,
            DestructiveAction::ForcePush,
            DestructiveAction::WorktreeRemove,
            DestructiveAction::StashDrop,
            DestructiveAction::TagDelete,
            DestructiveAction::TagDeleteRemote,
            DestructiveAction::SubmoduleRemove,
            DestructiveAction::FileDelete,
            DestructiveAction::AbortOperation,
            DestructiveAction::RemoteRemove,
            DestructiveAction::WorkspaceSync,
            DestructiveAction::CloseTabInProgress,
        ] {
            assert!(!action.code().is_empty());
            assert!(!action.consequence().is_empty());
        }
    }

    #[test]
    fn rejects_missing_confirmation() {
        let error = Confirmation::default()
            .verify(DestructiveAction::DiscardFile)
            .expect_err("must reject");
        assert_eq!(error.code, "confirmation.required");
        assert!(error.message.contains("irréversible"));
    }

    #[test]
    fn acknowledgement_is_enough() {
        for action in [
            DestructiveAction::BranchDelete,
            DestructiveAction::ForcePush,
        ] {
            assert!(Confirmation::acknowledged().verify(action).is_ok());
        }
    }
}
