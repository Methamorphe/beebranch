import { useState } from 'react'
import { useI18n } from '../i18n'
import type { RefEntry } from '../types/git'
import { ConfirmBar } from './ConfirmBar'
import { ActionBar } from './ui/ActionBar'
import { Button } from './ui/Button'
import bar from './ui/ActionBar.module.css'

/** A remote-tracking ref whose short name is already a local branch. */
export type RemoteCheckoutRequest = {
  remote: RefEntry
  existing: RefEntry
  altName: string
}

/**
 * Checking out `upstream/feature` when `feature` already tracks another
 * remote. The three actions keep that conflict explicit instead of failing
 * with a generic backend error.
 */
export function RemoteCheckoutBar({
  request,
  busy,
  onCancel,
  onSwitch,
  onMove,
  onCreate,
}: {
  request: RemoteCheckoutRequest | null
  busy: boolean
  onCancel: () => void
  onSwitch: () => void
  onMove: () => void
  onCreate: (name: string) => void
}) {
  if (!request) return null
  return (
    <RemoteCheckoutForm
      key={`${request.remote.fullName}\0${request.existing.fullName}\0${request.altName}`}
      request={request}
      busy={busy}
      onCancel={onCancel}
      onSwitch={onSwitch}
      onMove={onMove}
      onCreate={onCreate}
    />
  )
}

function RemoteCheckoutForm({
  request,
  busy,
  onCancel,
  onSwitch,
  onMove,
  onCreate,
}: {
  request: RemoteCheckoutRequest
  busy: boolean
  onCancel: () => void
  onSwitch: () => void
  onMove: () => void
  onCreate: (name: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(request.altName)
  const trimmed = name.trim()
  const taken = trimmed === request.existing.name
  return (
    <ActionBar
      tone="primary"
      title={t('workbench.checkout.remoteTitle', {
        remote: request.remote.name,
        branch: request.existing.name,
      })}
      busy={busy}
      onCancel={onCancel}
      actions={
        <>
          <Button type="button" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={onSwitch} disabled={busy}>
            {t('workbench.checkout.switchExisting', { branch: request.existing.name })}
          </Button>
          <Button type="button" size="sm" onClick={onMove} disabled={busy}>
            {t('workbench.checkout.moveExisting', {
              branch: request.existing.name,
              remote: request.remote.name,
            })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-autofocus
            disabled={busy || trimmed.length === 0 || taken}
            onClick={() => onCreate(trimmed)}
          >
            {t('workbench.checkout.createOther', { name: trimmed || request.altName })}
          </Button>
        </>
      }
    >
      <p>{t('workbench.error.localBranchAlreadyTracks', { name: request.existing.name })}</p>
      <div className={bar.choice}>
        <label>
          {t('workbench.checkout.otherName')}
          <input
            value={name}
            aria-label={t('workbench.checkout.otherName')}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </div>
    </ActionBar>
  )
}

/** Merge a branch into a remote-tracking ref by way of a local branch. */
export type MergeRemoteRequest = {
  source: RefEntry
  remote: RefEntry
  localName: string
}

/**
 * `upstream/main` cannot be checked out. The bar names the local branch that
 * will receive the merge; the caller then offers to push that branch only.
 */
export function MergeRemoteBar({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: MergeRemoteRequest | null
  busy: boolean
  onCancel: () => void
  onConfirm: (localName: string) => void
}) {
  if (!request) return null
  return (
    <MergeRemoteForm
      key={`${request.source.fullName}\0${request.remote.fullName}\0${request.localName}`}
      request={request}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

function MergeRemoteForm({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: MergeRemoteRequest
  busy: boolean
  onCancel: () => void
  onConfirm: (localName: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(request.localName)
  const trimmed = name.trim()
  return (
    <ConfirmBar
      open
      tone="primary"
      busy={busy}
      title={t('workbench.mergeRemote.title', {
        source: request.source.name,
        remote: request.remote.name,
      })}
      consequence={t('workbench.mergeRemote.consequence', {
        source: request.source.name,
        remote: request.remote.name,
        branch: trimmed || request.localName,
      })}
      confirmLabel={t('workbench.mergeRemote.confirm')}
      confirmDisabled={trimmed.length === 0}
      onCancel={onCancel}
      onConfirm={() => onConfirm(trimmed)}
    >
      <div className={bar.choice}>
        <label>
          {t('workbench.mergeRemote.localName')}
          <input
            value={name}
            aria-label={t('workbench.mergeRemote.localName')}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </div>
    </ConfirmBar>
  )
}
