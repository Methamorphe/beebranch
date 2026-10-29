import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openExternalUrl, refsGet, statusGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { ForgeApi, ForgeMergeRequest, ForgeScope } from '../lib/forge'
import type {
  GitlabPipeline,
  RefEntry,
  RepoLink,
} from '../types/git'
import type { PipelineState } from '../types/git'
import { pipelineState } from '../lib/pipeline'
import { MrDetailExtras } from './MrDetailExtras'
import shared from './p1.module.css'

type Props = {
  api: ForgeApi
  repoId: string | null
  generation: number
  connected: boolean
  onCheckout: (branch: string) => void
}

function stateClass(state: PipelineState): string {
  switch (state) {
    case 'success':
      return shared.success
    case 'failed':
      return shared.error
    case 'running':
    case 'pending':
      return shared.warning
    default:
      return ''
  }
}

export function ReviewRequestsPanel({ api, repoId, generation, connected, onCheckout }: Props) {
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
  const [notice, setNotice] = useState<string | null>(null)
  const detailRequest = useRef(0)

  const projectId = link?.projectId

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
      setNotice(`Projet associé : ${linked.pathWithNamespace}.`)
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
        `Le projet de cette ${api.short} est inconnu ; associez le dépôt ou ouvrez la ${api.noun} dans ${api.label}.`,
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
      setNotice(`${api.short} ${api.short === 'MR' ? '!' : '#'}${created.iid} créée : ${created.title}`)
      setTitle('')
      setDescription('')
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

  const pipeline = selected?.headPipeline
  const state = pipelineState(pipeline?.status)

  return (
    <div className={shared.card}>
      <h2>{api.title}</h2>
      <div className={shared.row}>
        <span className={shared.badge}>
          {link ? `${link.pathWithNamespace} (#${link.projectId})` : 'aucun projet associé'}
        </span>
        <button type="button" className={shared.secondary} disabled={busy || !repoId} onClick={() => void associate()}>
          Associer au projet
        </button>
        {link ? (
          <button
            type="button"
            className={shared.secondary}
            onClick={() => void openExternalUrl(link.webUrl)}
          >
            Ouvrir le projet
          </button>
        ) : null}
      </div>

      <div className={shared.tabs}>
        {api.scopes.map((option) => (
          <button
            key={option.value}
            type="button"
            className={scope === option.value ? shared.tabActive : shared.tab}
            onClick={() => setScope(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className={shared.danger} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className={shared.notice}>{notice}</p> : null}

      <div className={shared.columns} style={{ marginTop: 10 }}>
        <div className={shared.list}>
          {items.length === 0 ? (
            <div className={shared.empty} role="status">
              <strong>{busy ? 'Chargement…' : !connected ? `Connectez votre compte ${api.label}` : !link ? 'Associez ce dépôt à un projet' : `Aucune ${api.noun}`}</strong>
              {!busy ? <p>{!connected ? `La connexion est disponible dans les préférences ${api.label}.` : !link ? 'Utilisez « Associer au projet » pour retrouver les revues du dépôt.' : `Les ${api.title.toLowerCase()} correspondant à ce filtre apparaîtront ici.`}</p> : null}
            </div>
          ) : null}
          {items.map((mr) => {
            const mrState = pipelineState(mr.headPipeline?.status)
            return (
              <button
                key={`${mr.projectId ?? projectId ?? 0}:${mr.iid}`}
                type="button"
                className={`${shared.item} ${selected?.iid === mr.iid ? shared.itemSelected : ''}`}
                aria-current={selected?.iid === mr.iid ? 'true' : undefined}
                style={{ textAlign: 'left' }}
                onClick={() => void openDetail(mr)}
              >
                <div>
                  <span>
                    {api.short} {mr.iid} {mr.title}
                  </span>
                  <span className={shared.mono}>
                    {mr.sourceBranch || '?'} → {mr.targetBranch || '?'} · @{mr.author.username}
                    {mr.draft ? ' · draft' : ''}
                    {mr.hasConflicts ? ' · conflits' : ''}
                  </span>
                </div>
                <span className={`${shared.badge} ${stateClass(mrState)}`}>
                  {mr.headPipeline?.status ?? 'no ci'}
                </span>
              </button>
            )
          })}
          {nextPage ? (
            <button type="button" className={shared.secondary} onClick={() => void load(nextPage, true)}>
              Page suivante
            </button>
          ) : null}
        </div>

        <div className={shared.stack}>
          {selected ? (
            <>
              <h3>
                {api.short} {selected.iid} {selected.title}
              </h3>
              <span className={shared.mono}>
                {selected.sourceBranch || '?'} → {selected.targetBranch || '?'} · {selected.state}
                {selected.detailedMergeStatus ? ` · ${selected.detailedMergeStatus}` : ''}
              </span>
              <div className={shared.row}>
                <span className={`${shared.badge} ${stateClass(state)}`}>
                  CI {pipeline?.status ?? 'inconnu'}
                </span>
                <button
                  type="button"
                  className={shared.small}
                  onClick={() => void openExternalUrl(selected.webUrl)}
                >
                  Ouvrir dans {api.label}
                </button>
              </div>
              <MrDetailExtras
                api={api}
                projectId={selected.projectId ?? projectId ?? 0}
                mr={selected}
                onRefresh={() => void openDetail(selected)}
                onCheckout={onCheckout}
              />
              {pipelines.length > 0 ? (
                <div className={shared.stack}>
                  {pipelines.map((item) => (
                    <span key={item.id} className={shared.mono}>
                      #{item.id} · {item.status}
                      {item.sha ? ` · ${item.sha.slice(0, 10)}` : ''}
                      {item.webUrl ? (
                        <button
                          type="button"
                          className={shared.small}
                          onClick={() => item.webUrl && void openExternalUrl(item.webUrl)}
                        >
                          Ouvrir
                        </button>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className={shared.notice}>Sélectionnez une {api.short} pour le détail et la CI.</p>
          )}

          <h3 style={{ marginTop: 12 }}>Créer une {api.noun}</h3>
          <div className={shared.row}>
            <label className={shared.field}>
              Branche source
              <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Branche source">
                {branchOptions.length === 0 ? <option value={source}>{source || 'source'}</option> : null}
                {branchOptions.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              Branche cible
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="branche cible (main)"
                aria-label="Branche cible"
              />
            </label>
          </div>
          <label className={shared.field}>
            Titre de la {api.noun}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={`Titre de la ${api.short}`}
              aria-label={`Titre de la ${api.short}`}
            />
          </label>
          <label className={shared.field}>
            Description (optionnelle)
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Description"
              rows={4}
              aria-label={`Description de la ${api.short}`}
            />
          </label>
          <div className={shared.row}>
            <label className={shared.checkbox}>
              <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
              Brouillon
            </label>
            {api.capabilities.createMergeOptions ? (
              <>
                <label className={shared.checkbox}>
                  <input
                    type="checkbox"
                    checked={removeSource}
                    onChange={(event) => setRemoveSource(event.target.checked)}
                  />
                  Supprimer la branche source après fusion
                </label>
                <label className={shared.checkbox}>
                  <input type="checkbox" checked={squash} onChange={(event) => setSquash(event.target.checked)} />
                  Regrouper les commits
                </label>
              </>
            ) : null}
            <button
              type="button"
              className={shared.primary}
              disabled={busy || !connected || !projectId || !title.trim() || !source || !target.trim()}
              onClick={() => void create()}
            >
              Créer
            </button>
          </div>
          <p className={shared.notice}>
            La branche source doit être poussée. Création hors ligne impossible : aucune
            mutation {api.label} n'est mise en file. Source courante : {currentBranch || 'inconnue'}.
          </p>
        </div>
      </div>
    </div>
  )
}
