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

export function ConflictsPanel({ repoId, generation, state, onMutated }: Props) {
  const { t } = useI18n()
  const files = state.conflicts.files
  const [selected, setSelected] = useState<string | null>(files[0] ?? null)
  const [view, setView] = useState<ConflictView | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [allowMarkers, setAllowMarkers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [abortOpen, setAbortOpen] = useState(false)

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
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const next = await conflictGet(repoId, path)
        setView(next)
        if (!dirtyRef.current) {
          setContent(next.working?.content ?? combine(next))
        }
      } catch (cause) {
        setError(errorMessage(cause))
        setView(null)
      } finally {
        setBusy(false)
      }
    },
    [repoId],
  )

  useEffect(() => {
    if (selected) {
      dirtyRef.current = false
      setDirty(false)
      void load(selected)
    } else {
      setView(null)
    }
    // `generation` invalidates the conflict view after any Git mutation.
  }, [selected, generation, load])

  if (files.length === 0) {
    return (
      <div className={p2.empty}>
        <h2>{t('ops.conflicts.emptyTitle')}</h2>
        <p>{t('ops.conflicts.emptyBody')}</p>
      </div>
    )
  }

  const index = selected ? files.indexOf(selected) : -1
  const move = (delta: number) => {
    if (files.length === 0) {
      return
    }
    const next = (index + delta + files.length) % files.length
    setSelected(files[next] ?? null)
  }

  const accept = (side: 'ours' | 'theirs' | 'both') => {
    if (!view) {
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

  const save = async () => {
    if (!selected) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await conflictSave({
        repoId,
        path: selected,
        content,
        allowMarkers,
        markResolved: true,
      })
      setView(result.data)
      dirtyRef.current = false
      setDirty(false)
      setNotice(t('ops.conflicts.notice.resolved', { path: selected }))
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const operation = async (action: 'continue' | 'skip') => {
    setBusy(true)
    setError(null)
    try {
      await (action === 'continue' ? operationContinue(repoId) : operationSkip(repoId))
      setNotice(
        action === 'continue'
          ? t('ops.conflicts.notice.continued')
          : t('ops.conflicts.notice.skipped'),
      )
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={p2.pageColumn} style={{ padding: 0 }}>
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
              onClick={() => {
                if (dirty && !window.confirm(t('ops.conflicts.discardConfirm'))) {
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

          {error ? <p className={p2.errorText} style={{ padding: '0 12px' }}>{error}</p> : null}
          {notice ? <p className={p2.notice} style={{ padding: '0 12px' }}>{notice}</p> : null}

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
                    <button type="button" className={p2.ghost} onClick={() => accept('ours')}>
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
                    <button type="button" className={p2.ghost} onClick={() => accept('theirs')}>
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
                  <button type="button" className={p2.ghost} onClick={() => accept('both')}>
                    {t('ops.conflicts.combine')}
                  </button>
                  <button
                    type="button"
                    className={p2.ghost}
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
                    disabled={busy || dirty === false}
                    onClick={() => void save()}
                  >
                    {t('ops.conflicts.markResolved')}
                  </button>
                  {state.operation ? (
                    <>
                      <button
                        type="button"
                        className={p2.secondary}
                        disabled={busy}
                        onClick={() => void operation('skip')}
                      >
                        {t('ops.conflicts.skip')}
                      </button>
                      <button
                        type="button"
                        className={p2.primary}
                        disabled={busy}
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
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

<ConfirmDialog
        open={abortOpen}
        title={t('ops.conflicts.abortTitle')}
        consequence={t('ops.conflicts.abortConsequence')}
        typed="abort"
        irreversible
        confirmLabel={t('ops.conflicts.abort')}
        busy={busy}
        onCancel={() => setAbortOpen(false)}
        onConfirm={(typed) => {
          setAbortOpen(false)
          setBusy(true)
          void operationAbort(repoId, { acknowledged: true, typed })
            .then(() => {
              setNotice(t('ops.conflicts.notice.aborted'))
              onMutated()
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}
