//! GitHub advanced workflows: review comments, approvals, merge and Actions
//! jobs with bounded logs.

use beebranch_core::{AppError, Confirmation, ErrorCategory};
use beebranch_git::diff::DiffReport;
use beebranch_github::{
    GithubApprovals, GithubDiscussion, GithubJob, GithubNote, GithubPosition, GithubPullRequest,
    JobLog, Paged, PullRequestMerge, PullUpdate,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::forge_diff::{report_from_patches, PatchInput};

use crate::commands::github_pr::{auth_event, client, instance_id, resolve_repo_ref};
use crate::error::github_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMrRefInput {
    pub project_id: u64,
    pub iid: u64,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubApproveInput {
    pub project_id: u64,
    pub iid: u64,
    /// Optional body carried by the approving review.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRunRefInput {
    pub project_id: u64,
    pub run_id: u64,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRollupInput {
    pub project_id: u64,
    /// Pull request numbers of the visible page.
    pub numbers: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckRollupDto {
    pub iid: u64,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiscussionInput {
    pub project_id: u64,
    pub iid: u64,
    pub body: String,
    #[serde(default)]
    pub position: Option<GithubPosition>,
    #[serde(default)]
    pub discussion_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiscussionResolveInput {
    pub project_id: u64,
    pub iid: u64,
    pub discussion_id: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRefInput {
    pub project_id: u64,
    pub iid: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRequestChangesInput {
    pub project_id: u64,
    pub iid: u64,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullUpdateInput {
    pub project_id: u64,
    pub iid: u64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullStateInput {
    pub project_id: u64,
    pub iid: u64,
    pub open: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullDraftInput {
    pub project_id: u64,
    pub iid: u64,
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMergeInput {
    pub project_id: u64,
    pub iid: u64,
    pub sha: Option<String>,
    pub merge_method: Option<String>,
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub remove_source_branch: bool,
    /// GitHub auto-merge requires GraphQL; the app rejects it explicitly.
    #[serde(default)]
    pub auto_merge: bool,
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubJobLogInput {
    pub project_id: u64,
    pub job_id: u64,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubApprovalsDto {
    pub available: bool,
    pub state: Option<GithubApprovals>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubJobsDto {
    pub pipeline_id: Option<u64>,
    pub items: Vec<GithubJob>,
    pub next_page: Option<u32>,
    pub per_page: u32,
    pub total: Option<u64>,
}

fn validate_body(body: &str) -> Result<(), AppError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input(
            "Le commentaire ne peut pas être vide.".to_owned(),
        ));
    }
    if body.chars().count() > 20_000 {
        return Err(AppError::invalid_input(
            "Le commentaire dépasse 20 000 caractères.".to_owned(),
        ));
    }
    if body
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(AppError::invalid_input(
            "Le commentaire contient un caractère de contrôle.".to_owned(),
        ));
    }
    Ok(())
}

fn validate_sha(value: &str, field: &str) -> Result<(), AppError> {
    if value.len() != 40 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(AppError::invalid_input(format!(
            "Le SHA `{field}` est invalide."
        )));
    }
    Ok(())
}

fn validate_position(position: &GithubPosition) -> Result<(), AppError> {
    validate_sha(&position.head_sha, "head_sha")?;
    if position.position_type != "text" {
        return Err(AppError::invalid_input(
            "Seuls les commentaires positionnés sur du texte sont supportés.".to_owned(),
        ));
    }
    if position.new_path.is_none() && position.old_path.is_none() {
        return Err(AppError::invalid_input(
            "Un commentaire positionné doit indiquer un chemin.".to_owned(),
        ));
    }
    if position.new_line.is_none() && position.old_line.is_none() {
        return Err(AppError::invalid_input(
            "Un commentaire positionné doit indiquer une ligne.".to_owned(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn github_pr_discussions(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMrRefInput,
) -> Result<Paged<GithubDiscussion>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .discussions(
            &repo,
            input.iid,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_discussion_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubDiscussionInput,
) -> Result<GithubDiscussion, AppError> {
    validate_body(&input.body)?;
    if let Some(position) = input.position.as_ref() {
        validate_position(position)?;
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .create_discussion(
            &repo,
            input.iid,
            &input.body,
            input.position.as_ref(),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            if error.status() == Some(422) {
                AppError::new(
                    "github.discussion_invalid",
                    ErrorCategory::Input,
                    "GitHub a refusé le commentaire (422).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation(
                    "Vérifiez que le commit, le chemin et la ligne ciblés existent encore dans la pull request.",
                )
            } else {
                github_error(error)
            }
        })
}

#[tauri::command]
pub async fn github_discussion_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubDiscussionInput,
) -> Result<GithubNote, AppError> {
    let discussion_id = input.discussion_id.clone().ok_or_else(|| {
        AppError::invalid_input("discussionId est requis pour répondre.".to_owned())
    })?;
    validate_body(&input.body)?;
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .reply_to_discussion(&repo, input.iid, &discussion_id, &input.body)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

/// GitHub only exposes thread resolution through GraphQL. The UI hides the
/// action (`resolvable: false`); this command documents the intentional gap.
#[tauri::command]
pub async fn github_discussion_resolve(
    input: GithubDiscussionResolveInput,
) -> Result<GithubDiscussion, AppError> {
    let _ = input;
    Err(AppError::new(
        "github.unsupported",
        ErrorCategory::Input,
        "La résolution d'un thread n'est pas exposée par l'API REST GitHub.",
    )
    .with_remediation("Résolvez le thread depuis l'interface GitHub."))
}

#[tauri::command]
pub async fn github_approvals(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMrRefInput,
) -> Result<GithubApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    match client.approvals(&repo, input.iid).await {
        Ok(value) => Ok(GithubApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(GithubApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les revues ne sont pas accessibles sur ce dépôt.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(github_error(error))
        }
    }
}

#[tauri::command]
pub async fn github_approve(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubApproveInput,
) -> Result<GithubApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    match client
        .approve(&repo, input.iid, input.note.as_deref())
        .await
    {
        Ok(value) => Ok(GithubApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(GithubApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les revues ne sont pas accessibles sur ce dépôt.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(github_error(error))
        }
    }
}

#[tauri::command]
pub async fn github_unapprove(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMrRefInput,
) -> Result<GithubApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    match client.unapprove(&repo, input.iid).await {
        Ok(value) => Ok(GithubApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(GithubApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les revues ne sont pas accessibles sur ce dépôt.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(github_error(error))
        }
    }
}

#[tauri::command]
pub async fn github_pr_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubPullRefInput,
) -> Result<DiffReport, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    let (files, truncated) = client.pull_files(&repo, input.iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })?;
    let patches = files
        .into_iter()
        .map(|file| PatchInput {
            old_path: file.old_path,
            new_path: file.new_path,
            status: file.status,
            patch: file.patch,
        })
        .collect();
    let mut report = report_from_patches(patches)?;
    report.truncated |= truncated;
    Ok(report)
}

#[tauri::command]
pub async fn github_request_changes(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubRequestChangesInput,
) -> Result<GithubApprovalsDto, AppError> {
    validate_body(&input.body)?;
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    match client.request_changes(&repo, input.iid, &input.body).await {
        Ok(value) => Ok(GithubApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(GithubApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les revues ne sont pas accessibles sur ce dépôt.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(github_error(error))
        }
    }
}

#[tauri::command]
pub async fn github_pr_update(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubPullUpdateInput,
) -> Result<GithubPullRequest, AppError> {
    let update = PullUpdate {
        title: input.title.clone(),
        body: input.body.clone(),
    };
    if update.is_empty() {
        return Err(AppError::invalid_input(
            "Aucun champ à modifier.".to_owned(),
        ));
    }
    if let Some(title) = update.title.as_ref() {
        if title.trim().is_empty() {
            return Err(AppError::invalid_input(
                "Le titre ne peut pas être vide.".to_owned(),
            ));
        }
    }
    if let Some(body) = update.body.as_ref() {
        if body.chars().count() > 65_536 {
            return Err(AppError::invalid_input(
                "La description dépasse 65 536 caractères.".to_owned(),
            ));
        }
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .update_pull_request(&repo, input.iid, &update)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_pr_set_state(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubPullStateInput,
) -> Result<GithubPullRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .set_pull_open(&repo, input.iid, input.open)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_pr_set_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubPullDraftInput,
) -> Result<GithubPullRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .set_pull_draft(&repo, input.iid, input.draft)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_merge_pr(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMergeInput,
) -> Result<GithubPullRequest, AppError> {
    if !input.confirmation.acknowledged {
        return Err(AppError::new(
            "confirmation.required",
            ErrorCategory::Input,
            "Confirmez explicitement la fusion de la pull request.",
        ));
    }
    if input.auto_merge {
        return Err(AppError::new(
            "github.auto_merge_unsupported",
            ErrorCategory::Input,
            "GitHub n'expose pas l'auto-merge via l'API REST utilisée.",
        )
        .with_remediation("Fusionnez manuellement ou activez l'auto-merge dans GitHub."));
    }
    if input.remove_source_branch {
        return Err(AppError::new(
            "github.remove_branch_unsupported",
            ErrorCategory::Input,
            "GitHub supprime la branche source selon les réglages du dépôt, pas au moment du merge.",
        )
        .with_remediation("Configurez la suppression automatique dans les réglages du dépôt GitHub."));
    }
    if let Some(method) = input.merge_method.as_deref() {
        // GitHub rejects `rebase_merge`: only `merge`, `squash` and `rebase`
        // exist, the last two being strategies of their own.
        if !matches!(method, "merge" | "rebase" | "squash") {
            return Err(AppError::invalid_input(
                "La stratégie de merge doit être `merge`, `rebase` ou `squash`.".to_owned(),
            ));
        }
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    let merge = PullRequestMerge {
        sha: input.sha.clone(),
        merge_method: input.merge_method.clone(),
        squash: input.squash,
        should_remove_source_branch: false,
        sha_must_match: input.sha.is_some(),
        merge_when_pipeline_succeeds: false,
    };
    client
        .merge_pull_request(&repo, input.iid, &merge)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            match error.status() {
                Some(405) => AppError::new(
                    "github.merge_not_allowed",
                    ErrorCategory::GitState,
                    "La pull request ne peut pas être fusionnée dans son état actuel.",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation(
                    "Vérifiez les checks requis, les conflits, le statut de brouillon et vos droits sur le dépôt.",
                ),
                Some(409) => AppError::new(
                    "github.merge_stale",
                    ErrorCategory::Conflict,
                    "La pull request a changé depuis votre lecture (409).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation("Rechargez la pull request puis relancez la fusion."),
                Some(422) => AppError::new(
                    "github.merge_conflict",
                    ErrorCategory::Conflict,
                    "GitHub signale que la branche ne peut pas être fusionnée (422).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation("Mettez la branche à jour et résolvez les conflits."),
                _ => github_error(error),
            }
        })
}

#[tauri::command]
pub async fn github_run_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubRunRefInput,
) -> Result<GithubJobsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    let page = client
        .run_jobs(
            &repo,
            input.run_id,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })?;
    Ok(GithubJobsDto {
        pipeline_id: page.run_id,
        items: page.items,
        next_page: page.next_page,
        per_page: page.per_page,
        total: page.total,
    })
}

#[tauri::command]
pub async fn github_rerun_failed(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubRunRefInput,
) -> Result<bool, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .rerun_failed_jobs(&repo, input.run_id)
        .await
        .map(|()| true)
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_cancel_run(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubRunRefInput,
) -> Result<bool, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .cancel_run(&repo, input.run_id)
        .await
        .map(|()| true)
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

/// Check badges for a whole list page, in one GraphQL request.
#[tauri::command]
pub async fn github_pr_checks_rollup(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubRollupInput,
) -> Result<Vec<GithubCheckRollupDto>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    let rollups = client
        .pull_check_rollups(&repo, &input.numbers)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })?;
    Ok(rollups
        .into_iter()
        .map(|(iid, status)| GithubCheckRollupDto { iid, status })
        .collect())
}

#[tauri::command]
pub async fn github_pr_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMrRefInput,
) -> Result<GithubJobsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    let pull = client
        .pull_request(&repo, input.iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })?;
    let Some(sha) = pull.sha.as_deref() else {
        return Ok(GithubJobsDto {
            pipeline_id: None,
            items: Vec::new(),
            next_page: None,
            per_page: 0,
            total: None,
        });
    };
    let page = client
        .workflow_jobs(
            &repo,
            sha,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })?;
    Ok(GithubJobsDto {
        pipeline_id: page.run_id,
        items: page.items,
        next_page: page.next_page,
        per_page: page.per_page,
        total: page.total,
    })
}

#[tauri::command]
pub async fn github_job_log(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubJobLogInput,
) -> Result<JobLog, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client
        .job_log(
            &repo,
            input.job_id,
            input.max_bytes.unwrap_or(512 * 1024),
            input.offset.unwrap_or(0),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}

#[tauri::command]
pub async fn github_pr_diff_refs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubMrRefInput,
) -> Result<beebranch_github::GithubDiffRefs, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, input.project_id).await?;
    client.diff_refs(&repo, input.iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })
}
