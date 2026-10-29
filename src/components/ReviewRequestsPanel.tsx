import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openExternalUrl, refsGet, statusGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { ForgeApi, ForgeMergeRequest, ForgeNotice, ForgeScope } from '../lib/forge'
import type {
  GitlabPipeline,
  RefEntry,
  RepoLink,
} from '../types/git'
import type { PipelineState } from '../types/git'
import { pipelineState } from '../lib/pipeline'
import { MrDetailExtras } from './MrDetailExtras'
import { Dialog } from './ui/Dialog'
import p2 from './p2.module.css'

type Props = {
  api: ForgeApi
  repoId: string | null
  generation: number
  connected: boolean
  onCheckout: (branch: string) => void
}

function pipelineTone(state: PipelineState): string {
  switch (state) {
    case 'success':
      return 'good'
    case 'failed':
      return 'bad'
    case 'running':
    case 'pending':
      return 'warn'
    case 'canceled':
      return 'bad'
    default:
      return ''
  }
}

function pipelineChip(state: PipelineState): string {
  switch (state) {
    case 'success':
      return p2.chipGood
    case 'failed':
      return p2.chipBad
    case 'running':
    case 'pending':
      return p2.chipWarn
    default:
      return ''
  }
}

export function ReviewRequestsPanel({ api, repoId, generation, connected, onCheckout }: Props) {
  const { t } = useI18n()
  const [link, setLink] = useState<RepoLink | null>(null)
  const [scope, setScope] = useState<ForgeScope>('createdByMe')
  const [items, setItems] = useState<ForgeMergeRequest[]>([])
  const [nextPage, setNextPage] = useState<number | undefined>()
  const [selected, setSelected] = useState<ForgeMergeRequest | null>(null)
  const [pipelines, setPipelines] = useState<GitlabPipeline[]>([])
  const [branches, setBranches] = useState<RefEntry[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('main')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(false)
  const [removeSource, setRemoveSource] = useState(false)
  const [squash, setSquash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<ForgeNotice>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const detailRequest = useRef(0)

  const projectId = link?.projectId
  const noun = t(api.nounKey)
  const forgeTitle = t(api.titleKey)

  const loadLink = useCallback(async () => {
    if (!repoId) {
      return
    }
    try {
      setLink(await api.linkGet(repoId))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api, repoId])

  useEffect(() => {
    void loadLink()
  }, [loadLink, generation])

  useEffect(() => {
    if (!repoId) {
      return
    }
    let cancelled = false
    void Promise.all([refsGet(repoId), statusGet(repoId)])
      .then(([refs, status]) => {
        if (cancelled) {
          return
        }
        const local = refs.data.entries.filter((entry) => entry.kind === 'branch')
        setBranches(local)
        const current = status.data.branch.head ?? ''
        setCurrentBranch(current)
        setSource((value) => value || current)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId, generation])

  const load = useCallback(
    async (next = 1, append = false) => {
      if (!connected) {
        return
      }
      if (scope === 'project' && !projectId) {
        setItems([])
        setNextPage(undefined)
        return
      }
      setBusy(true)
      setError(null)
      try {
        const pageResult = await api.mrPage({
          projectId: scope === 'project' ? projectId : undefined,
          scope,
          page: next,
          perPage: 25,
          repoId: scope === 'project' ? (repoId ?? undefined) : undefined,
        })
        setItems((current) =>
          append ? [...current, ...pageResult.items] : pageResult.items,
        )
        setNextPage(pageResult.nextPage)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [api, connected, projectId, repoId, scope],
  )

  useEffect(() => {
    if (connected) {
      void load(1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, scope, projectId, load])

  // Active refresh: 30 s while visible, paused when the window is hidden.
  useEffect(() => {
    if (!connected || !selected || !projectId) {
      return
    }
    let disposed = false
    const tick = async () => {
      if (document.hidden || disposed) {
        return
      }
      try {
        const pid = selected.projectId ?? projectId
        if (!pid) {
          return
        }
        const detail = await api.mrGet(pid, selected.iid)
        if (disposed) {
          return
        }
        setSelected((current) => (current?.iid === selected.iid ? detail : current))
        const pipes = await api.pipelines(pid, selected.iid)
        if (!disposed) {
          setPipelines(pipes)
        }
      } catch {
        // A transient failure keeps the last known state.
      }
    }
    const timer = window.setInterval(() => void tick(), 30_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [api, connected, projectId, selected])

  const associate = async () => {
    if (!repoId) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const linked = await api.link(repoId)
      setLink(linked)
      setNotice({
        key: 'forge.review.associateNotice',
        params: { path: linked.pathWithNamespace },
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (mr: ForgeMergeRequest) => {
    const token = ++detailRequest.current
    setSelected(mr)
    setPipelines([])
    const pid = mr.projectId ?? projectId
    if (!pid && !mr.repositoryName) {
      setError(
        t('forge.review.unknownProject', {
          short: api.short,
          noun,
          label: api.label,
        }),
      )
      return
    }
    try {
      const detail = await api.mrGet(pid ?? 0, mr.iid, mr.repositoryName)
      if (token !== detailRequest.current) {
        return
      }
      setSelected(detail)
      const resolved = detail.projectId ?? pid
      const pipes = resolved ? await api.pipelines(resolved, mr.iid) : []
      if (token === detailRequest.current) {
        setPipelines(pipes)
      }
    } catch (cause) {
      if (token === detailRequest.current) {
        setError(errorMessage(cause))
      }
    }
  }

  const create = async () => {
    if (!repoId) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await api.mrCreate({
        repoId,
        projectId: projectId,
        sourceBranch: source,
        targetBranch: target,
        title,
        description,
        draft,
        removeSourceBranch: api.capabilities.createMergeOptions ? removeSource : undefined,
        squash: api.capabilities.createMergeOptions ? squash : undefined,
      })
      setNotice({
        key: 'forge.review.created',
        params: {
          short: api.short,
          ref: api.short === 'MR' ? '!' : '#',
          iid: created.iid,
          title: created.title,
        },
      })
      setTitle('')
      setDescription('')
      setCreateOpen(false)
      void load(1)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const branchOptions = useMemo(
    () => branches.map((branch) => branch.name),
    [branches],
  )

  const selectedPipeline = selected?.headPipeline
  const selectedState = pipelineState(selectedPipeline?.status)
  const createDisabled =
    busy ||
    !connected ||
    !projectId ||
    !title.trim() ||
    !source ||
    !target.trim()

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <span className={p2.chip}>
          {link ? link.pathWithNamespace : t('forge.review.noProject')}
        </span>
        <button
          type="button"
          className={p2.ghost}
          disabled={busy || !repoId}
          onClick={() => void associate()}
        >
          {t('forge.review.associate')}
        </button>
        {link ? (
          <button
            type="button"
            className={p2.ghost}
            onClick={() => void openExternalUrl(link.webUrl)}
          >
            {t('forge.review.openProvider', { label: api.label })}
          </button>
        ) : null}

        <div className={p2.segmented} role="group" aria-label={t('forge.review.filterAria')}>
          {api.scopes.map((option) => (
            <button
              key={option.value}
              type="button"
              className={scope === option.value ? p2.segmentOn : p2.segment}
              aria-pressed={scope === option.value}
              onClick={() => setScope(option.value)}
            >
              {t(option.labelKey, { short: api.short })}
            </button>
          ))}
        </div>

        <span className={p2.spacer} />
        <button
          type="button"
          className={p2.ghost}
          disabled={busy || !connected}
          onClick={() => void load(1)}
        >
          {t('common.refresh')}
        </button>
        <button
          type="button"
          className={p2.primary}
          disabled={!connected || !projectId}
          onClick={() => setCreateOpen(true)}
        >
          {t('forge.review.new', { short: api.short })}
        </button>
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className={p2.listHeader} role="status">
          <span className={p2.meta}>{t(notice.key, notice.params)}</span>
        </div>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.inbox}>
          <div className={p2.listHeader}>
            <span className={p2.label}>{forgeTitle}</span>
            <span className={`${p2.count} ${p2.tabnum}`}>{items.length}</span>
            <span className={p2.spacer} />
            {busy ? <span className={p2.count}>{t('forge.review.loadingMeta')}</span> : null}
          </div>

          <div className={p2.scroller} role="list">
            {items.map((mr) => {
              const mrState = pipelineState(mr.headPipeline?.status)
              return (
                <button
                  key={`${mr.projectId ?? projectId ?? 0}:${mr.iid}`}
                  type="button"
                  role="listitem"
                  className={p2.entry}
                  aria-current={selected?.iid === mr.iid ? 'true' : undefined}
                  onClick={() => void openDetail(mr)}
                >
                  <span
                    className={p2.dot}
                    data-tone={pipelineTone(mrState) || undefined}
                    title={mr.headPipeline?.status ?? t('forge.review.noCi')}
                  />
                  <span className={p2.entryStack}>
                    <span className={p2.entryTitle}>
                      <strong className={p2.mono}>
                        {api.short} {mr.iid}
                      </strong>{' '}
                      {mr.title}
                    </span>
                    <span className={p2.entryMeta}>
                      <span className={p2.mono}>
                        {mr.sourceBranch || '?'} → {mr.targetBranch || '?'}
                      </span>
                      <span>·</span>
                      <span>@{mr.author.username}</span>
                    </span>
                    <span className={p2.entryMeta}>
                      {mr.draft ? <span className={p2.chip}>{t('forge.review.draft')}</span> : null}
                      {mr.hasConflicts ? (
                        <span className={`${p2.chip} ${p2.chipWarn}`}>{t('forge.review.conflicts')}</span>
                      ) : null}
                      <span className={`${p2.chip} ${pipelineChip(mrState)}`}>
                        {mr.headPipeline?.status ?? t('forge.review.withoutCi')}
                      </span>
                      {mr.labels.slice(0, 2).map((label) => (
                        <span key={label} className={p2.chip}>
                          {label}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className={p2.meta} aria-hidden="true">
                    {selected?.iid === mr.iid ? '•' : '→'}
                  </span>
                </button>
              )
            })}
          </div>

          {items.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>
                {busy
                  ? t('common.loading')
                  : !connected
                    ? t('forge.review.emptyConnected', { label: api.label })
                    : !link
                      ? t('forge.review.emptyLink')
                      : t('forge.review.emptyNone', { noun })}
              </h2>
              {!busy ? (
                <p>
                  {!connected
                    ? t('forge.review.emptyConnectedHint', { label: api.label })
                    : !link
                      ? t('forge.review.emptyLinkHint')
                      : t('forge.review.emptyFilterHint', { title: forgeTitle.toLowerCase() })}
                </p>
              ) : null}
            </div>
          ) : null}

          {nextPage ? (
            <div className={p2.footerBar}>
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.secondary}
                disabled={busy}
                onClick={() => void load(nextPage, true)}
              >
                {t('forge.review.nextPage')}
              </button>
            </div>
          ) : null}
        </div>

        <div className={p2.detailPane}>
          {selected ? (
            <>
              <header className={p2.detailHeader}>
                <div className={p2.detailHeaderTop}>
                  <div className={p2.entryStack}>
                    <span className={`${p2.label} ${p2.mono}`}>
                      {api.short} {selected.iid} · {selected.state}
                    </span>
                    <h2 className={p2.detailTitle}>{selected.title}</h2>
                  </div>
                  <div className={p2.entryActions}>
                    <button
                      type="button"
                      className={p2.secondary}
                      onClick={() => void openExternalUrl(selected.webUrl)}
                    >
                      {t('forge.review.openIn', { label: api.label })}
                    </button>
                    <button
                      type="button"
                      className={p2.primary}
                      onClick={() => onCheckout(selected.sourceBranch)}
                    >
                      {t('forge.review.checkout')}
                    </button>
                  </div>
                </div>
                <div className={p2.detailMeta}>
                  <span className={p2.mono}>
                    {selected.sourceBranch || '?'} → {selected.targetBranch || '?'}
                  </span>
                  <span>·</span>
                  <span>@{selected.author.username}</span>
                  <span>·</span>
                  <span className={`${p2.chip} ${pipelineChip(selectedState)}`}>
                    {t('forge.review.ciStatus', {
                      status: selectedPipeline?.status ?? t('forge.review.ciUnknown'),
                    })}
                  </span>
                  {selected.detailedMergeStatus ?? selected.mergeStatus ? (
                    <span>{selected.detailedMergeStatus ?? selected.mergeStatus}</span>
                  ) : null}
                  {selected.hasConflicts ? (
                    <span className={`${p2.chip} ${p2.chipWarn}`}>{t('forge.review.conflicts')}</span>
                  ) : null}
                  {selected.userNotesCount > 0 ? (
                    <span className={p2.count}>
                      {t('forge.review.notes', { count: selected.userNotesCount })}
                    </span>
                  ) : null}
                </div>
              </header>
              <MrDetailExtras
                api={api}
                projectId={selected.projectId ?? projectId ?? 0}
                mr={selected}
                pipelines={pipelines}
                onRefresh={() => void openDetail(selected)}
              />
            </>
          ) : (
            <div className={p2.empty}>
              <h2>{t('forge.review.selectOne', { short: api.short })}</h2>
              <p>{t('forge.review.selectHint')}</p>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        busy={busy}
        titleId={`create-${api.id}-title`}
        className={p2.dialogWide}
      >
        <h2 id={`create-${api.id}-title`}>{t('forge.create.title', { noun })}</h2>
        <p className={p2.asideHint}>
          {t('forge.create.hint', { label: api.label })}
        </p>

        <div className={p2.formRow}>
          <label className={p2.field}>
            {t('forge.create.sourceBranch')}
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label={t('forge.create.sourceBranch')}
            >
              {branchOptions.length === 0 ? (
                <option value={source}>{source || 'source'}</option>
              ) : null}
              {branchOptions.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
          <label className={p2.field}>
            {t('forge.create.targetBranch')}
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="main"
              aria-label={t('forge.create.targetBranch')}
            />
          </label>
        </div>

        <label className={p2.field}>
          {t('forge.create.mrTitle', { short: api.short })}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('forge.create.mrTitle', { short: api.short })}
            aria-label={t('forge.create.mrTitle', { short: api.short })}
          />
        </label>
        <label className={p2.field}>
          {t('forge.create.description')}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('forge.create.descriptionPlaceholder')}
            rows={5}
            aria-label={t('forge.create.descriptionAria', { short: api.short })}
          />
        </label>

        <div className={p2.row}>
          <label className={p2.checkbox}>
            <input
              type="checkbox"
              checked={draft}
              onChange={(event) => setDraft(event.target.checked)}
            />
            {t('forge.create.draft')}
          </label>
          {api.capabilities.createMergeOptions ? (
            <>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={removeSource}
                  onChange={(event) => setRemoveSource(event.target.checked)}
                />
                {t('forge.create.removeSource')}
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={squash}
                  onChange={(event) => setSquash(event.target.checked)}
                />
                {t('forge.create.squash')}
              </label>
            </>
          ) : null}
        </div>

        <p className={p2.asideHint}>
          {t('forge.create.currentBranch', {
            branch: currentBranch || t('forge.create.currentBranchUnknown'),
          })}
        </p>

        <div className={p2.dialogActions}>
          <button type="button" className={p2.ghost} onClick={() => setCreateOpen(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={p2.primary}
            disabled={createDisabled}
            onClick={() => void create()}
          >
            {t('forge.create.submit', { short: api.short })}
          </button>
        </div>
      </Dialog>
    </div>
  )
}
