import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatNumber,
  useI18n,
  type MessageKey,
  type TranslationParams,
} from '../i18n'
import {
  conflictGet,
  conflictSave,
  operationAbort,
  operationContinue,
  operationSkip,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { ConflictView, InProgressOperation, RepoState } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  state: RepoState
  onMutated: () => void
  onDirtyChange?: (dirty: boolean) => void
}

type Translate = (key: MessageKey, params?: TranslationParams) => string

function operationLabel(
  operation: InProgressOperation | undefined,
  t: Translate,
): string {
  if (!operation) {
    return t('ops.conflicts.noOperation')
  }
  if (operation.kind === 'rebase') {
    return t('ops.conflicts.rebaseOperation', { variant: operation.variant })
  }
  if (operation.kind === 'sequencer') {
    return operation.sequencer
  }
  return operation.kind
}

function combine(view: ConflictView | null): string {
  if (!view) {
    return ''
  }
  const parts = [view.ours?.content, view.theirs?.content]
    .map((value) => value?.trimEnd())
    .filter((value): value is string => Boolean(value))
  return `${parts.join('\n\n')}\n`
}

/** The conflict a draft was written against: same path and same three sides. */
function conflictSignature(view: ConflictView | null): string {
  if (!view) return ''
  return [view.path, view.ours?.content, view.theirs?.content, view.base?.content]
    .map((value) => value ?? '')
    .join('\u0000')
}

export function ConflictsPanel(props: Props) {
  return <ConflictWorkspace key={props.repoId} {...props} />
}

function ConflictWorkspace({ repoId, generation, state, onMutated, onDirtyChange }: Props) {
  const { t } = useI18n()
  const files = state.conflicts.files
  const [selected, setSelected] = useState<string | null>(files[0] ?? null)
  const [view, setView] = useState<ConflictView | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [allowMarkers, setAllowMarkers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  const editorPath = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [abortOpen, setAbortOpen] = useState(false)
  /** The draft was written against sides that a newer conflict has replaced. */
  const [stale, setStale] = useState(false)
  const viewRef = useRef<ConflictView | null>(null)
  const controllable = Boolean(state.operation && state.operation.kind !== 'bisect')
  const skippable = controllable && state.operation?.kind !== 'merge'
  const editable = Boolean(selected && files.includes(selected) && view?.path === selected
    && !busy && !loading && !stale && !view?.binary && !view?.tooLarge)

  useEffect(() => {
    viewRef.current = view
  }, [view])

  useEffect(() => {
    onDirtyChange?.(dirty || stale)
  }, [dirty, stale, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current += 1
    }
  }, [])

  useEffect(() => {
    if (files.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !files.includes(selected)) {
      setSelected(files[0] ?? null)
    }
  }, [files, selected])

  const load = useCallback(
    async (path: string) => {
      const token = ++request.current
      setLoading(true)
      setError(null)
      setNotice(null)
      try {
        const next = await conflictGet(repoId, path)
        if (token !== request.current || !mounted.current) return
        if (!dirtyRef.current) {
          setView(next)
          setContent(next.working?.content ?? combine(next))
        }
      } catch (cause) {
        if (token !== request.current || !mounted.current) return
        setError(errorMessage(cause))
        setView(null)
      } finally {
        if (token === request.current && mounted.current) setLoading(false)
      }
    },
    [repoId],
  )

  useEffect(() => {
    const path = selected && files.includes(selected) ? selected : null
    if (editorPath.current !== path) {
      editorPath.current = path
      dirtyRef.current = false
      setDirty(false)
      setStale(false)
      setAllowMarkers(false)
      setContent('')
      setView(null)
    }
    if (!path) {
      setLoading(false)
      return
    }
    if (!dirtyRef.current) {
      void load(path)
      return
    }
    // A draft survives a refresh, but only while it still describes the same
    // conflict: saving it over a newer one would stage the wrong resolution.
    const token = ++request.current
    setLoading(true)
    void conflictGet(repoId, path)
      .then((next) => {
        if (token !== request.current || !mounted.current) return
        if (conflictSignature(next) === conflictSignature(viewRef.current)) {
          setView(next)
        } else {
          setStale(true)
        }
      })
      .catch((cause) => {
        if (token !== request.current || !mounted.current) return
        setError(errorMessage(cause))
        setStale(true)
      })
      .finally(() => {
        if (token === request.current && mounted.current) setLoading(false)
      })
    return () => {
      request.current += 1
    }
  }, [selected, files, generation, load, repoId])

  const index = selected ? files.indexOf(selected) : -1
  const move = (delta: number) => {
    if (busy) return
    if (dirty && !window.confirm(t('ops.conflicts.discardConfirm'))) return
    if (files.length === 0) {
      return
    }
    const next = (index + delta + files.length) % files.length
    setSelected(files[next] ?? null)
  }

  const accept = (side: 'ours' | 'theirs' | 'both') => {
    if (!view || !editable) {
      return
    }
    const next =
      side === 'ours'
        ? view.ours?.content ?? ''
        : side === 'theirs'
          ? view.theirs?.content ?? ''
          : combine(view)
    setContent(next)
    dirtyRef.current = true
    setDirty(true)
  }

  const reload = async () => {
    if (!selected || pending.current) return
    pending.current = true
    request.current += 1
    setLoading(false)
    setBusy(true)
    setError(null)
    try {
      const next = await conflictGet(repoId, selected)
      if (!mounted.current) return
      setView(next)
      setContent(next.working?.content ?? combine(next))
      dirtyRef.current = false
      setDirty(false)
      setStale(false)
      setNotice(t('ops.conflicts.notice.reloaded', { path: selected }))
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const save = async () => {
    if (!selected || !editable || pending.current) {
      return
    }
    pending.current = true
    request.current += 1
    setLoading(false)
    const path = selected
    setBusy(true)
    setError(null)
    try {
      await conflictSave({
        repoId,
        path,
        content,
        allowMarkers,
        markResolved: true,
      })
      if (!mounted.current) return
      setView(null)
      dirtyRef.current = false
      setDirty(false)
      setNotice(t('ops.conflicts.notice.resolved', { path }))
      onMutated()
    } catch (cause) {
      if (!mounted.current) return
      setError(errorMessage(cause))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const operation = async (action: 'continue' | 'skip') => {
    if (pending.current || !controllable || (action === 'skip' ? !skippable : files.length > 0)) return
    if (dirty && !window.confirm(t('ops.conflicts.discardConfirm'))) return
    pending.current = true
    request.current += 1
    setLoading(false)
    setBusy(true)
    setError(null)
    try {
      await (action === 'continue' ? operationContinue(repoId) : operationSkip(repoId))
      if (!mounted.current) return
      dirtyRef.current = false
      setDirty(false)
      setNotice(
        action === 'continue'
          ? t('ops.conflicts.notice.continued')
          : t('ops.conflicts.notice.skipped'),
      )
      onMutated()
    } catch (cause) {
      if (!mounted.current) return
      setError(errorMessage(cause))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className={`${p2.screen} ${p2.conflictsScreen}`}>
      {error ? <p className={p2.alert} role="alert">{error}</p> : null}
      {notice ? <div className={p2.listHeader} role="status">{notice}</div> : null}
      {stale ? (
        <div className={`${p2.banner} ${p2.bannerInfo}`} role="alert">
          <span>{t('ops.conflicts.staleBody')}</span>
          <button type="button" className={p2.ghost} disabled={busy} onClick={() => void reload()}>
            {t('ops.conflicts.reload')}
          </button>
        </div>
      ) : null}
      {files.length === 0 ? (
        <div className={p2.empty}>
          <h2>{t('ops.conflicts.emptyTitle')}</h2>
          <p>{t(controllable ? 'ops.conflicts.readyBody' : 'ops.conflicts.emptyBody')}</p>
        </div>
      ) : (
      <div className={p2.threeColumns}>
        <div className={p2.fileList}>
          <div className={`${p2.between} ${p2.small} ${p2.muted}`} style={{ padding: '4px 6px' }}>
            <span>{t('ops.conflicts.filesHeader')}</span>
            <span>{formatNumber(files.length)}</span>
          </div>
          {files.map((path) => (
            <button
              key={path}
              type="button"
              className={selected === path ? p2.listItemOn : p2.listItem}
              disabled={busy}
              onClick={() => {
                if (path === selected) return
                if ((dirty || stale) && !window.confirm(t('ops.conflicts.discardConfirm'))) {
                  return
                }
                dirtyRef.current = false
                setDirty(false)
                setSelected(path)
              }}
            >
              <span className={p2.warn}>!</span>
              <span className={p2.listSub} style={{ color: 'var(--text)' }}>
                {path}
              </span>
            </button>
          ))}
          <div className={`${p2.card} ${p2.small} ${p2.muted}`} style={{ marginTop: 10 }}>
            <div>{t('ops.conflicts.step.compare')}</div>
            <div>{t('ops.conflicts.step.choose')}</div>
            <div>{t('ops.conflicts.step.resolve')}</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div className={`${p2.footer} ${p2.mono} ${p2.small}`} style={{ borderTop: 0 }}>
            <span>{selected}</span>
            <span className={p2.spacer} />
            <button type="button" className={p2.ghost} onClick={() => move(-1)}>
              {t('ops.conflicts.previous')}
            </button>
            <span className={p2.muted}>
              {formatNumber(index + 1)} / {formatNumber(files.length)}
            </span>
            <button type="button" className={p2.ghost} onClick={() => move(1)}>
              {t('ops.conflicts.next')}
            </button>
          </div>


          {view?.binary ? (
            <div className={p2.empty}>
              <h2>{t('ops.conflicts.binaryTitle')}</h2>
              <p>{t('ops.conflicts.binaryBody')}</p>
              <p className={p2.muted}>{t('ops.conflicts.binaryHint')}</p>
            </div>
          ) : view?.tooLarge ? (
            <div className={p2.empty}>
              <h2>{t('ops.conflicts.tooLargeTitle')}</h2>
              <p>{t('ops.conflicts.tooLargeBody')}</p>
            </div>
          ) : (
            <div className={p2.conflictGrid}>
              <div
                className={p2.sides}
                style={{
                  gridTemplateColumns: view?.base ? '1fr 1fr 1fr' : '1fr 1fr',
                }}
              >
                {view?.base ? (
                  <div className={p2.side}>
                    <div className={p2.sideHeader}>
                      <span className={p2.muted}>{t('ops.conflicts.side.base')}</span>
                    </div>
                    <pre className={p2.sideCode}>{view.base.content}</pre>
                  </div>
                ) : null}
                <div className={p2.side}>
                  <div className={p2.sideHeader}>
                    <span className={p2.good}>{t('ops.conflicts.side.ours')}</span>
                    <span className={p2.spacer} />
                    <button type="button" className={p2.ghost} disabled={!editable} onClick={() => accept('ours')}>
                      {t('ops.conflicts.accept')}
                    </button>
                  </div>
                  <pre className={p2.sideCode}>{view?.ours?.content ?? '—'}</pre>
                </div>
                <div className={p2.side}>
                  <div className={p2.sideHeader}>
                    <span style={{ color: 'var(--info)' }}>
                      {t('ops.conflicts.side.theirs')}
                    </span>
                    <span className={p2.spacer} />
                    <button type="button" className={p2.ghost} disabled={!editable} onClick={() => accept('theirs')}>
                      {t('ops.conflicts.accept')}
                    </button>
                  </div>
                  <pre className={p2.sideCode}>{view?.theirs?.content ?? '—'}</pre>
                </div>
              </div>
              <div className={p2.resolve}>
                <div className={p2.resolveHeader}>
                  <strong style={{ color: 'var(--text)' }}>
                    {t('ops.conflicts.result')}
                  </strong>
                  <span className={p2.pill}>{t('ops.conflicts.editable')}</span>
                  <span className={p2.spacer} />
                  <button type="button" className={p2.ghost} disabled={!editable} onClick={() => accept('both')}>
                    {t('ops.conflicts.combine')}
                  </button>
                  <button
                    type="button"
                    className={p2.ghost}
                    disabled={!editable}
                    onClick={() => {
                      setContent(view?.working?.content ?? '')
                      dirtyRef.current = true
                      setDirty(true)
                    }}
                  >
                    {t('ops.conflicts.rawMarkers')}
                  </button>
                </div>
                <textarea
                  value={content}
                  disabled={!editable}
                  onChange={(event) => {
                    setContent(event.target.value)
                    dirtyRef.current = true
                    setDirty(true)
                  }}
                  spellCheck={false}
                  aria-label={t('ops.conflicts.resolveAria')}
                  placeholder={t('ops.conflicts.resolvePlaceholder')}
                />
                <div className={p2.footer}>
                  <label className={p2.checkbox}>
                    <input
                      type="checkbox"
                      checked={allowMarkers}
                      disabled={!editable}
                      onChange={(event) => setAllowMarkers(event.target.checked)}
                    />
                    {t('ops.conflicts.allowMarkers')}
                  </label>
                  {view?.hasMarkers ? (
                    <span className={p2.warn}>
                      {t('ops.conflicts.markersRemaining', {
                        count: formatNumber(view.markerLines.length),
                      })}
                    </span>
                  ) : null}
                  <span className={p2.spacer} />
                  <span className={p2.muted}>
                    {t('ops.conflicts.operation', {
                      operation: operationLabel(state.operation, t),
                    })}
                  </span>
                  <button
                    type="button"
                    className={`${p2.secondary}`}
                    disabled={!editable}
                    onClick={() => void save()}
                  >
                    {t('ops.conflicts.markResolved')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
      {controllable ? (
        <div className={p2.footerBar}>
          <span className={p2.muted}>
            {t('ops.conflicts.operation', { operation: operationLabel(state.operation, t) })}
          </span>
          <span className={p2.spacer} />
          {skippable ? (
            <button
              type="button"
              className={p2.secondary}
              disabled={busy}
              onClick={() => void operation('skip')}
            >
              {t('ops.conflicts.skip')}
            </button>
          ) : null}
          <button
            type="button"
            className={p2.primary}
            disabled={busy || files.length > 0}
            onClick={() => void operation('continue')}
          >
            {t('ops.conflicts.continue')}
          </button>
          <button
            type="button"
            className={p2.danger}
            disabled={busy}
            onClick={() => setAbortOpen(true)}
          >
            {t('ops.conflicts.abort')}
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={abortOpen && controllable}
        title={t('ops.conflicts.abortTitle')}
        consequence={t('ops.conflicts.abortConsequence')}
        typed="abort"
        irreversible
        confirmLabel={t('ops.conflicts.abort')}
        busy={busy}
        onCancel={() => setAbortOpen(false)}
        onConfirm={(typed) => {
          if (pending.current || !controllable) return
          pending.current = true
          request.current += 1
          setLoading(false)
          setAbortOpen(false)
          setBusy(true)
          void operationAbort(repoId, { acknowledged: true, typed })
            .then(() => {
              if (!mounted.current) return
              dirtyRef.current = false
              setDirty(false)
              setNotice(t('ops.conflicts.notice.aborted'))
              onMutated()
            })
            .catch((cause) => {
              if (mounted.current) setError(errorMessage(cause))
            })
            .finally(() => {
              pending.current = false
              if (mounted.current) setBusy(false)
            })
        }}
      />
    </div>
  )
}
