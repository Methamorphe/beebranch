import { useLayoutEffect, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { CommitSummary, RefEntry } from '../types/git'
import {
  dropBranchesFromRefs,
  graphCommitRefs,
  graphRefKind,
  graphRefLabel,
  graphRefRemoteLabel,
  graphRemoteGlyph,
  graphRemoteUrl,
  groupByBranchName,
  isCheckoutableRef,
  type DropBranch,
  type GraphRemoteUrl,
} from '../lib/graphRefs'
import { useI18n } from '../i18n'
import { ForgeLogo } from './ForgeLogo'
import { ViewIcon } from './ViewIcon'
import styles from './GraphRefPopover.module.css'

export type RefAnchor = { commit: CommitSummary; left: number; top: number; bottom: number }

function RemoteMark({ name, url }: { name: string; url?: string }) {
  const glyph = graphRemoteGlyph(name, url)
  return (
    <span title={name}>
      {glyph === 'gitlab' || glyph === 'github' || glyph === 'azure'
        ? <ForgeLogo provider={glyph} size={12} />
        : <ViewIcon view="remotes" size={12} />}
    </span>
  )
}

function BranchMarks({ branch, remoteUrls }: { branch: DropBranch; remoteUrls?: readonly GraphRemoteUrl[] }) {
  return (
    <span className={styles.marks}>
      {branch.local ? <ViewIcon view="local" size={12} /> : null}
      {branch.remotes.map((entry) => {
        const name = graphRefRemoteLabel(entry)
        return <RemoteMark key={entry.fullName} name={name} url={graphRemoteUrl(name, remoteUrls)} />
      })}
    </span>
  )
}

export function GraphRefPopover({ anchor, entries, remoteUrls, disabled, onCheckout, onClose, onEnter, onLeave, onHoverRef, elementRef }: {
  anchor: RefAnchor
  entries: RefEntry[]
  remoteUrls?: readonly GraphRemoteUrl[]
  disabled: boolean
  onCheckout: (raw: string) => void
  onClose: () => void
  onEnter: () => void
  onLeave: () => void
  onHoverRef: (raw: string | null) => void
  elementRef: RefObject<HTMLDivElement | null>
}) {
  const { t } = useI18n()
  useLayoutEffect(() => {
    const popup = elementRef.current
    if (!popup) return
    const place = () => {
      popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - 8))}px`
      popup.style.top = `${anchor.bottom + popup.offsetHeight + 4 > window.innerHeight ? Math.max(8, anchor.top - popup.offsetHeight - 4) : anchor.bottom + 4}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(popup)
    return () => observer.disconnect()
  }, [anchor, elementRef])
  const decorated = graphCommitRefs(anchor.commit, entries)
  const branches = dropBranchesFromRefs(decorated.flatMap(({ entry }) => (entry && (entry.kind === 'branch' || entry.kind === 'remoteBranch') ? [entry] : [])))
  const tags = groupByBranchName(decorated, (item) => item.entry).find((group) => group.name === '')?.items ?? []
  return createPortal(<div ref={elementRef} className={styles.popup} role="group" aria-label={t('graph.popover.aria')} onPointerEnter={onEnter} onPointerLeave={onLeave} onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) onLeave() }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    {branches.map((branch) => {
      const entry = branch.target
      const checkoutable = isCheckoutableRef(entry)
      const kind = graphRefKind(entry.fullName, entry)
      const kindLabel = entry.isHead ? t('graph.ref.kind.active') : branch.local ? t('graph.ref.kind.local') : t('graph.ref.kind.remote')
      const hoverRaw = decorated.find((item) => item.entry?.fullName === entry.fullName)?.raw ?? entry.name
      return <button key={entry.fullName} type="button" className={styles.reference} data-ref={hoverRaw} data-kind={kind} disabled={disabled || !checkoutable || entry.isHead}
        title={entry.isHead ? t('graph.popover.head') : checkoutable ? t('graph.popover.checkout') : t('graph.popover.symbolic')}
        aria-label={`${branch.name} · ${kindLabel}`}
        onPointerEnter={() => onHoverRef(hoverRaw)}
        onPointerLeave={() => onHoverRef(null)}
        onFocus={() => onHoverRef(hoverRaw)}
        onBlur={() => onHoverRef(null)}
        onDoubleClick={() => { if (checkoutable) onCheckout(entry.fullName) }}
        onKeyDown={(event) => { if (checkoutable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onCheckout(entry.fullName) } }}>
        <ViewIcon view="branch" /><span>{branch.name}</span>
        <BranchMarks branch={branch} remoteUrls={remoteUrls} />
      </button>
    })}
    {tags.map(({ raw, entry, key }) => {
      const kind = graphRefKind(raw, entry)
      const label = graphRefLabel(raw)
      return <button key={key} type="button" className={styles.reference} data-ref={raw} data-kind={kind} disabled
        title={t('graph.popover.tag')}
        aria-label={`${label} · ${t('graph.ref.kind.tag')}`}>
        <ViewIcon view="tags" /><span>{label}</span>
      </button>
    })}
  </div>, document.body)
}

export type DropAnchor = { left: number; top: number; bottom: number }

/** One row per branch: merge lands on the local when it shares the commit. */
export function GraphDropPicker({
  anchor,
  choices,
  current,
  interactive,
  elementRef,
  remoteUrls,
  onChoose,
  onClose,
}: {
  anchor: DropAnchor
  choices: RefEntry[]
  current: string | null
  interactive: boolean
  elementRef: RefObject<HTMLDivElement | null>
  remoteUrls?: readonly GraphRemoteUrl[]
  onChoose?: (entry: RefEntry) => void
  onClose?: () => void
}) {
  const { t } = useI18n()
  useLayoutEffect(() => {
    const popup = elementRef.current
    if (!popup) return
    const place = () => {
      popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - 8))}px`
      popup.style.top = `${anchor.bottom + popup.offsetHeight + 4 > window.innerHeight ? Math.max(8, anchor.top - popup.offsetHeight - 4) : anchor.bottom + 4}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(popup)
    return () => observer.disconnect()
  }, [anchor, choices, elementRef])
  const branches = dropBranchesFromRefs(choices)
  return createPortal(<div ref={elementRef} className={styles.popup} role="menu" aria-label={t('graph.drop.pickAria')}
    data-passive={interactive ? undefined : 'true'}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.() } }}>
    {branches.map((branch) => {
      const selected = current === branch.target.fullName
      const kindLabel = branch.local ? t('graph.ref.kind.local') : t('graph.ref.kind.remote')
      return <button key={branch.target.fullName} type="button" role="menuitem" className={styles.reference}
        data-drop-ref={branch.target.fullName} data-kind={branch.local ? 'local' : 'remote'} data-current={selected ? 'true' : undefined}
        tabIndex={interactive ? 0 : -1}
        aria-label={`${branch.name} · ${kindLabel}`}
        onClick={() => { if (interactive) onChoose?.(branch.target) }}>
        <ViewIcon view="branch" />
        <span>{branch.name}</span>
        <BranchMarks branch={branch} remoteUrls={remoteUrls} />
      </button>
    })}
  </div>, document.body)
}
