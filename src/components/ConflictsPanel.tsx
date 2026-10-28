import { useCallback, useEffect, useRef, useState } from 'react'
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

function operationLabel(operation?: InProgressOperation): string {
  if (!operation) {
    return 'Aucune opération'
  }
  if (operation.kind === 'rebase') {
    return `rebase (${operation.variant})`
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
        <h2>Aucun conflit à résoudre</h2>
        <p>
          Un merge, un rebase ou un cherry-pick en conflit ouvrira le plan de
          résolution ici.
        </p>
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
      setNotice(`${selected} marqué comme résolu.`)
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
      setNotice(action === 'continue' ? 'Opération poursuivie.' : 'Commit sauté.')
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
            <span>FICHIERS EN CONFLIT</span>
            <span>{files.length}</span>
          </div>
          {files.map((path) => (
            <button
              key={path}
              type="button"
              className={selected === path ? p2.listItemOn : p2.listItem}
              onClick={() => {
                if (dirty && !window.confirm('Abandonner la résolution non enregistrée ?')) {
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
            <div>1. Comparez les deux versions</div>
            <div>2. Choisissez un point de départ</div>
            <div>3. Éditez puis marquez résolu</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div className={`${p2.footer} ${p2.mono} ${p2.small}`} style={{ borderTop: 0 }}>
            <span>{selected}</span>
            <span className={p2.spacer} />
            <button type="button" className={p2.ghost} onClick={() => move(-1)}>
              ↑ Précédent
            </button>
            <span className={p2.muted}>
              {index + 1} / {files.length}
            </span>
            <button type="button" className={p2.ghost} onClick={() => move(1)}>
              ↓ Suivant
            </button>
          </div>

          {error ? <p className={p2.errorText} style={{ padding: '0 12px' }}>{error}</p> : null}
          {notice ? <p className={p2.notice} style={{ padding: '0 12px' }}>{notice}</p> : null}

          {view?.binary ? (
            <div className={p2.empty}>
              <h2>Conflit binaire</h2>
              <p>
                Ce fichier n'est pas du texte UTF-8. Choisissez une version
                ci-dessous, BeeBranch ne l'ouvrira pas dans l'éditeur.
              </p>
              <p className={p2.muted}>
                Utilisez un outil de merge externe ou `git checkout --ours/--theirs`
                puis « Marquer résolu ».
              </p>
            </div>
          ) : view?.tooLarge ? (
            <div className={p2.empty}>
              <h2>Fichier trop volumineux</h2>
              <p>
                Au-delà de 8 Mio, la résolution se fait dans un outil externe
                puis via « Marquer résolu ».
              </p>
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
                      <span className={p2.muted}>● Base (ancêtre commun)</span>
                    </div>
                    <pre className={p2.sideCode}>{view.base.content}</pre>
                  </div>
                ) : null}
                <div className={p2.side}>
                  <div className={p2.sideHeader}>
                    <span className={p2.good}>● Actuel (ours)</span>
                    <span className={p2.spacer} />
                    <button type="button" className={p2.ghost} onClick={() => accept('ours')}>
                      Accepter
                    </button>
                  </div>
                  <pre className={p2.sideCode}>{view?.ours?.content ?? '—'}</pre>
                </div>
                <div className={p2.side}>
                  <div className={p2.sideHeader}>
                    <span style={{ color: 'var(--info)' }}>● Entrant (theirs)</span>
                    <span className={p2.spacer} />
                    <button type="button" className={p2.ghost} onClick={() => accept('theirs')}>
                      Accepter
                    </button>
                  </div>
                  <pre className={p2.sideCode}>{view?.theirs?.content ?? '—'}</pre>
                </div>
              </div>
              <div className={p2.resolve}>
                <div className={p2.resolveHeader}>
                  <strong style={{ color: 'var(--text)' }}>Résultat</strong>
                  <span className={p2.pill}>éditable</span>
                  <span className={p2.spacer} />
                  <button type="button" className={p2.ghost} onClick={() => accept('both')}>
                    Combiner les deux
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
                    Marqueurs bruts
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
                  aria-label="Résolution du conflit"
                  placeholder="Acceptez une version ou écrivez la résolution…"
                />
                <div className={p2.footer}>
                  <label className={p2.checkbox}>
                    <input
                      type="checkbox"
                      checked={allowMarkers}
                      onChange={(event) => setAllowMarkers(event.target.checked)}
                    />
                    Autoriser les marqueurs (édition brute)
                  </label>
                  {view?.hasMarkers ? (
                    <span className={p2.warn}>
                      {view.markerLines.length} marqueur(s) restants
                    </span>
                  ) : null}
                  <span className={p2.spacer} />
                  <span className={p2.muted}>
                    Opération : {operationLabel(state.operation)}
                  </span>
                  <button
                    type="button"
                    className={`${p2.secondary}`}
                    disabled={busy || dirty === false}
                    onClick={() => void save()}
                  >
                    ✓ Marquer résolu
                  </button>
                  {state.operation ? (
                    <>
                      <button
                        type="button"
                        className={p2.secondary}
                        disabled={busy}
                        onClick={() => void operation('skip')}
                      >
                        Sauter
                      </button>
                      <button
                        type="button"
                        className={p2.primary}
                        disabled={busy}
                        onClick={() => void operation('continue')}
                      >
                        Continuer
                      </button>
                      <button
                        type="button"
                        className={p2.danger}
                        disabled={busy}
                        onClick={() => setAbortOpen(true)}
                      >
                        Abandonner
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
        title="Abandonner l'opération"
        consequence="Les résolutions et les commits intermédiaires de l'opération sont perdus. Aucune sauvegarde applicative n'est créée."
        typed="abort"
        irreversible
        confirmLabel="Abandonner"
        busy={busy}
        onCancel={() => setAbortOpen(false)}
        onConfirm={(typed) => {
          setAbortOpen(false)
          setBusy(true)
          void operationAbort(repoId, { acknowledged: true, typed })
            .then(() => {
              setNotice("Opération abandonnée.")
              onMutated()
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}
