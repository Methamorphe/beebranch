import { useCallback, useEffect, useState } from 'react'
import { openExternalUrl } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { formatDateTime, formatNumber, useI18n } from '../i18n'
import type { ForgeApi } from '../lib/forge'
import type {
  ApprovalsDto,
  GitlabDiffRefs,
  GitlabDiscussion,
  GitlabJob,
  GitlabMergeRequest,
  GitlabPipeline,
  JobLog,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './ui/Dialog'
import p2 from './p2.module.css'

type Props = {
  api: ForgeApi
  projectId: number
  mr: GitlabMergeRequest
  pipelines: GitlabPipeline[]
  onRefresh: () => void
}

type Tab = 'overview' | 'discussions' | 'jobs'

function statusTone(status: string | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
      return p2.chipGood
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return p2.chipBad
    case 'running':
    case 'pending':
    case 'manual':
      return p2.chipWarn
    default:
      return ''
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return ''
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 16).replace('T', ' ')
  }
  return formatDateTime(parsed)
}

export function MrDetailExtras({ api, projectId, mr, pipelines, onRefresh }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('overview')
  const [discussions, setDiscussions] = useState<GitlabDiscussion[]>([])
  const [discussionsNext, setDiscussionsNext] = useState<number | undefined>()
  const [approvals, setApprovals] = useState<ApprovalsDto | null>(null)
  const [jobs, setJobs] = useState<GitlabJob[]>([])
  const [jobsNext, setJobsNext] = useState<number | undefined>()
  const [pipelineId, setPipelineId] = useState<number | null>(null)
  const [log, setLog] = useState<{ job: GitlabJob; value: JobLog } | null>(null)
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [inline, setInline] = useState(false)
  const [positionPath, setPositionPath] = useState('')
  const [positionLine, setPositionLine] = useState('1')
  const [positionSide, setPositionSide] = useState<'new' | 'old'>('new')
  const [refs, setRefs] = useState<GitlabDiffRefs | null>(null)
  const [strategy, setStrategy] = useState('merge')
  const [squash, setSquash] = useState(false)
  const [removeSource, setRemoveSource] = useState(false)
  const [autoMerge, setAutoMerge] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  /** Open review dialog, or `null` when none is shown. */
  const [reviewDialog, setReviewDialog] = useState<'changes' | 'edit' | null>(null)
  const [changesBody, setChangesBody] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadDiscussions = useCallback(
    async (page = 1, append = false) => {
      try {
        const result = await api.discussions({ projectId, iid: mr.iid, page })
        setDiscussions((current) =>
          append ? [...current, ...result.items] : result.items,
        )
        setDiscussionsNext(result.nextPage)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [api, projectId, mr.iid],
  )

  const loadApprovals = useCallback(async () => {
    try {
      setApprovals(await api.approvals({ projectId, iid: mr.iid }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api, projectId, mr.iid])

  const loadJobs = useCallback(
    async (page = 1, append = false) => {
      try {
        const result = await api.jobs({ projectId, iid: mr.iid, page })
        setJobs((current) =>
          append ? [...current, ...result.items] : result.items,
        )
        setJobsNext(result.nextPage)
        setPipelineId(result.pipelineId ?? null)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [api, projectId, mr.iid],
  )

  useEffect(() => {
    setDiscussions([])
    setDiscussionsNext(undefined)
    setApprovals(null)
    setJobs([])
    setJobsNext(undefined)
    setLog(null)
    setInline(false)
    setRefs(null)
    setReplyTo(null)
  }, [mr.iid])

  useEffect(() => {
    if (tab === 'discussions') {
      void loadDiscussions()
    } else if (tab === 'overview') {
      void loadApprovals()
    } else if (tab === 'jobs') {
      void loadJobs()
    }
  }, [tab, loadDiscussions, loadApprovals, loadJobs])

  useEffect(() => {
    if (!inline || refs) {
      return
    }
    void api.diffRefs({ projectId, iid: mr.iid })
      .then(setRefs)
      .catch((cause) => setError(errorMessage(cause)))
  }, [api, inline, refs, projectId, mr.iid])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const requestChanges = async () => {
    if (!changesBody.trim()) {
      return
    }
    await run(t('forge.detail.changesDone'), async () => {
      setApprovals(
        await api.requestChanges({
          projectId,
          iid: mr.iid,
          body: changesBody.trim(),
        }),
      )
      setChangesBody('')
      setReviewDialog(null)
    })
  }

  const saveMetadata = async () => {
    const trimmed = editTitle.trim()
    if (!trimmed) {
      return
    }
    await run(t('forge.detail.metadataSaved'), async () => {
      await api.update({
        projectId,
        iid: mr.iid,
        title: trimmed,
        description: editDescription,
      })
      setReviewDialog(null)
    })
  }

  const toggleOpen = async () => {
    const closing = isOpen
    await run(
      closing ? t('forge.detail.closed') : t('forge.detail.reopened'),
      () => api.setOpen({ projectId, iid: mr.iid, open: !closing }),
    )
  }

  const toggleDraft = async () => {
    await run(
      mr.draft ? t('forge.detail.readyDone') : t('forge.detail.draftDone'),
      () => api.setDraft({ projectId, iid: mr.iid, draft: !mr.draft }),
    )
  }

  const send = async () => {
    if (!body.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (replyTo) {
        await api.discussionReply({
          projectId,
          iid: mr.iid,
          discussionId: replyTo,
          body,
        })
      } else {
        const position =
          inline && refs
            ? {
                baseSha: refs.baseSha,
                startSha: refs.startSha,
                headSha: refs.headSha,
                positionType: 'text',
                newPath: positionPath.trim() || undefined,
                oldPath: positionPath.trim() || undefined,
                newLine: positionSide === 'new' ? Number(positionLine) || 1 : undefined,
                oldLine: positionSide === 'old' ? Number(positionLine) || 1 : undefined,
              }
            : undefined
        await api.discussionCreate({
          projectId,
          iid: mr.iid,
          body,
          position,
        })
      }
      setBody('')
      setReplyTo(null)
      setInline(false)
      await loadDiscussions()
      onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const showLog = async (job: GitlabJob) => {
    setBusy(true)
    setError(null)
    try {
      setLog({ job, value: await api.jobLog({ projectId, jobId: job.id }) })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const approval = approvals?.state
  const isOpen = mr.state === 'opened' || mr.state === 'open'
  const ordered = [...discussions].sort((a, b) => {
    const left = a.notes.find((note) => note.position)?.position
    const right = b.notes.find((note) => note.position)?.position
    const leftKey = `${left?.newPath ?? left?.oldPath ?? ''}:${left?.newLine ?? left?.oldLine ?? 0}`
    const rightKey = `${right?.newPath ?? right?.oldPath ?? ''}:${right?.newLine ?? right?.oldLine ?? 0}`
    return leftKey.localeCompare(rightKey, undefined, { numeric: true })
  })

  return (
    <div className={p2.detailSections}>
      <div className={p2.listHeader}>
        <div className={p2.segmented} role="group" aria-label={t('forge.detail.tabsAria')}>
          <button
            type="button"
            className={tab === 'overview' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'overview'}
            onClick={() => setTab('overview')}
          >
            Vue d’ensemble
          </button>
          <button
            type="button"
            className={tab === 'discussions' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'discussions'}
            onClick={() => setTab('discussions')}
          >
            Discussions ({discussions.length})
          </button>
          <button
            type="button"
            className={tab === 'jobs' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'jobs'}
            onClick={() => setTab('jobs')}
          >
            Jobs
          </button>
        </div>
        <span className={p2.spacer} />
        {tab === 'jobs' ? (
          <button type="button" className={p2.ghost} onClick={() => void loadJobs()}>
            {t('common.refresh')}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className={p2.listHeader} role="status">
          <span className={p2.meta}>{notice}</span>
        </div>
      ) : null}

          <section className={p2.paneSection}>
            <h3 className={p2.paneTitle}>{t('forge.detail.requestTitle')}</h3>
            <div className={p2.row}>
              {api.capabilities.editMetadata ? (
                <button
                  type="button"
                  className={p2.secondary}
                  disabled={busy}
                  onClick={() => {
                    setEditTitle(mr.title)
                    setEditDescription(mr.description ?? '')
                    setReviewDialog('edit')
                  }}
                >
                  {t('forge.detail.metadataAction')}
                </button>
              ) : null}
              {api.capabilities.draftToggle ? (
                <button
                  type="button"
                  className={p2.ghost}
                  disabled={busy}
                  onClick={() => void toggleDraft()}
                >
                  {mr.draft ? t('forge.detail.markReady') : t('forge.detail.markDraft')}
                </button>
              ) : null}
              {api.capabilities.closeReopen ? (
                <button
                  type="button"
                  className={p2.ghost}
                  disabled={busy}
                  onClick={() => void toggleOpen()}
                >
                  {isOpen ? t('forge.detail.stateClose') : t('forge.detail.stateReopen')}
                </button>
              ) : null}
              {api.capabilities.requestChanges ? (
                <button
                  type="button"
                  className={p2.ghost}
                  disabled={busy}
                  onClick={() => {
                    setChangesBody('')
                    setReviewDialog('changes')
                  }}
                >
                  {t('forge.detail.requestChanges')}
                </button>
              ) : null}
              <button
                type="button"
                className={p2.ghost}
                disabled={busy}
                onClick={() => void openExternalUrl(mr.webUrl)}
              >
                {t('common.open')}
              </button>
            </div>
            {approval && (approval.changesRequestedBy?.length ?? 0) > 0 ? (
              <div className={p2.row}>
                <span className={p2.asideHint}>{t('forge.detail.changesFrom')}</span>
                {approval.changesRequestedBy?.map((entry) => (
                  <span key={entry.user.id} className={`${p2.chip} ${p2.chipWarn}`}>
                    @{entry.user.username}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

      {tab === 'overview' ? (
        <>
          <section className={p2.paneSection}>
            <h3 className={p2.paneTitle}>
              {t('forge.detail.approvals')}
              {approval ? (
                <span className={p2.count}>
                  {approval.approvedBy.length}
                  {api.capabilities.approvalQuota
                    ? t('forge.detail.approvalsLeft', { left: approval.approvalsLeft, required: approval.approvalsRequired })
                    : ''}
                </span>
              ) : null}
            </h3>
            {approvals === null ? (
              <p className={p2.asideHint}>{t('common.loading')}</p>
            ) : approvals.available && approval ? (
              <>
                <div className={p2.row}>
                  {approval.approvedBy.length === 0 ? (
                    <span className={p2.asideHint}>{t('forge.detail.approvalsNone')}</span>
                  ) : (
                    approval.approvedBy.map((entry) => (
                      <span key={entry.user.id} className={`${p2.chip} ${p2.chipGood}`}>
                        @{entry.user.username}
                      </span>
                    ))
                  )}
                </div>
                <div className={p2.row}>
                  <button
                    type="button"
                    className={p2.secondary}
                    disabled={busy}
                    onClick={() =>
                      void run(t('forge.detail.approveDone'), async () => {
                        setApprovals(await api.approve({ projectId, iid: mr.iid }))
                      })
                    }
                  >
                    {t('forge.detail.approve')}
                  </button>
                  <button
                    type="button"
                    className={p2.ghost}
                    disabled={busy}
                    onClick={() =>
                      void run(t('forge.detail.unapproveDone'), async () => {
                        setApprovals(await api.unapprove({ projectId, iid: mr.iid }))
                      })
                    }
                  >
                    Retirer mon approbation
                  </button>
                </div>
              </>
            ) : (
              <p className={p2.asideHint}>
                {approvals.reason ?? 'Approbations indisponibles.'}
              </p>
            )}
          </section>

          <section className={p2.paneSection}>
            <h3 className={p2.paneTitle}>
              {t('forge.detail.pipelines')}
              <span className={p2.count}>{pipelines.length}</span>
            </h3>
            {pipelines.length === 0 ? (
              <p className={p2.asideHint}>{t('forge.detail.noPipeline')}</p>
            ) : (
              <div className={p2.rows}>
                {pipelines.map((pipeline) => (
                  <div key={pipeline.id} className={p2.entry}>
                    <span
                      className={p2.dot}
                      data-tone={
                        pipeline.status === 'success'
                          ? 'good'
                          : pipeline.status === 'failed'
                            ? 'bad'
                            : 'warn'
                      }
                    />
                    <span className={p2.entryStack}>
                      <span className={p2.entryTitle}>
                        <span className={`${p2.chip} ${statusTone(pipeline.status)}`}>
                          {pipeline.status}
                        </span>
                      </span>
                      <span className={p2.entryMeta}>
                        <span className={p2.mono}>#{pipeline.id}</span>
                        {pipeline.sha ? (
                          <>
                            <span>·</span>
                            <span className={p2.mono}>{pipeline.sha.slice(0, 10)}</span>
                          </>
                        ) : null}
                        {pipeline.refName ? (
                          <>
                            <span>·</span>
                            <span className={p2.mono}>{pipeline.refName}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className={p2.entryActions}>
                      {pipeline.webUrl ? (
                        <button
                          type="button"
                          className={p2.ghost}
                          onClick={() => void openExternalUrl(pipeline.webUrl!)}
                        >
                          {t('common.open')}
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={p2.paneSection}>
            <h3 className={p2.paneTitle}>{t('forge.detail.mergeSection')}</h3>
            <div className={p2.row}>
              <label className={p2.field}>
                {t('forge.detail.strategy')}
                <select
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value)}
                >
                  <option value="merge">{t('forge.detail.strategyMergeCommit')}</option>
                  {/* GitLab only accepts `merge`/`squash` on the MR merge
                      endpoint; `rebase_merge` is a project setting, applied by
                      `PUT /merge_requests/:iid/rebase` before the merge. */}
                  {api.id === 'github' ? (
                    <>
                      <option value="squash">{t('forge.detail.strategySquash')}</option>
                      <option value="rebase">{t('forge.detail.strategyRebase')}</option>
                    </>
                  ) : null}
                </select>
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={squash}
                  onChange={(event) => setSquash(event.target.checked)}
                />
                {t('forge.detail.squash')}
              </label>
              {api.capabilities.removeSourceBranchOnMerge ? (
                <label className={p2.checkbox}>
                  <input
                    type="checkbox"
                    checked={removeSource}
                    onChange={(event) => setRemoveSource(event.target.checked)}
                  />
                  {t('forge.detail.removeSource')}
                </label>
              ) : null}
              {api.capabilities.autoMerge ? (
                <label className={p2.checkbox}>
                  <input
                    type="checkbox"
                    checked={autoMerge}
                    onChange={(event) => setAutoMerge(event.target.checked)}
                  />
                  {t('forge.detail.autoMerge')}
                </label>
              ) : null}
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.primary}
                disabled={busy}
                onClick={() => setMergeOpen(true)}
              >
                {t('forge.detail.mergeInto', { target: mr.targetBranch })}
              </button>
            </div>
            <p className={p2.asideHint}>
              {t('forge.detail.mergeHint', {
                sha: mr.sha ? mr.sha.slice(0, 10) : t('forge.detail.mergeShaUnknown'),
                short: api.short,
                label: api.label,
              })}
            </p>
          </section>
        </>
      ) : null}

      {tab === 'discussions' ? (
        <>
          {ordered.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('forge.detail.discussionsEmpty')}</h2>
              <p>{t('forge.detail.discussionsEmptyHint')}</p>
            </div>
          ) : (
            ordered.map((discussion, index, all) => {
              const position = discussion.notes.find((note) => note.position)?.position
              const previous = all[index - 1]?.notes.find((note) => note.position)?.position
              const currentPath = position?.newPath ?? position?.oldPath
              const previousPath = previous?.newPath ?? previous?.oldPath
              const showPathHeader = Boolean(currentPath) && currentPath !== previousPath
              const resolvable = discussion.notes.some((note) => note.resolvable)
              const resolved = discussion.notes.every(
                (note) => !note.resolvable || note.resolved,
              )
              return (
                <article key={discussion.id} className={p2.discussion}>
                  {showPathHeader ? (
                    <div className={p2.row}>
                      <span className={`${p2.chip} ${p2.chipInfo} ${p2.mono}`}>
                        {currentPath}
                      </span>
                      {position?.newLine || position?.oldLine ? (
                        <span className={p2.count}>
                          {t('forge.detail.line', { line: position.newLine ?? position.oldLine ?? 0 })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {discussion.notes.map((note) => (
                    <div key={note.id} className={p2.commentBlock}>
                      <div className={p2.discussionHeader}>
                        <span className={p2.avatar}>{note.author.name.slice(0, 1)}</span>
                        <span>@{note.author.username}</span>
                        <span>{formatTimestamp(note.createdAt)}</span>
                        {note.system ? <span className={p2.chip}>{t('forge.detail.system')}</span> : null}
                        {note.resolved ? (
                          <span className={`${p2.chip} ${p2.chipGood}`}>{t('forge.detail.resolved')}</span>
                        ) : null}
                      </div>
                      <div className={p2.comment}>{note.body}</div>
                    </div>
                  ))}

                  <div className={p2.row}>
                    <button
                      type="button"
                      className={p2.ghost}
                      onClick={() => {
                        setReplyTo(discussion.id)
                        setInline(false)
                      }}
                    >
                      {t('forge.detail.reply')}
                    </button>
                    {resolvable && api.capabilities.resolveThreads ? (
                      <button
                        type="button"
                        className={p2.ghost}
                        disabled={busy}
                        onClick={() =>
                          void run(resolved ? t('forge.detail.threadReopened') : t('forge.detail.threadResolved'), async () => {
                            await api.discussionResolve({
                              projectId,
                              iid: mr.iid,
                              discussionId: discussion.id,
                              resolved: !resolved,
                            })
                            await loadDiscussions()
                          })
                        }
                      >
                        {resolved ? t('forge.detail.reopen') : t('forge.detail.resolve')}
                      </button>
                    ) : null}
                  </div>
                </article>
              )
            })
          )}

          {discussionsNext ? (
            <div className={p2.footerBar}>
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.secondary}
                disabled={busy}
                onClick={() => void loadDiscussions(discussionsNext, true)}
              >
                {t('forge.detail.logMore')}
              </button>
            </div>
          ) : null}

          <section className={p2.paneSection}>
            <h3 className={p2.paneTitle}>
              {replyTo
                ? t('forge.detail.replyToThread')
                : inline
                  ? t('forge.detail.commentOnDiff')
                  : t('forge.detail.newDiscussion')}
            </h3>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={inline}
                onChange={(event) => {
                  setInline(event.target.checked)
                  setReplyTo(null)
                }}
              />
              {t('forge.detail.inlinePosition')}
            </label>

            {inline ? (
              <>
                <div className={p2.formRow}>
                  <label className={p2.field}>
                    {t('forge.detail.path')}
                    <input
                      value={positionPath}
                      onChange={(event) => setPositionPath(event.target.value)}
                      placeholder="src/file.ts"
                      spellCheck={false}
                    />
                  </label>
                  <label className={p2.field}>
                    {t('forge.detail.lineLabel')}
                    <input
                      value={positionLine}
                      onChange={(event) => setPositionLine(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                </div>
                <label className={p2.field}>
                  {t('forge.detail.side')}
                  <select
                    value={positionSide}
                    onChange={(event) => {
                      setPositionSide(event.target.value as 'new' | 'old')
                    }}
                  >
                    <option value="new">{t('forge.detail.sideNew')}</option>
                    <option value="old">{t('forge.detail.sideOld')}</option>
                  </select>
                </label>
                <span className={p2.asideHint}>
                  {refs
                    ? t('forge.detail.diffRefs', { sha: refs.headSha.slice(0, 8) })
                    : t('forge.detail.diffRefsLoading')}
                </span>
              </>
            ) : null}

            <textarea
              className={p2.editor}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={t('forge.detail.commentPlaceholder')}
              aria-label={t('forge.detail.commentAria')}
            />
            <div className={p2.row}>
              <button
                type="button"
                className={p2.primary}
                disabled={busy || !body.trim() || (inline && !refs)}
                onClick={() => void send()}
              >
                {t('forge.detail.send')}
              </button>
              {replyTo || inline ? (
                <button
                  type="button"
                  className={p2.ghost}
                  onClick={() => {
                    setReplyTo(null)
                    setInline(false)
                  }}
                >
                  {t('common.cancel')}
                </button>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {tab === 'jobs' ? (
        <>
          <div className={p2.listHeader}>
            <span className={p2.label}>
              {t('forge.detail.pipelineSummary', { id: pipelineId ?? '—', count: jobs.length })}
            </span>
          </div>
          {jobs.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('forge.detail.noJob')}</h2>
              <p>{t('forge.detail.noJobHint')}</p>
            </div>
          ) : (
            <div className={p2.rows}>
              {jobs.map((job) => (
                <div key={job.id} className={p2.entry}>
                  <span
                    className={p2.dot}
                    data-tone={
                      job.status === 'success'
                        ? 'good'
                        : job.status === 'failed'
                          ? 'bad'
                          : 'warn'
                    }
                  />
                  <span className={p2.entryStack}>
                    <span className={p2.entryTitle}>
                      {job.stage} / {job.name}
                    </span>
                    <span className={p2.entryMeta}>
                      <span className={`${p2.chip} ${statusTone(job.status)}`}>
                        {job.status}
                      </span>
                      <span className={p2.mono}>#{job.id}</span>
                      {job.duration !== undefined ? (
                        <span>{Math.round(job.duration)} s</span>
                      ) : null}
                    </span>
                  </span>
                  <span className={p2.entryActions}>
                    <button
                      type="button"
                      className={p2.secondary}
                      disabled={busy}
                      onClick={() => void showLog(job)}
                    >
                      {t('forge.detail.logs')}
                    </button>
                    {job.webUrl ? (
                      <button
                        type="button"
                        className={p2.ghost}
                        onClick={() => void openExternalUrl(job.webUrl!)}
                      >
                        {t('common.open')}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}

          {jobsNext ? (
            <div className={p2.footerBar}>
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.secondary}
                disabled={busy}
                onClick={() => void loadJobs(jobsNext, true)}
              >
                {t('forge.detail.logMore')}
              </button>
            </div>
          ) : null}

          {log ? (
            <section className={p2.paneSection}>
              <div className={p2.row}>
                <span className={p2.label}>
                  {t('forge.detail.logSummary', {
                    name: log.job.name,
                    size: t('common.bytes', { count: formatNumber(log.value.bytes) }),
                  })}
                  {log.value.truncated ? t('forge.detail.logTruncated') : ''}
                </span>
                <span className={p2.spacer} />
                {log.value.nextOffset ? (
                  <button
                    type="button"
                    className={p2.ghost}
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void api.jobLog({
                        projectId,
                        jobId: log.job.id,
                        offset: log.value.nextOffset,
                      })
                        .then((next) =>
                          setLog({
                            job: log.job,
                            value: {
                              ...next,
                              text: `${log.value.text}\n${next.text}`,
                            },
                          }),
                        )
                        .catch((cause) => setError(errorMessage(cause)))
                        .finally(() => setBusy(false))
                    }}
                  >
                    {t('forge.detail.logMore')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={p2.ghost}
                  onClick={() => setLog(null)}
                >
                  {t('common.close')}
                </button>
              </div>
              <pre className={p2.log}>{log.value.text}</pre>
            </section>
          ) : null}
        </>
      ) : null}

      <Dialog
        open={reviewDialog === 'changes'}
        onClose={() => setReviewDialog(null)}
        busy={busy}
        titleId="review-changes-title"
      >
        <h2 id="review-changes-title">{t('forge.detail.changesTitle')}</h2>
        <p className={p2.asideHint}>{t('forge.detail.changesHint')}</p>
        <textarea
          className={p2.editor}
          value={changesBody}
          aria-label={t('forge.detail.changesAria')}
          onChange={(event) => setChangesBody(event.target.value)}
          disabled={busy}
        />
        <div className={p2.row}>
          <button
            type="button"
            className={p2.ghost}
            disabled={busy}
            onClick={() => setReviewDialog(null)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || !changesBody.trim()}
            onClick={() => void requestChanges()}
          >
            {t('forge.detail.requestChanges')}
          </button>
        </div>
      </Dialog>

      <Dialog
        open={reviewDialog === 'edit'}
        onClose={() => setReviewDialog(null)}
        busy={busy}
        titleId="review-edit-title"
      >
        <h2 id="review-edit-title">{t('forge.detail.metadataTitle')}</h2>
        <label className={p2.field}>
          {t('forge.detail.metadataTitleLabel')}
          <input
            value={editTitle}
            aria-label={t('forge.detail.metadataTitleLabel')}
            onChange={(event) => setEditTitle(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className={p2.field}>
          {t('forge.detail.metadataDescriptionLabel')}
          <textarea
            className={p2.editor}
            value={editDescription}
            aria-label={t('forge.detail.metadataDescriptionLabel')}
            onChange={(event) => setEditDescription(event.target.value)}
            disabled={busy}
          />
        </label>
        <div className={p2.row}>
          <button
            type="button"
            className={p2.ghost}
            disabled={busy}
            onClick={() => setReviewDialog(null)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || !editTitle.trim()}
            onClick={() => void saveMetadata()}
          >
            {t('common.save')}
          </button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={mergeOpen}
        title={t('forge.detail.mergeTitle', { short: api.short, iid: mr.iid })}
        consequence={t('forge.detail.mergeConsequence', {
          noun: t(api.nounKey),
          target: mr.targetBranch,
          strategy,
          squash: squash ? t('forge.detail.mergeSquash') : '',
          autoMerge: autoMerge ? t('forge.detail.mergeAutoMerge') : '',
        })}
        confirmLabel={t('forge.detail.mergeConfirm')}
        busy={busy}
        onCancel={() => setMergeOpen(false)}
        onConfirm={() => {
          setMergeOpen(false)
          void run(t('forge.detail.merged', { noun: t(api.nounKey) }), () =>
            api.merge({
              projectId,
              iid: mr.iid,
              sha: mr.sha,
              mergeMethod: strategy,
              squash,
              removeSourceBranch: removeSource,
              autoMerge,
              confirmation: { acknowledged: true },
            }),
          )
        }}
      />
    </div>
  )
}
