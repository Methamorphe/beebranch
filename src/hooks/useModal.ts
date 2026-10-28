import { useEffect, useRef } from 'react'

/** Keep keyboard focus inside a modal and return it to its trigger on close. */
export function useModal(open: boolean, onClose: () => void, busy = false) {
  const ref = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const modal = ref.current
    if (!open || !modal) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const inert: { element: HTMLElement; previous: boolean }[] = []
    let branch: HTMLElement = modal
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          inert.push({ element: sibling, previous: sibling.inert })
          sibling.inert = true
        }
      }
      branch = branch.parentElement
    }
    if (!modal.contains(document.activeElement)) (modal.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? modal).focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busyRef.current) closeRef.current()
      }
      if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0] ?? modal
        const last = elements.at(-1) ?? modal
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !modal.contains(event.target)) (focusable()[0] ?? modal).focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      inert.forEach(({ element, previous: wasInert }) => { element.inert = wasInert })
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
