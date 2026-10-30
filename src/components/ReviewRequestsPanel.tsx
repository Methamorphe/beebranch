import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import {
  branchCreate,
  branchPreflight,
  openExternalUrl,
  refsGet,
  remoteAdd,
  remoteList,
  statusGet,
  syncFetch,
  worktreeAdd,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { ForgeApi, ForgeMergeRequest, ForgeNotice, ForgeScope } from '../lib/forge'
import type {
  GitlabPipeline,
  RefEntry,
  RemoteInfo,
  RepoLink,
} from '../types/git'
import type { PipelineState } from '../types/git'
import { pipelineState } from '../lib/pipeline'
import {
  matchesReviewFilter,
  parseReviewFilter,
  reviewFilterSuggestions,
} from '../lib/mrFilter'
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

/**
 * Aggregate GitHub check runs into a single status: the worst check wins, so a
 * failing job still turns the badge red. GitHub leaves `headPipeline` empty and
 * exposes the checks through the pipelines call.
 */
function checksStatus(checks: GitlabPipeline[]): string | undefined {
  if (checks.length === 0) {
    return undefined
  }
  const states = checks.map((check) => pipelineState(check.status))
  if (states.includes('failed')) {
    return 'failed'
  }
  if (states.includes('canceled')) {
    return 'canceled'
  }
  if (states.includes('running')) {
    return 'running'
  }
  if (states.includes('pending')) {
    return 'pending'
  }
  return states.includes('unknown') ? 'unknown' : 'success'
}

/**
 * Stable identity of a review request: search results only carry the
 * repository name, detail responses only the numeric id.
 */
/**
 * Comma-separated names, trimmed, blanks dropped, duplicates collapsed.
 *
 * The create form collects free text; sending an empty name would make the
 * provider reject the whole creation.
 */
function splitNames(value: string): string[] {
  const names: string[] = []
  for (const part of value.split(',')) {
    const name = part.trim().replace(/^@/, '')
    if (name && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

function mrKey(mr: ForgeMergeRequest): string {
  return `${mr.projectId ?? mr.repositoryName ?? ''}:${mr.iid}`
}

export function ReviewRequestsPanel({ api, repoId, generation, connected, onCheckout }: Props) {
  const { t } = useI18n()
  const [link, setLink] = useState<RepoLink | null>(null)
  const [scope, setScope] = useState<ForgeScope>('createdByMe')
  const [items, setItems] = useState<ForgeMergeRequest[]>([])
  const [nextPage, setNextPage] = useState<number | undefined>()
  const [selected, setSelected] = useState<ForgeMergeRequest | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pipelines, setPipelines] = useState<GitlabPipeline[]>([])
  // GitHub leaves `headPipeline` empty on list and detail payloads; the check
  // runs fetched for a request are remembered per repository so its badge stays
  // stable once visited.
  const [checksByKey, setChecksByKey] = useState<Record<string, string>>({})
  const [branches, setBranches] = useState<RefEntry[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('main')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(false)
  /** Comma-separated names, parsed at submission. */
  const [reviewerNames, setReviewerNames] = useState('')
  const [assigneeNames, setAssigneeNames] = useState('')
  const [labelNames, setLabelNames] = useState('')
  const [removeSource, setRemoveSource] = useState(false)
  const [squash, setSquash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<ForgeNotice>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  /** Request whose branch is not fetched yet; the dialog offers a remote. */
  const [checkout, setCheckout] = useState<{
    branch: string
    mode: 'switch' | 'worktree'
    remotes: RemoteInfo[]
  } | null>(null)
  const [checkoutRemote, setCheckoutRemote] = useState('')
  const [checkoutRemoteName, setCheckoutRemoteName] = useState('fork')
  const [checkoutRemoteUrl, setCheckoutRemoteUrl] = useState('')
  const [checkoutPath, setCheckoutPath] = useState('')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const detailRequest = useRef(0)

  const projectId = link?.projectId
  const noun = t(api.nounKey)
  const forgeTitle = t(api.titleKey)
  const filter = useMemo(() => parseReviewFilter(filterText), [filterText])
  const completions = useMemo(() => reviewFilterSuggestions(items), [items])
  const visible = useMemo(
    () => items.filter((mr) => matchesReviewFilter(mr, filter)),
    [items, filter],
  )

  // Search results may reference a repository that is not cached yet: they only
  // carry `repositoryName`, and the active tab project must never stand in for
  // it. Falling back to the linked project stays valid for GitLab, whose list
  // items always carry their own `projectId`.
  const projectIdFor = useCallback(
    (mr: ForgeMergeRequest) =>
      mr.projectId ?? (mr.repositoryName ? undefined : projectId),
    [projectId],
  )

  const rememberChecks = useCallback(
    (key: string, checks: GitlabPipeline[]) => {
      if (api.id !== 'github') {
        return
      }
      const status = checksStatus(checks)
      setChecksByKey((current) => {
        if (current[key] === status || (status === undefined && !(key in current))) {
          return current
        }
        const next = { ...current }
        if (status) {
          next[key] = status
        } else {
          delete next[key]
        }
        return next
      })
    },
    [api.id],
  )

  // One GraphQL round trip fills the badge of the whole page: no per-request
  // fan-out. A provider without a rollup keeps the badges learned when a
  // request was visited.
  useEffect(() => {
    if (!api.checkRollups || !projectId || items.length === 0) {
      return
    }
    let cancelled = false
    const numbers = [...new Set(items.map((item) => item.iid))]
    api
      .checkRollups(projectId, numbers)
      .then((rollups) => {
        if (cancelled) {
          return
        }
        setChecksByKey((current) => {
          const next = { ...current }
          for (const rollup of rollups) {
            const item = items.find((entry) => entry.iid === rollup.iid)
            if (!item) {
              continue
            }
            const key = mrKey(item)
            if (rollup.status) {
              next[key] = rollup.status
            } else {
              delete next[key]
            }
          }
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, items, projectId])

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

  // A filter must see the whole listing, not just the first page: load the
  // remaining pages up to the same ceiling the rest of the panel uses.
  useEffect(() => {
    if (filter.tokens.length === 0 || !nextPage || busy || items.length >= 250) {
      return
    }
    void load(nextPage, true)
  }, [busy, filter, items.length, load, nextPage])

  const pickWorktreePath = async (): Promise<string | undefined> => {
    try {
      const picked = await openNativeDialog({ directory: true, multiple: false })
      return typeof picked === 'string' ? picked : undefined
    } catch (cause) {
      setError(errorMessage(cause))
      return undefined
    }
  }

  const finishCheckout = async (
    branch: string,
    mode: 'switch' | 'worktree',
    options: { localExists: boolean; reference: string; path?: string },
  ) => {
    if (!repoId) {
      return
    }
    if (mode === 'switch') {
      if (!options.localExists) {
        await branchCreate({
          repoId,
          name: branch,
          start: options.reference,
          checkout: true,
        })
      }
      // The parent performs the switch, refreshes the graph and reports it.
      onCheckout(branch)
      return
    }
    const path = options.path?.trim()
    if (!path) {
      setError(t('forge.review.worktreePathRequired'))
      return
    }
    await worktreeAdd({
      repoId,
      path,
      reference: options.reference,
      newBranch: options.localExists ? undefined : branch,
    })
    setNotice({
      key: 'forge.review.worktreeDone',
      params: { branch, path },
    })
  }

  /** Check out a request's branch, fetching it first when the repository lacks it. */
  const checkoutRequest = async (
    mr: ForgeMergeRequest,
    mode: 'switch' | 'worktree',
  ) => {
    if (!repoId) {
      return
    }
    const branch = mr.sourceBranch
    if (!branch) {
      setError(t('forge.review.checkoutNoBranch'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const [preflight, refs] = await Promise.all([
        branchPreflight(repoId, branch),
        refsGet(repoId),
      ])
      const remoteRef = refs.data.entries.find(
        (entry) =>
          entry.kind === 'remoteBranch' && entry.name.endsWith(`/${branch}`),
      )
      const localExists = preflight.exists
      if (localExists || remoteRef) {
        let path: string | undefined
        if (mode === 'worktree') {
          path = await pickWorktreePath()
          if (!path) {
            return
          }
        }
        if (!localExists && remoteRef) {
          await syncFetch(repoId, remoteRef.remote ?? refs.data.remotes[0] ?? 'origin')
        }
        await finishCheckout(branch, mode, {
          localExists,
          reference: localExists ? branch : (remoteRef?.fullName ?? branch),
          path,
        })
        return
      }
      setCheckout({ branch, mode, remotes: await remoteList(repoId) })
      setCheckoutRemote(refs.data.remotes[0] ?? '')
      setCheckoutRemoteName('fork')
      setCheckoutRemoteUrl('')
      setCheckoutPath('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Fetch a chosen remote (adding it first when a URL is given) then check out. */
  const confirmCheckout = async () => {
    if (!repoId || !checkout) {
      return
    }
    setCheckoutBusy(true)
    setError(null)
    try {
      const url = checkoutRemoteUrl.trim()
      const remote = url ? checkoutRemoteName.trim() : checkoutRemote
      if (!remote) {
        setError(t('forge.review.checkoutRemoteRequired'))
        return
      }
      if (checkout.mode === 'worktree' && !checkoutPath.trim()) {
        setError(t('forge.review.worktreePathRequired'))
        return
      }
      if (url) {
        await remoteAdd({ repoId, name: remote, url })
      }
      await syncFetch(repoId, remote)
      const refs = await refsGet(repoId)
      const remoteRef =
        refs.data.entries.find(
          (entry) =>
            entry.kind === 'remoteBranch' &&
            entry.remote === remote &&
            entry.name === `${remote}/${checkout.branch}`,
        ) ??
        refs.data.entries.find(
          (entry) =>
            entry.kind === 'remoteBranch' &&
            entry.name.endsWith(`/${checkout.branch}`),
        )
      if (!remoteRef) {
        setError(
          t('forge.review.branchNotFound', {
            branch: checkout.branch,
            remote,
          }),
        )
        return
      }
      await finishCheckout(checkout.branch, checkout.mode, {
        localExists: false,
        reference: remoteRef.fullName,
        path: checkoutPath,
      })
      setCheckout(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCheckoutBusy(false)
    }
  }

  // Active refresh: 30 s while visible, paused when the window is hidden.
  useEffect(() => {
    if (!connected || !selected) {
      return
    }
    const pid = projectIdFor(selected)
    if (!pid) {
      // The repository of a search result is only known once its detail has
      // been resolved; selecting it again restarts this effect.
      return
    }
    let disposed = false
    const tick = async () => {
      if (document.hidden || disposed) {
        return
      }
      try {
        const detail = await api.mrGet(pid, selected.iid, selected.repositoryName)
        if (disposed) {
          return
        }
        setSelected((current) => (current?.iid === selected.iid ? detail : current))
        const pipes = await api.pipelines(pid, selected.iid)
        if (!disposed) {
          setPipelines(pipes)
          rememberChecks(mrKey(detail), pipes)
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
  }, [api, connected, projectIdFor, rememberChecks, selected])

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
    setSelectedKey(mrKey(mr))
    setPipelines([])
    const pid = projectIdFor(mr)
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
      setSelectedKey(mrKey(detail))
      if (detail.projectId !== undefined && detail.projectId !== mr.projectId) {
        // A search result resolved by repository name now knows its numeric id:
        // keep the list row and the detail on the same identity.
        const clicked = mrKey(mr)
        setItems((current) =>
          current.map((item) =>
            mrKey(item) === clicked ? { ...item, projectId: detail.projectId } : item,
          ),
        )
      }
      const resolved = detail.projectId ?? pid
      const pipes = resolved ? await api.pipelines(resolved, mr.iid) : []
      if (token === detailRequest.current) {
        setPipelines(pipes)
        rememberChecks(mrKey(detail), pipes)
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
        reviewers: splitNames(reviewerNames),
        assignees: splitNames(assigneeNames),
        labels: splitNames(labelNames),
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
      setReviewerNames('')
      setAssigneeNames('')
      setLabelNames('')
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

  const detailProjectId = selected ? projectIdFor(selected) : undefined
  // Both the header and the matching list row read the same source: GitLab
  // fills `headPipeline`, GitHub only publishes the latest check runs of the
  // head commit through `pipelines`.
  const selectedStatus = selected
    ? (selected.headPipeline?.status ?? checksByKey[mrKey(selected)])
    : undefined
  const selectedState = pipelineState(selectedStatus)
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
        <label className={p2.field}>
          <input
            list="review-filter-suggestions"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder={t('forge.review.filterPlaceholder')}
            aria-label={t('forge.review.filterInputAria')}
            spellCheck={false}
          />
          <datalist id="review-filter-suggestions">
            {completions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
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
      {filter.unknown.length > 0 ? (
        <p className={p2.alert} role="alert">
          {t('forge.review.filterUnknown', {
            tokens: filter.unknown.join(', '),
          })}
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
            <span className={`${p2.count} ${p2.tabnum}`}>
              {filterText.trim()
                ? `${visible.length}/${items.length}`
                : items.length}
            </span>
            <span className={p2.spacer} />
            {busy ? <span className={p2.count}>{t('forge.review.loadingMeta')}</span> : null}
          </div>

          <div className={p2.scroller} role="list">
            {visible.map((mr) => {
              const isCurrent = selectedKey !== null && mrKey(mr) === selectedKey
              const mrStatus = mr.headPipeline?.status ?? checksByKey[mrKey(mr)]
              const mrState = pipelineState(mrStatus)
              return (
                <button
                  key={mrKey(mr)}
                  type="button"
                  role="listitem"
                  className={p2.entry}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => void openDetail(mr)}
                >
                  <span
                    className={p2.dot}
                    data-tone={pipelineTone(mrState) || undefined}
                    title={mrStatus ?? t('forge.review.noCi')}
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
                        {mrStatus ?? t('forge.review.withoutCi')}
                      </span>
                      {mr.labels.slice(0, 2).map((label) => (
                        <span key={label} className={p2.chip}>
                          {label}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className={p2.meta} aria-hidden="true">
                    {isCurrent ? '•' : '→'}
                  </span>
                </button>
              )
            })}
          </div>

          {items.length > 0 && visible.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('forge.review.emptyMatch')}</h2>
              <p>{t('forge.review.emptyMatchHint')}</p>
            </div>
          ) : null}

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
                      className={p2.secondary}
                      disabled={busy || !selected.sourceBranch}
                      onClick={() => void checkoutRequest(selected, 'switch')}
                    >
                      {t('forge.review.checkout')}
                    </button>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy || !selected.sourceBranch}
                      onClick={() => void checkoutRequest(selected, 'worktree')}
                    >
                      {t('forge.review.checkoutWorktree')}
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
                      status: selectedStatus ?? t('forge.review.ciUnknown'),
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
              {detailProjectId ? (
                <MrDetailExtras
                  api={api}
                  projectId={detailProjectId}
                  mr={selected}
                  pipelines={pipelines}
                  onRefresh={() => void openDetail(selected)}
                />
              ) : (
                <p className={p2.asideHint}>{t('common.loading')}</p>
              )}
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
        open={checkout !== null}
        onClose={() => setCheckout(null)}
        busy={checkoutBusy}
        titleId="review-checkout-title"
      >
        <h2 id="review-checkout-title">
          {t('forge.review.checkoutTitle', { branch: checkout?.branch ?? '' })}
        </h2>
        <p className={p2.asideHint}>{t('forge.review.checkoutHint')}</p>
        <label className={p2.field}>
          {t('forge.review.checkoutRemote')}
          <select
            value={checkoutRemote}
            disabled={checkoutBusy || checkoutRemoteUrl.trim().length > 0}
            onChange={(event) => setCheckoutRemote(event.target.value)}
          >
            {(checkout?.remotes ?? []).map((remote) => (
              <option key={remote.name} value={remote.name}>
                {remote.name}
              </option>
            ))}
          </select>
        </label>
        <div className={p2.formRow}>
          <label className={p2.field}>
            {t('forge.review.checkoutAddName')}
            <input
              value={checkoutRemoteName}
              disabled={checkoutBusy}
              onChange={(event) => setCheckoutRemoteName(event.target.value)}
            />
          </label>
          <label className={p2.field}>
            {t('forge.review.checkoutAddUrl')}
            <input
              value={checkoutRemoteUrl}
              disabled={checkoutBusy}
              placeholder="git@host:team/repo.git"
              onChange={(event) => setCheckoutRemoteUrl(event.target.value)}
            />
          </label>
        </div>
        {checkout?.mode === 'worktree' ? (
          <div className={p2.row}>
            <label className={p2.field}>
              {t('forge.review.worktreePath')}
              <input
                value={checkoutPath}
                disabled={checkoutBusy}
                onChange={(event) => setCheckoutPath(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={p2.ghost}
              disabled={checkoutBusy}
              onClick={() =>
                void pickWorktreePath().then((path) => {
                  if (path) {
                    setCheckoutPath(path)
                  }
                })
              }
            >
              {t('forge.review.browse')}
            </button>
          </div>
        ) : null}
        <div className={p2.dialogActions}>
          <button
            type="button"
            className={p2.ghost}
            disabled={checkoutBusy}
            onClick={() => setCheckout(null)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={p2.primary}
            disabled={checkoutBusy}
            onClick={() => void confirmCheckout()}
          >
            {t('forge.review.checkoutConfirm')}
          </button>
        </div>
      </Dialog>

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

        <div className={p2.formRow}>
          <label className={p2.field}>
            {t('forge.create.reviewers')}
            <input
              value={reviewerNames}
              onChange={(event) => setReviewerNames(event.target.value)}
              placeholder={t('forge.create.namesPlaceholder')}
              aria-label={t('forge.create.reviewers')}
            />
          </label>
          <label className={p2.field}>
            {t('forge.create.assignees')}
            <input
              value={assigneeNames}
              onChange={(event) => setAssigneeNames(event.target.value)}
              placeholder={t('forge.create.namesPlaceholder')}
              aria-label={t('forge.create.assignees')}
            />
          </label>
          <label className={p2.field}>
            {t('forge.create.labels')}
            <input
              value={labelNames}
              onChange={(event) => setLabelNames(event.target.value)}
              placeholder={t('forge.create.labelsPlaceholder')}
              aria-label={t('forge.create.labels')}
            />
          </label>
        </div>

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
