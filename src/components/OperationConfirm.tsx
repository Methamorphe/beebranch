import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useI18n, type I18n } from '../i18n'
import { errorMessage } from '../ipc/client'
import { operationPreview } from '../ipc/commands'
import type { OperationPreview, PreviewOperation } from '../types/git'
import { ConfirmBar } from './ConfirmBar'
import styles from './OperationConfirm.module.css'

export type ConfirmOperation = (request: {
  title: string
  operation: PreviewOperation
  confirmLabel?: string
  tone?: 'primary' | 'danger'
}) => Promise<boolean>

const ConfirmContext = createContext<ConfirmOperation>(() => Promise.resolve(false))

/** Ask for the pre-operation summary; resolves `true` on confirmation. */
export function useOperationConfirm() {
  return useContext(ConfirmContext)
}

type Pending = {
  title: string
  confirmLabel?: string
  tone: 'primary' | 'danger'
  preview: OperationPreview | null
  error: string | null
  busy: boolean
}

type Props = {
  repoId: string | null
  /**
   * Exposes the same function to a component that renders the provider and
   * therefore cannot consume its context (the shell's shortcuts).
   */
  store?: { current: ConfirmOperation | null }
  children: ReactNode
}

/**
 * One confirmation bar for every operation that previews its effect.
 *
 * The summary is read from Git before anything runs; the confirming button
 * stays disabled while it loads or when the operation would refuse.
 */
export function OperationConfirmProvider({ repoId, store, children }: Props) {
  const i18n = useI18n()
  const { t } = i18n
  const [pending, setPending] = useState<Pending | null>(null)
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null)

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setPending(null)
    resolve?.(confirmed)
  }, [])

  const confirm = useCallback<ConfirmOperation>(
    (request) => {
      if (!repoId) return Promise.resolve(false)
      // A second ask cancels the first: only one bar is ever actionable.
      resolveRef.current?.(false)
      // `Promise.withResolvers` is ES2024 while the webview target is Safari 13.
      let resolve!: (confirmed: boolean) => void
      const promise = new Promise<boolean>((settle) => {
        resolve = settle
      })
      resolveRef.current = resolve
      setPending({
        title: request.title,
        confirmLabel: request.confirmLabel,
        tone: request.tone ?? 'primary',
        preview: null,
        error: null,
        busy: true,
      })
      operationPreview({ repoId, operation: request.operation })
        .then((preview) =>
          setPending((current) =>
            current ? { ...current, preview, busy: false } : current,
          ),
        )
        .catch((cause) =>
          setPending((current) =>
            current ? { ...current, error: errorMessage(cause), busy: false } : current,
          ),
        )
      return promise
    },
    [repoId],
  )

  useEffect(() => {
    if (!store) return
    store.current = confirm
    return () => {
      if (store.current === confirm) store.current = null
    }
  }, [confirm, store])

  const preview = pending?.preview ?? null
  const blocked = Boolean(preview?.blockedReason)

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <ConfirmBar
          open
          tone={pending.tone}
          title={pending.title}
          consequence={
            pending.error ??
            (pending.busy
              ? t('workbench.operationPreview.loading')
              : preview
                ? summary(preview, i18n)
                : '')
          }
          confirmLabel={pending.confirmLabel}
          busy={pending.busy}
          confirmDisabled={Boolean(pending.error) || blocked || !preview}
          onCancel={() => settle(false)}
          onConfirm={() => {
            if (pending.busy || pending.error || !preview || preview.blockedReason) return
            settle(true)
          }}
        >
          {blocked ? (
            <p className={styles.blocked}>{preview?.blockedReason}</p>
          ) : null}
          {preview && preview.conflictedFiles.length > 0 ? (
            <ul className={styles.files}>
              {preview.conflictedFiles.slice(0, 8).map((path) => (
                <li key={path}>{path}</li>
              ))}
              {preview.conflictedFiles.length > 8 ? (
                <li>
                  {t('workbench.operationPreview.moreFiles', {
                    count: preview.conflictedFiles.length - 8,
                  })}
                </li>
              ) : null}
            </ul>
          ) : null}
        </ConfirmBar>
      ) : null}
    </ConfirmContext.Provider>
  )
}

function summary(preview: OperationPreview, { t, plural }: I18n) {
  const parts: string[] = []
  if (preview.commits > 0) {
    parts.push(
      plural(
        'workbench.operationPreview.commits.one',
        'workbench.operationPreview.commits.other',
        preview.commits,
        { count: preview.commits },
      ),
    )
  }
  if (preview.behind > 0) {
    parts.push(
      plural(
        'workbench.operationPreview.behind.one',
        'workbench.operationPreview.behind.other',
        preview.behind,
        { count: preview.behind },
      ),
    )
  }
  if (preview.files > 0) {
    parts.push(
      plural(
        'workbench.operationPreview.files.one',
        'workbench.operationPreview.files.other',
        preview.files,
        { count: preview.files },
      ),
    )
  }
  if (preview.additions > 0 || preview.deletions > 0) {
    parts.push(
      t('workbench.operationPreview.lines', {
        additions: preview.additions,
        deletions: preview.deletions,
      }),
    )
  }
  if (preview.conflictCheck === 'conflicts') {
    parts.push(
      plural(
        'workbench.operationPreview.conflicts.one',
        'workbench.operationPreview.conflicts.other',
        preview.conflictedFiles.length,
        { count: preview.conflictedFiles.length },
      ),
    )
  } else if (preview.conflictCheck === 'unavailable' && preview.files > 0) {
    parts.push(t('workbench.operationPreview.conflictsUnknown'))
  }
  if (preview.stashesLocalChanges) {
    parts.push(t('workbench.operationPreview.stashesLocalChanges'))
  }
  if (preview.upstreamMissing) {
    parts.push(t('workbench.operationPreview.upstreamMissing'))
  }
  return parts.join(' · ')
}
