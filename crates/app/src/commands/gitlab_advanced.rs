//! GitLab advanced workflows: inline discussions, approvals, merge, CI jobs
//! and bounded job logs (P2-T08, P2-T09, P2-T10).

use beebranch_core::{AppError, Confirmation, ErrorCategory};
use beebranch_gitlab::{
    GitlabApprovals, GitlabClient, GitlabDiscussion, GitlabJob, GitlabMergeRequest, GitlabNote,
    GitlabPosition, JobLog, MergeRequestMerge, MergeRequestUpdate, Paged,
};
use beebranch_git::diff::DiffReport;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::forge_diff::{report_from_patches, PatchInput};

use crate::commands::gitlab::not_configured_public as not_configured;
use crate::error::gitlab_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrRefInput {
    pub project_id: u64,
    pub iid: u64,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrRequestChangesInput {
    pub project_id: u64,
    pub iid: u64,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrUpdateInput {
    pub project_id: u64,
    pub iid: u64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrStateInput {
    pub project_id: u64,
    pub iid: u64,
    pub open: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrDraftInput {
    pub project_id: u64,
    pub iid: u64,
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInput {
    pub project_id: u64,
    pub iid: u64,
    pub body: String,
    #[serde(default)]
    pub position: Option<GitlabPosition>,
    /// Omit for a new thread.
    #[serde(default)]
    pub discussion_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionResolveInput {
    pub project_id: u64,
    pub iid: u64,
    pub discussion_id: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    pub project_id: u64,
    pub iid: u64,
    pub sha: Option<String>,
    pub merge_method: Option<String>,
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub remove_source_branch: bool,
    /// Merge automatically when the pipeline succeeds (GitLab auto-merge).
    #[serde(default)]
    pub auto_merge: bool,
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLogInput {
    pub project_id: u64,
    pub job_id: u64,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalsDto {
    pub available: bool,
    pub state: Option<GitlabApprovals>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsDto {
    pub pipeline_id: Option<u64>,
    pub items: Vec<GitlabJob>,
    pub next_page: Option<u32>,
    pub per_page: u32,
    pub total: Option<u64>,
}

fn client(state: &AppState) -> Result<GitlabClient, AppError> {
    state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))?
        .clone()
        .ok_or_else(not_configured)
}

fn instance_id(state: &AppState) -> Result<String, AppError> {
    state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)
}

fn auth_event(app: &AppHandle, error: &beebranch_gitlab::GitlabError, instance: &str) {
    if error.code() == "auth.failed" {
        let _ = app.emit(
            "gitlab://auth-expired",
            serde_json::json!({ "instanceId": instance }),
        );
    }
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
            "Le SHA `{field}` de `diff_refs` est invalide."
        )));
    }
    Ok(())
}

fn validate_position(position: &GitlabPosition) -> Result<(), AppError> {
    validate_sha(&position.base_sha, "base_sha")?;
    validate_sha(&position.start_sha, "start_sha")?;
    validate_sha(&position.head_sha, "head_sha")?;
    if position.position_type != "text" {
        return Err(AppError::invalid_input(
            "Seules les discussions positionnées sur du texte sont supportées.".to_owned(),
        ));
    }
    if position.new_path.is_none() && position.old_path.is_none() {
        return Err(AppError::invalid_input(
            "Une discussion positionnée doit indiquer un chemin.".to_owned(),
        ));
    }
    if position.new_line.is_none() && position.old_line.is_none() {
        return Err(AppError::invalid_input(
            "Une discussion positionnée doit indiquer une ligne.".to_owned(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn gitlab_mr_discussions(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<Paged<GitlabDiscussion>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .merge_request_discussions(
            input.project_id,
            input.iid,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_discussion_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DiscussionInput,
) -> Result<GitlabDiscussion, AppError> {
    validate_body(&input.body)?;
    if let Some(position) = input.position.as_ref() {
        validate_position(position)?;
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .create_discussion(
            input.project_id,
            input.iid,
            &input.body,
            input.position.as_ref(),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            if error.status() == Some(422) {
                AppError::new(
                    "gitlab.discussion_invalid",
                    ErrorCategory::Input,
                    "GitLab a refusé la discussion (422).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation(
                    "Vérifiez que les SHA de `diff_refs` et la ligne ciblée existent encore dans la merge request.",
                )
            } else {
                gitlab_error(error)
            }
        })
}

#[tauri::command]
pub async fn gitlab_discussion_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DiscussionInput,
) -> Result<GitlabNote, AppError> {
    let discussion_id = input.discussion_id.clone().ok_or_else(|| {
        AppError::invalid_input("discussionId est requis pour répondre.".to_owned())
    })?;
    validate_body(&input.body)?;
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .reply_to_discussion(input.project_id, input.iid, &discussion_id, &input.body)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_discussion_resolve(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DiscussionResolveInput,
) -> Result<GitlabDiscussion, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .set_discussion_resolved(
            input.project_id,
            input.iid,
            &input.discussion_id,
            input.resolved,
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_approvals(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<ApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    match client.approvals(input.project_id, input.iid).await {
        Ok(value) => Ok(ApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(ApprovalsDto {
            available: false,
            state: None,
            reason: Some(
                "Le module d'approbations est désactivé ou indisponible sur cette instance."
                    .to_owned(),
            ),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(gitlab_error(error))
        }
    }
}

#[tauri::command]
pub async fn gitlab_approve(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<ApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    match client.approve(input.project_id, input.iid).await {
        Ok(value) => Ok(ApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(ApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les approbations ne sont pas disponibles sur cette instance.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(gitlab_error(error))
        }
    }
}

#[tauri::command]
pub async fn gitlab_mr_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<DiffReport, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let files = client
        .merge_request_changes(input.project_id, input.iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })?;
    let patches = files
        .into_iter()
        .map(|file| PatchInput {
            status: if file.new_file {
                "added".to_owned()
            } else if file.deleted_file {
                "removed".to_owned()
            } else if file.renamed_file {
                "renamed".to_owned()
            } else {
                "modified".to_owned()
            },
            old_path: file.old_path,
            new_path: file.new_path,
            patch: Some(file.patch),
        })
        .collect();
    report_from_patches(patches)
}

#[tauri::command]
pub async fn gitlab_request_changes(
    _app: AppHandle,
    _state: State<'_, AppState>,
    _input: MrRequestChangesInput,
) -> Result<ApprovalsDto, AppError> {
    // GitLab exposes approve/revoke only: a "requested changes" review state
    // does not exist, so the action is refused with its reason rather than
    // silently approximated by a comment.
    Err(AppError::new(
        "gitlab.unsupported",
        ErrorCategory::Input,
        "GitLab ne prend pas en charge la demande de modifications.",
    )
    .with_remediation(
        "Commentez la merge request ou retirez votre approbation.",
    ))
}

#[tauri::command]
pub async fn gitlab_mr_update(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GitlabMrUpdateInput,
) -> Result<GitlabMergeRequest, AppError> {
    let update = MergeRequestUpdate {
        title: input.title.clone(),
        description: input.description.clone(),
    };
    if update.is_empty() {
        return Err(AppError::invalid_input("Aucun champ à modifier.".to_owned()));
    }
    if let Some(title) = update.title.as_ref() {
        if title.trim().is_empty() {
            return Err(AppError::invalid_input(
                "Le titre ne peut pas être vide.".to_owned(),
            ));
        }
    }
    if let Some(description) = update.description.as_ref() {
        if description.chars().count() > 65_536 {
            return Err(AppError::invalid_input(
                "La description dépasse 65 536 caractères.".to_owned(),
            ));
        }
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .update_merge_request(input.project_id, input.iid, &update)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_mr_set_state(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GitlabMrStateInput,
) -> Result<GitlabMergeRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .set_merge_request_open(input.project_id, input.iid, input.open)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_mr_set_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GitlabMrDraftInput,
) -> Result<GitlabMergeRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .set_merge_request_draft(input.project_id, input.iid, input.draft)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_unapprove(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<ApprovalsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    match client.unapprove(input.project_id, input.iid).await {
        Ok(value) => Ok(ApprovalsDto {
            available: true,
            state: Some(value),
            reason: None,
        }),
        Err(error) if error.status() == Some(404) => Ok(ApprovalsDto {
            available: false,
            state: None,
            reason: Some("Les approbations ne sont pas disponibles sur cette instance.".to_owned()),
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(gitlab_error(error))
        }
    }
}

#[tauri::command]
pub async fn gitlab_merge_mr(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MergeInput,
) -> Result<GitlabMergeRequest, AppError> {
    if !input.confirmation.acknowledged {
        return Err(AppError::new(
            "confirmation.required",
            ErrorCategory::Input,
            "Confirmez explicitement la fusion de la merge request.",
        ));
    }
    if let Some(method) = input.merge_method.as_deref() {
        // GitLab only accepts `merge` and `squash` on the merge endpoint;
        // `rebase_merge` is a project setting applied by a separate async
        // rebase call, which is not implemented.
        if !matches!(method, "merge") {
            return Err(AppError::invalid_input(
                "La stratégie de merge doit être `merge` ; le squash est demandé séparément."
                    .to_owned(),
            ));
        }
    }
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let merge = MergeRequestMerge {
        sha: input.sha.clone(),
        merge_method: input.merge_method.clone(),
        squash: input.squash,
        should_remove_source_branch: input.remove_source_branch,
        sha_must_match: input.sha.is_some(),
        merge_when_pipeline_succeeds: input.auto_merge,
    };
    client
        .merge_merge_request(input.project_id, input.iid, &merge)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            match error.status() {
                Some(405) => AppError::new(
                    "gitlab.merge_not_allowed",
                    ErrorCategory::GitState,
                    "La merge request ne peut pas être fusionnée dans son état actuel.",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation(
                    "Vérifiez les checks requis, les conflits, le statut de draft et vos droits sur le projet.",
                ),
                Some(406) => AppError::new(
                    "gitlab.merge_conflict",
                    ErrorCategory::Conflict,
                    "GitLab signale que la branche ne peut pas être fusionnée (406).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation("Mettez la branche à jour et résolvez les conflits."),
                Some(409) => AppError::new(
                    "gitlab.merge_stale",
                    ErrorCategory::Conflict,
                    "La merge request a changé depuis votre lecture (409).",
                )
                .with_detail(error.detail().unwrap_or_default())
                .with_remediation("Rechargez la merge request puis relancez la fusion."),
                _ => gitlab_error(error),
            }
        })
}

#[tauri::command]
pub async fn gitlab_mr_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<JobsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let pipelines = client
        .merge_request_pipelines(input.project_id, input.iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })?;
    let Some(pipeline) = pipelines.into_iter().next() else {
        return Ok(JobsDto {
            pipeline_id: None,
            items: Vec::new(),
            next_page: None,
            per_page: 0,
            total: None,
        });
    };
    let page = client
        .pipeline_jobs(
            input.project_id,
            pipeline.id,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })?;
    Ok(JobsDto {
        pipeline_id: Some(pipeline.id),
        items: page.items,
        next_page: page.next_page,
        per_page: page.per_page,
        total: page.total,
    })
}

#[tauri::command]
pub async fn gitlab_pipeline_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
    pipeline_id: u64,
) -> Result<JobsDto, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let page = client
        .pipeline_jobs(
            input.project_id,
            pipeline_id,
            input.page.unwrap_or(1),
            input.per_page.unwrap_or(50),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })?;
    Ok(JobsDto {
        pipeline_id: Some(pipeline_id),
        items: page.items,
        next_page: page.next_page,
        per_page: page.per_page,
        total: page.total,
    })
}

#[tauri::command]
pub async fn gitlab_job_log(
    app: AppHandle,
    state: State<'_, AppState>,
    input: JobLogInput,
) -> Result<JobLog, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .job_log(
            input.project_id,
            input.job_id,
            input.max_bytes.unwrap_or(512 * 1024),
            input.offset.unwrap_or(0),
        )
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_mr_diff_refs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrRefInput,
) -> Result<beebranch_gitlab::GitlabDiffRefs, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .merge_request_diff_refs(input.project_id, input.iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}
