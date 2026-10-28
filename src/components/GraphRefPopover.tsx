import { useLayoutEffect, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { CommitSummary, RefEntry } from '../types/git'
import { graphCommitRefs, graphRefKind, graphRefLabel, isCheckoutableRef } from '../lib/graphRefs'
import { ViewIcon } from './ViewIcon'
import styles from './GraphRefPopover.module.css'

export type RefAnchor = { commit: CommitSummary; left: number; top: number; bottom: number }

export function GraphRefPopover({ anchor, entries, disabled, onCheckout, onClose, onEnter, onLeave, elementRef }: {
  anchor: RefAnchor
  entries: RefEntry[]
  disabled: boolean
  onCheckout: (raw: string) => void
  onClose: () => void
  onEnter: () => void
  onLeave: () => void
  elementRef: RefObject<HTMLDivElement | null>
}) {
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
  return createPortal(<div ref={elementRef} className={styles.popup} role="group" aria-label="Branches et tags de ce commit" onPointerEnter={onEnter} onPointerLeave={onLeave} onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) onLeave() }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><strong>Branches et tags</strong><code>{anchor.commit.sha.slice(0, 8)}</code></header>
    <div className={styles.list}>
      {graphCommitRefs(anchor.commit, entries).map(({ raw, entry, key }) => {
        const checkoutable = isCheckoutableRef(entry)
        const kind = graphRefKind(raw, entry)
        return <button key={key} type="button" className={styles.reference} data-ref={raw} data-kind={kind} disabled={disabled || !checkoutable || entry.isHead}
          title={kind === 'tag' ? 'Tag' : entry?.isHead ? 'Branche active' : checkoutable ? 'Double-clic pour checkout · Entrée au clavier' : 'Référence symbolique'}
          onDoubleClick={() => { if (checkoutable) onCheckout(entry!.fullName) }}
          onKeyDown={(event) => { if (checkoutable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onCheckout(entry!.fullName) } }}>
          <ViewIcon view={kind === 'tag' ? 'tags' : kind === 'remote' ? 'remotes' : 'branch'} /><span>{graphRefLabel(raw)}</span><small>{entry?.isHead ? 'active' : kind === 'tag' ? 'tag' : kind === 'remote' ? 'distante' : 'locale'}</small>
        </button>
      })}
    </div>
    <footer>Double-clic sur une branche pour checkout</footer>
  </div>, document.body)
}
