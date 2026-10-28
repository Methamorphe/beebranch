import { useCallback, useEffect, useState } from 'react'
import {
  gitlabApprove,
  gitlabApprovals,
  gitlabDiscussionCreate,
  gitlabDiscussionReply,
  gitlabDiscussionResolve,
  gitlabJobLog,
  gitlabMergeMr,
  gitlabMrDiffRefs,
  gitlabMrDiscussions,
  gitlabMrJobs,
  gitlabUnapprove,
  openExternalUrl,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type {
  ApprovalsDto,
  GitlabDiffRefs,
  GitlabDiscussion,
  GitlabJob,
  GitlabMergeRequest,
  JobLog,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  projectId: number
  mr: GitlabMergeRequest
  onRefresh: () => void
  onCheckout: (branch: string) => void
}

type Tab = 'overview' | 'discussions' | 'jobs'

export function MrDetailExtras({ projectId, mr, onRefresh, onCheckout }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [discussions, setDiscussions] = useState<GitlabDiscussion[]>([])
  const [approvals, setApprovals] = useState<ApprovalsDto | null>(null)
  const [jobs, setJobs] = useState<GitlabJob[]>([])
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadDiscussions = useCallback(async () => {
    try {
      const page = await gitlabMrDiscussions({ projectId, iid: mr.iid })
      setDiscussions(page.items)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [projectId, mr.iid])

  const loadApprovals = useCallback(async () => {
    try {
      setApprovals(await gitlabApprovals({ projectId, iid: mr.iid }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [projectId, mr.iid])

  const loadJobs = useCallback(async () => {
    try {
      const page = await gitlabMrJobs({ projectId, iid: mr.iid })
      setJobs(page.items)
      setPipelineId(page.pipelineId ?? null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [projectId, mr.iid])

  useEffect(() => {
    setDiscussions([])
    setApprovals(null)
    setJobs([])
    setLog(null)
    setInline(false)
    setRefs(null)
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
    void gitlabMrDiffRefs({ projectId, iid: mr.iid })
      .then(setRefs)
      .catch((cause) => setError(errorMessage(cause)))
  }, [inline, refs, projectId, mr.iid])

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

  const send = async () => {
    if (!body.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (replyTo) {
        await gitlabDiscussionReply({
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
        await gitlabDiscussionCreate({
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
      setLog({ job, value: await gitlabJobLog({ projectId, jobId: job.id }) })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const approval = approvals?.state

  return (
    <div className={p2.stack}>
      <div className={p2.tabs} style={{ padding: '4px 0', borderBottom: 0 }}>
        {(['overview', 'discussions', 'jobs'] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            className={tab === value ? p2.tabOn : p2.tab}
            onClick={() => setTab(value)}
          >
            {value === 'overview'
              ? 'Overview'
              : value === 'discussions'
                ? `Discussions (${discussions.length})`
                : 'Jobs'}
          </button>
        ))}
      </div>

      {error ? <p className={p2.errorText}>{error}</p> : null}
      {notice ? <p className={p2.notice}>{notice}</p> : null}

      {tab === 'overview' ? (
        <div className={p2.stack}>
          <div className={p2.card}>
            <div className={p2.row}>
              <span className={p2.mono}>
                {mr.sourceBranch} → {mr.targetBranch}
              </span>
              <span className={p2.pill}>{mr.state}</span>
              {mr.hasConflicts ? <span className={p2.warn}>conflits</span> : null}
            </div>
            <div className={p2.row} style={{ marginTop: 8 }}>
              <span className={p2.small}>
                CI : {mr.headPipeline?.status ?? 'inconnu'} ·{' '}
                {mr.detailedMergeStatus ?? mr.mergeStatus ?? 'statut inconnu'}
              </span>
              <span className={p2.spacer} />
              <button type="button" className={p2.ghost} onClick={() => void openExternalUrl(mr.webUrl)}>
                Ouvrir dans GitLab
              </button>
              <button type="button" className={p2.secondary} onClick={() => onCheckout(mr.sourceBranch)}>
                Checkout la branche
              </button>
            </div>
          </div>

          <div className={p2.card}>
            <h3 className={p2.cardTitle}>Approbations</h3>
            {approvals === null ? (
              <p className={p2.notice}>Chargement…</p>
            ) : approvals.available && approval ? (
              <>
                <p className={p2.small}>
                  {approval.approvedBy.length} approbation(s) ·{' '}
                  {approval.approvalsLeft} restante(s) · {approval.approvalsRequired} requise(s)
                </p>
                <div className={p2.row}>
                  {approval.approvedBy.map((entry) => (
                    <span key={entry.user.id} className={p2.pill}>
                      @{entry.user.username}
                    </span>
                  ))}
                  <span className={p2.spacer} />
                  <button
                    type="button"
                    className={p2.secondary}
                    disabled={busy}
                    onClick={() =>
                      void run('Approbation enregistrée.', async () => {
                        setApprovals(await gitlabApprove({ projectId, iid: mr.iid }))
                      })
                    }
                  >
                    Approuver
                  </button>
                  <button
                    type="button"
                    className={p2.ghost}
                    disabled={busy}
                    onClick={() =>
                      void run('Approbation retirée.', async () => {
                        setApprovals(await gitlabUnapprove({ projectId, iid: mr.iid }))
                      })
                    }
                  >
                    Retirer mon approbation
                  </button>
                </div>
              </>
            ) : (
              <p className={p2.notice}>{approvals.reason ?? 'Approbations indisponibles.'}</p>
            )}
          </div>

          <div className={p2.card}>
            <h3 className={p2.cardTitle}>Fusion</h3>
            <div className={p2.row}>
              <label className={p2.field}>
                Stratégie
                <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
                  <option value="merge">Merge commit</option>
                  <option value="rebase_merge">Rebase merge</option>
                </select>
              </label>
              <label className={p2.checkbox}>
                <input type="checkbox" checked={squash} onChange={(event) => setSquash(event.target.checked)} />
                squash
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={removeSource}
                  onChange={(event) => setRemoveSource(event.target.checked)}
                />
                supprimer la branche source
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={autoMerge}
                  onChange={(event) => setAutoMerge(event.target.checked)}
                />
                auto-merge si la pipeline réussit
              </label>
              <span className={p2.spacer} />
              <button type="button" className={p2.primary} disabled={busy} onClick={() => setMergeOpen(true)}>
                Merge into {mr.targetBranch}
              </button>
            </div>
            <p className={p2.notice}>
              Le merge utilise le SHA courant {mr.sha ? mr.sha.slice(0, 10) : '(inconnu)'} ;
              si la MR a changé, GitLab répond 409 et rien n’est fusionné.
            </p>
          </div>
        </div>
      ) : null}

      {tab === 'discussions' ? (
        <div className={p2.stack}>
          {[...discussions]
            .sort((a, b) => {
              const left = a.notes.find((note) => note.position)?.position
              const right = b.notes.find((note) => note.position)?.position
              const leftKey = `${left?.newPath ?? left?.oldPath ?? ''}:${left?.newLine ?? left?.oldLine ?? 0}`
              const rightKey = `${right?.newPath ?? right?.oldPath ?? ''}:${right?.newLine ?? right?.oldLine ?? 0}`
              return leftKey.localeCompare(rightKey, undefined, { numeric: true })
            })
            .map((discussion, discussionIndex, ordered) => {
            const position = discussion.notes.find((note) => note.position)?.position
            const previous = ordered[discussionIndex - 1]
              ?.notes.find((note) => note.position)?.position
            const currentPath = position?.newPath ?? position?.oldPath
            const previousPath = previous?.newPath ?? previous?.oldPath
            const showPathHeader = Boolean(currentPath) && currentPath !== previousPath
            const resolvable = discussion.notes.some((note) => note.resolvable)
            const resolved = discussion.notes.every((note) => !note.resolvable || note.resolved)
            return (
              <div key={discussion.id} className={p2.discussion}>
                {showPathHeader ? (
                  <strong className={p2.mono}>{currentPath}</strong>
                ) : null}
                {position ? (
                  <span className={p2.listSub}>
                    {position.newPath ?? position.oldPath}
                    {position.newLine ? `:${position.newLine}` : position.oldLine ? `:${position.oldLine}` : ''}
                  </span>
                ) : null}
                {discussion.notes.map((note) => (
                  <div key={note.id}>
                    <div className={p2.discussionHeader}>
                      <span className={p2.avatar}>{note.author.name.slice(0, 1)}</span>
                      <span>@{note.author.username}</span>
                      <span>{note.createdAt?.slice(0, 16).replace('T', ' ')}</span>
                      {note.system ? <span className={p2.badge}>system</span> : null}
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
                    Répondre
                  </button>
                  {resolvable ? (
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() =>
                        void run(resolved ? 'Thread rouvert.' : 'Thread résolu.', async () => {
                          await gitlabDiscussionResolve({
                            projectId,
                            iid: mr.iid,
                            discussionId: discussion.id,
                            resolved: !resolved,
                          })
                          await loadDiscussions()
                        })
                      }
                    >
                      {resolved ? 'Rouvrir' : 'Résoudre'}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
          {discussions.length === 0 ? <p className={p2.notice}>Aucune discussion.</p> : null}

          <div className={p2.card}>
            <div className={p2.between}>
              <strong>
                {replyTo ? 'Répondre au thread' : inline ? 'Commentaire inline' : 'Nouvelle discussion'}
              </strong>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={inline}
                  onChange={(event) => {
                    setInline(event.target.checked)
                    setReplyTo(null)
                  }}
                />
                positionné sur le diff
              </label>
            </div>
            {inline ? (
              <div className={p2.row} style={{ marginTop: 8 }}>
                <label className={p2.field}>
                  Chemin
                  <input
                    value={positionPath}
                    onChange={(event) => setPositionPath(event.target.value)}
                    placeholder="src/file.ts"
                    spellCheck={false}
                  />
                </label>
                <label className={p2.field}>
                  Ligne
                  <input
                    value={positionLine}
                    onChange={(event) => setPositionLine(event.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className={p2.field}>
                  Côté
                  <select
                    value={positionSide}
                    onChange={(event) => setPositionSide(event.target.value as 'new' | 'old')}
                  >
                    <option value="new">nouveau</option>
                    <option value="old">ancien</option>
                  </select>
                </label>
                <span className={p2.listSub}>
                  {refs
                    ? `diff_refs ${refs.headSha.slice(0, 8)}`
                    : 'chargement des diff_refs…'}
                </span>
              </div>
            ) : null}
            <textarea
              className={p2.editor}
              style={{ minHeight: 80, marginTop: 8 }}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Écrire un commentaire (texte brut, aucun HTML rendu)…"
            />
            <div className={p2.row}>
              <button
                type="button"
                className={p2.primary}
                disabled={busy || !body.trim() || (inline && !refs)}
                onClick={() => void send()}
              >
                Envoyer
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
                  Annuler
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'jobs' ? (
        <div className={p2.stack}>
          <div className={p2.between}>
            <span className={p2.small}>
              Pipeline {pipelineId ?? '—'} · {jobs.length} job(s)
            </span>
            <button type="button" className={p2.ghost} onClick={() => void loadJobs()}>
              Rafraîchir
            </button>
          </div>
          {jobs.map((job) => (
            <div key={job.id} className={p2.jobRow}>
              <span>
                {job.stage} / {job.name}
              </span>
              <span className={p2.mono}>#{job.id}</span>
              <span
                className={
                  job.status === 'success'
                    ? p2.good
                    : job.status === 'failed'
                      ? p2.bad
                      : p2.warn
                }
              >
                {job.status}
              </span>
              <span className={p2.row}>
                <button type="button" className={p2.ghost} disabled={busy} onClick={() => void showLog(job)}>
                  Logs
                </button>
                {job.webUrl ? (
                  <button type="button" className={p2.ghost} onClick={() => void openExternalUrl(job.webUrl!)}>
                    Ouvrir
                  </button>
                ) : null}
              </span>
            </div>
          ))}
          {jobs.length === 0 ? <p className={p2.notice}>Aucun job pour ce pipeline.</p> : null}
          {log ? (
            <div className={p2.stack}>
              <div className={p2.between}>
                <span className={p2.small}>
                  {log.job.name} · {log.value.bytes} octets
                  {log.value.truncated ? ' · tronqué' : ''}
                </span>
                <span className={p2.row}>
                  {log.value.nextOffset ? (
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        void gitlabJobLog({
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
                      Charger la suite
                    </button>
                  ) : null}
                  <button type="button" className={p2.ghost} onClick={() => setLog(null)}>
                    Fermer
                  </button>
                </span>
              </div>
              <pre className={p2.log}>{log.value.text}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={mergeOpen}
        title={`Fusionner !${mr.iid}`}
        consequence={`La merge request sera fusionnée dans ${mr.targetBranch} avec la stratégie ${strategy}${squash ? ', squashée' : ''}${autoMerge ? ', automatiquement dès que la pipeline réussit' : ''}. Le SHA courant est vérifié.`}
        confirmLabel="Fusionner"
        busy={busy}
        onCancel={() => setMergeOpen(false)}
        onConfirm={() => {
          setMergeOpen(false)
          void run('Merge request fusionnée.', () =>
            gitlabMergeMr({
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
