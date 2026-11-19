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
import type { ConflictRegion, ConflictView, InProgressOperation, RepoState } from '../types/git'
import { ConfirmBar } from './ConfirmBar'
import {
  assembleRegions,
  choiceKind,
  countMarkers,
  pairConflictLines,
  presetChoice,
  sideNames,
  sortieWindow,
  type Choices,
  type ChoiceKind,
  type DiffToken,
  type RegionChoice,
} from './conflictResolution'
import { ToolbarIcon } from './ToolbarIcon'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  state: RepoState
  onMutated: () => void
  onDirtyChange?: (dirty: boolean) => void
}

type Translate = (key: MessageKey, params?: TranslationParams) => string

function DiffText({ tokens }: { tokens: DiffToken[] }) {
  return (
    <code>
      {tokens.map((token, index) => token.changed
        ? <mark key={index}>{token.text}</mark>
        : <span key={index}>{token.text}</span>)}
    </code>
  )
}

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
  const [regionChoices, setRegionChoices] = useState<Choices>({})
  /** The result was typed by hand: a per-conflict choice would rewrite it. */
  const [manualEdit, setManualEdit] = useState(false)
  const [lineMode, setLineMode] = useState<Record<number, boolean>>({})
  const [active, setActive] = useState(0)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  const editorPath = useRef<string | null>(null)
  const regionsRef = useRef<HTMLDivElement | null>(null)
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
  const signature = conflictSignature(view)

  useEffect(() => {
    viewRef.current = view
  }, [view])

  // Choices describe one conflict: a refresh of the same conflict keeps them.
  useEffect(() => {
    setRegionChoices({})
    setLineMode({})
    setManualEdit(false)
    setActive(0)
    setEditing(false)
  }, [signature])

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
          setContent(next.working?.content ?? '')
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

  const markDirty = () => {
    dirtyRef.current = true
    setDirty(true)
  }

  const regions = view?.regions ?? []
  const working = view?.working?.content ?? ''
  const names = sideNames(view, state.head, state.operation)
  const oursName = names.ours
    ?? t(names.source === 'rebase' ? 'ops.conflicts.name.onto' : 'ops.conflicts.name.current')
  const theirsName = names.source === 'stash'
    ? t('ops.conflicts.name.stash')
    : names.theirs ?? t('ops.conflicts.name.incoming')
  const decided = regions.filter((region) => regionChoices[region.index]).length
  const markersLeft = countMarkers(content)
  const pendingRegions = manualEdit ? 0 : regions.length - decided

  const choose = (region: ConflictRegion, next: RegionChoice) => {
    if (!editable) return
    if (manualEdit && !window.confirm(t('ops.conflicts.manualOverwrite'))) return
    const choices = { ...regionChoices, [region.index]: next }
    setRegionChoices(choices)
    setContent(assembleRegions(working, regions, choices))
    setManualEdit(false)
    setEditing(false)
    setActive(region.index)
    markDirty()
  }

  /** Whole-file versions, offered only when there are no marker blocks to pick from. */
  const takeWholeFile = (side: 'ours' | 'theirs') => {
    if (!view || !editable) return
    setContent((side === 'ours' ? view.ours?.content : view.theirs?.content) ?? '')
    markDirty()
  }

  const startOver = () => {
    if (!editable) return
    if (dirty && !window.confirm(t('ops.conflicts.discardConfirm'))) return
    setRegionChoices({})
    setLineMode({})
    setManualEdit(false)
    setAllowMarkers(false)
    setContent(working)
    dirtyRef.current = false
    setDirty(false)
  }

  const scrollToNextPending = () => {
    const target = regions.find((region) => !regionChoices[region.index])
    if (!target) return
    regionsRef.current
      ?.querySelector(`[data-region="${target.index}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
      setContent(next.working?.content ?? '')
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

  const canSave = editable && (markersLeft === 0 || allowMarkers)

  const save = async () => {
    if (!selected || !canSave || pending.current) {
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

  const contextLine = view && !view.binary && !view.tooLarge
    ? t(`ops.conflicts.context.${names.source}`, { ours: oursName, theirs: theirsName })
    : null

  const activeRegion = regions.find((region) => region.index === active) ?? regions[0]
  const sortieLines = activeRegion
    ? sortieWindow(working, regions, regionChoices, activeRegion.index)
    : []
  const showRegion = (index: number) => {
    setActive(index)
    regionsRef.current
      ?.querySelector(`[data-region="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
  const keepLabel = (kind: ChoiceKind | null, side: 'ours' | 'theirs') => {
    if (kind === 'both') return t('ops.conflicts.choice.included')
    if (kind === side) return t('ops.conflicts.choice.keptSide')
    return t('ops.conflicts.choice.keepSide')
  }
  const activeChoice = activeRegion ? regionChoices[activeRegion.index] : undefined
  const activeKind = activeChoice ? choiceKind(activeChoice) : null
  const outputLabel = manualEdit
    ? t('ops.conflicts.manualEdited')
    : activeKind === 'ours'
      ? oursName
      : activeKind === 'theirs'
        ? theirsName
        : activeKind === 'both'
          ? t('ops.conflicts.choice.bothShort')
          : activeKind === 'base'
            ? t('ops.conflicts.choice.origin')
            : activeKind === 'custom'
              ? t('ops.conflicts.region.custom')
              : t('ops.conflicts.output.undecided')

  const blockedReason = !editable
    ? null
    : pendingRegions > 0
      ? t('ops.conflicts.pendingLeft', { count: formatNumber(pendingRegions) })
      : markersLeft > 0 && !allowMarkers
        ? t('ops.conflicts.markersRemaining', { count: formatNumber(markersLeft) })
        : null

  const renderLines = (
    region: ConflictRegion,
    side: 'ours' | 'theirs',
    choice: RegionChoice | undefined,
  ) => {
    const lines = region[side]
    if (!lines.length) {
      return <span className={`${p2.muted} ${p2.small}`}>{t('ops.conflicts.region.empty')}</span>
    }
    if (!lineMode[region.index]) {
      return <pre className={p2.conflictCode}>{lines.join('\n')}</pre>
    }
    const empty: RegionChoice = {
      ours: region.ours.map(() => false),
      theirs: region.theirs.map(() => false),
      base: false,
    }
    return lines.map((line, position) => (
      <label key={`${side}-${position}`} className={p2.regionLine}>
        <input
          type="checkbox"
          disabled={!editable || Boolean(choice?.base)}
          checked={Boolean(choice?.[side][position])}
          onChange={(event) => {
            const from = choice ?? empty
            const flags = from[side].map((value, at) => at === position ? event.target.checked : value)
            choose(region, { ...from, [side]: flags, base: false })
          }}
        />
        <code>{line || ' '}</code>
      </label>
    ))
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
      <div className={files.length > 1 ? p2.threeColumns : p2.oneColumn}>
        {files.length > 1 ? (
          <div className={p2.fileList}>
            <div className={`${p2.between} ${p2.small} ${p2.muted}`} style={{ padding: '4px 6px' }}>
              <span>{t('ops.conflicts.filesHeader')}</span>
              <span>{formatNumber(files.length)}</span>
            </div>
            {files.map((path) => (
              <button
                key={path}
                type="button"
                className={`${selected === path ? p2.listItemOn : p2.listItem} ${p2.conflictFile}`}
                disabled={busy}
                title={path}
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
                <span className={p2.warn} aria-hidden="true"><ToolbarIcon name="warning" size={12} /></span>
                <span className={p2.listSub} style={{ color: 'var(--text)' }}>{path}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className={p2.conflictMain}>
          <div className={`${p2.footer} ${p2.small}`} style={{ borderTop: 0 }}>
            <strong className={p2.mono} style={{ color: 'var(--text)' }}>{selected}</strong>
            {regions.length ? (
              <span className={`${p2.chip} ${decided === regions.length ? p2.chipGood : p2.chipWarn}`}>
                {t('ops.conflicts.progress', {
                  done: formatNumber(decided),
                  total: formatNumber(regions.length),
                })}
              </span>
            ) : null}
            <span className={p2.spacer} />
            {pendingRegions > 0 && regions.length > 1 ? (
              <button type="button" className={p2.ghost} onClick={scrollToNextPending}>
                {t('ops.conflicts.nextPending')}
              </button>
            ) : null}
            {files.length > 1 ? (
              <>
                <button type="button" className={p2.ghost} onClick={() => move(-1)}>
                  {t('ops.conflicts.previousFile')}
                </button>
                <span className={p2.muted}>
                  {formatNumber(index + 1)} / {formatNumber(files.length)}
                </span>
                <button type="button" className={p2.ghost} onClick={() => move(1)}>
                  {t('ops.conflicts.nextFile')}
                </button>
              </>
            ) : null}
          </div>

          {contextLine ? (
            <div className={p2.conflictContext}>
              <span>{contextLine}</span>
              {names.source === 'stash' ? (
                <span className={p2.muted}>{t('ops.conflicts.context.stashHint')}</span>
              ) : null}
            </div>
          ) : null}

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
              {regions.length ? (
                <div ref={regionsRef} className={p2.regions} aria-label={t('ops.conflicts.regionsAria')}>
                  {regions.map((region) => {
                    const choice = regionChoices[region.index]
                    const kind = choice ? choiceKind(choice) : null
                    const linesOn = Boolean(lineMode[region.index])
                    const rows = pairConflictLines(region.ours, region.theirs)
                    const sideCell = (side: 'ours' | 'theirs', rowIndex: number) => {
                      const cell = rows[rowIndex]?.[side]
                      if (!cell || cell.kind === 'pad') {
                        return <div key={`${side}-${rowIndex}`} className={`${p2.diffLine} ${p2.diffPad}`} />
                      }
                      return (
                        <button
                          key={`${side}-${rowIndex}`}
                          type="button"
                          className={`${p2.diffLine} ${cell.kind === 'same' ? p2.diffSame : side === 'ours' ? p2.diffOurs : p2.diffTheirs}`}
                          disabled={!editable}
                          onClick={() => choose(region, presetChoice(region, side))}
                        >
                          <span className={p2.diffNum}>{formatNumber(region.start + 1 + rowIndex)}</span>
                          <DiffText tokens={cell.tokens} />
                        </button>
                      )
                    }
                    return (
                      <section
                        key={region.index}
                        data-region={region.index}
                        className={`${p2.hunk} ${region.index === activeRegion?.index ? p2.hunkActive : ''}`}
                        onClick={() => setActive(region.index)}
                      >
                        <div className={p2.regionHeader}>
                          <strong>
                            {t('ops.conflicts.output.lines', {
                              start: formatNumber(region.start),
                              end: formatNumber(region.end),
                            })}
                          </strong>
                          <span className={`${p2.chip} ${kind ? p2.chipGood : p2.chipWarn}`}>
                            {t(kind === 'custom'
                              ? 'ops.conflicts.region.custom'
                              : kind ? 'ops.conflicts.region.decided' : 'ops.conflicts.region.pending')}
                          </span>
                        </div>
                        {linesOn ? (
                          <div className={p2.regionSides}>
                            <div className={p2.regionSide}>
                              <span className={p2.regionSideTitle}>
                                <span className={p2.good}>{oursName}</span>
                              </span>
                              {renderLines(region, 'ours', choice)}
                            </div>
                            <div className={p2.regionSide}>
                              <span className={p2.regionSideTitle}>
                                <span className={p2.diffNameTheirs}>{theirsName}</span>
                              </span>
                              {renderLines(region, 'theirs', choice)}
                            </div>
                          </div>
                        ) : (
                          <div className={p2.diff}>
                            <button
                              type="button"
                              className={`${p2.diffHead} ${kind === 'ours' || kind === 'both' ? p2.diffHeadOn : ''}`}
                              disabled={!editable}
                              onClick={() => choose(region, presetChoice(region, 'ours'))}
                            >
                              <span className={p2.good}>{oursName}</span>
                              <span className={p2.diffVerb}>{keepLabel(kind, 'ours')}</span>
                            </button>
                            <button
                              type="button"
                              className={`${p2.diffHead} ${kind === 'theirs' || kind === 'both' ? p2.diffHeadOn : ''}`}
                              disabled={!editable}
                              onClick={() => choose(region, presetChoice(region, 'theirs'))}
                            >
                              <span className={p2.diffNameTheirs}>{theirsName}</span>
                              <span className={p2.diffVerb}>{keepLabel(kind, 'theirs')}</span>
                            </button>
                            {rows.flatMap((_, rowIndex) => [sideCell('ours', rowIndex), sideCell('theirs', rowIndex)])}
                          </div>
                        )}
                        <div className={`${p2.regionActions} ${p2.conflictChoices}`}>
                          <button
                            type="button"
                            className={kind === 'both' ? p2.choiceOn : p2.secondary}
                            aria-pressed={kind === 'both'}
                            disabled={!editable}
                            title={t('ops.conflicts.choice.both', { first: oursName, second: theirsName })}
                            onClick={() => choose(region, presetChoice(region, 'both'))}
                          >
                            {t('ops.conflicts.choice.bothShort')}
                          </button>
                          {region.base.length ? (
                            <button
                              type="button"
                              className={kind === 'base' ? p2.choiceOn : p2.secondary}
                              aria-pressed={kind === 'base'}
                              disabled={!editable}
                              title={t('ops.conflicts.choice.base')}
                              onClick={() => choose(region, presetChoice(region, 'base'))}
                            >
                              {t('ops.conflicts.choice.origin')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={linesOn ? p2.choiceOn : p2.secondary}
                            aria-pressed={linesOn}
                            disabled={!editable}
                            onClick={() => setLineMode({ ...lineMode, [region.index]: !linesOn })}
                          >
                            {t('ops.conflicts.choice.lines')}
                          </button>
                        </div>
                      </section>
                    )
                  })}
                </div>
              ) : view ? (
                <div className={p2.regionActions} style={{ padding: '8px 12px' }}>
                  <span className={`${p2.muted} ${p2.small}`}>{t('ops.conflicts.noRegions')}</span>
                  <span className={p2.spacer} />
                  <button type="button" className={p2.secondary} disabled={!editable || !view.ours}
                    onClick={() => takeWholeFile('ours')}>
                    {t('ops.conflicts.useFile', { name: oursName })}
                  </button>
                  <button type="button" className={p2.secondary} disabled={!editable || !view.theirs}
                    onClick={() => takeWholeFile('theirs')}>
                    {t('ops.conflicts.useFile', { name: theirsName })}
                  </button>
                </div>
              ) : null}
              <div className={regions.length ? p2.sortie : p2.resolve}>
                <div className={regions.length ? p2.sortieHead : p2.resolveHeader}>
                  <strong style={{ color: 'var(--text)' }}>
                    {regions.length ? t('ops.conflicts.output') : t('ops.conflicts.result')}
                  </strong>
                  {activeRegion ? (
                    <span className={p2.muted}>
                      {t('ops.conflicts.output.lines', {
                        start: formatNumber(activeRegion.start),
                        end: formatNumber(activeRegion.end),
                      })}
                    </span>
                  ) : null}
                  {activeRegion ? (
                    <span className={manualEdit ? p2.muted : activeKind === 'ours' ? p2.good : activeKind === 'theirs' ? p2.diffNameTheirs : activeKind ? p2.good : p2.warn}>
                      {outputLabel}
                    </span>
                  ) : (
                    <span className={p2.muted}>
                      {manualEdit ? t('ops.conflicts.manualEdited') : t('ops.conflicts.resultHint')}
                    </span>
                  )}
                  <span className={p2.spacer} />
                  {regions.length > 1 && activeRegion ? (
                    <>
                      <button
                        type="button"
                        className={p2.ghost}
                        disabled={activeRegion.index <= 0}
                        onClick={() => showRegion(activeRegion.index - 1)}
                      >
                        {t('ops.conflicts.output.previous')}
                      </button>
                      <span className={p2.muted}>
                        {t('ops.conflicts.output.position', {
                          index: formatNumber(activeRegion.index + 1),
                          total: formatNumber(regions.length),
                        })}
                      </span>
                      <button
                        type="button"
                        className={p2.ghost}
                        disabled={activeRegion.index >= regions.length - 1}
                        onClick={() => showRegion(activeRegion.index + 1)}
                      >
                        {t('ops.conflicts.output.next')}
                      </button>
                    </>
                  ) : null}
                  {regions.length ? (
                    <button type="button" className={p2.secondary} disabled={!editable} onClick={() => setEditing((open) => !open)}>
                      {editing ? t('ops.conflicts.output.closeEdit') : t('ops.conflicts.output.edit')}
                    </button>
                  ) : null}
                  <button type="button" className={p2.ghost} disabled={!editable || !dirty} onClick={startOver}>
                    {t('ops.conflicts.startOver')}
                  </button>
                </div>
                {regions.length && !editing && !manualEdit ? (
                  <div className={p2.sortieBody}>
                    {sortieLines.map((line, index) => (
                      <div
                        key={`${line.role}-${line.number}-${index}`}
                        className={`${p2.outLine} ${line.role === 'focus' ? p2.outFocus : line.role === 'pending' ? p2.outPending : p2.outContext}`}
                      >
                        <span className={p2.outNum}>
                          {line.role === 'pending' && line.end != null
                            ? `${formatNumber(line.number)}–${formatNumber(line.end)}`
                            : formatNumber(line.number)}
                        </span>
                        {line.role === 'pending'
                          ? <span>{t('ops.conflicts.output.waiting')}</span>
                          : <code>{line.text || ' '}</code>}
                      </div>
                    ))}
                  </div>
                ) : (
                <textarea
                  className={regions.length ? p2.sortieEditor : undefined}
                  value={content}
                  disabled={!editable}
                  onChange={(event) => {
                    setContent(event.target.value)
                    setManualEdit(true)
                    markDirty()
                  }}
                  spellCheck={false}
                  aria-label={t('ops.conflicts.resolveAria')}
                />
                )}
                <div className={p2.footer}>
                  {blockedReason ? <span className={p2.warn}>{blockedReason}</span> : null}
                  {markersLeft > 0 && editable && pendingRegions === 0 ? (
                    <label className={p2.checkbox}>
                      <input
                        type="checkbox"
                        checked={allowMarkers}
                        onChange={(event) => setAllowMarkers(event.target.checked)}
                      />
                      {t('ops.conflicts.allowMarkers')}
                    </label>
                  ) : null}
                  <span className={p2.spacer} />
                  <button
                    type="button"
                    className={p2.primary}
                    disabled={!canSave}
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
            className={files.length > 0 ? p2.secondary : p2.primary}
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

      <ConfirmBar
        open={abortOpen && controllable}
        title={t('ops.conflicts.abortTitle')}
        consequence={t('ops.conflicts.abortConsequence')}
        irreversible
        confirmLabel={t('ops.conflicts.abort')}
        busy={busy}
        onCancel={() => setAbortOpen(false)}
        onConfirm={() => {
          if (pending.current || !controllable) return
          pending.current = true
          request.current += 1
          setLoading(false)
          setAbortOpen(false)
          setBusy(true)
          void operationAbort(repoId, { acknowledged: true })
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
