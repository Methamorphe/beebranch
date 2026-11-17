import { useState } from 'react'
import { useI18n } from '../i18n'
import { ConfirmBar } from './ConfirmBar'
import bar from './ui/ActionBar.module.css'

/**
 * A local branch and the remote that should receive it.
 *
 * `setUpstream` records that remote as the tracking upstream. A push to a
 * second remote leaves it false so the branch keeps pulling from the first.
 */
export type PublishTarget = {
  branch: string
  remote: string
  /** Remotes the user can switch to. A single entry hides the picker. */
  remotes: string[]
  setUpstream: boolean
}

export type PublishChoice = { remote: string; setUpstream: boolean }

type Props = {
  target: PublishTarget | null
  onCancel: () => void
  onConfirm: (choice: PublishChoice) => void
}

/**
 * Offers the push that shares a local branch. The first push can record the
 * remote as the tracking upstream; a later push to another remote does not,
 * unless the checkbox says so.
 */
export function PublishBranchBar({ target, onCancel, onConfirm }: Props) {
  if (!target) return null
  const key = `${target.branch}\0${target.remote}\0${String(target.setUpstream)}\0${target.remotes.join('\0')}`
  return <PublishForm key={key} target={target} onCancel={onCancel} onConfirm={onConfirm} />
}

function PublishForm({ target, onCancel, onConfirm }: {
  target: PublishTarget
  onCancel: () => void
  onConfirm: (choice: PublishChoice) => void
}) {
  const { t } = useI18n()
  const [remote, setRemote] = useState(target.remote)
  const [track, setTrack] = useState(target.setUpstream)
  const remotes = target.remotes.length > 0 ? target.remotes : [target.remote]
  const selected = remotes.includes(remote) ? remote : target.remote
  return (
    <ConfirmBar
      open
      title={t('workbench.publish.title', { branch: target.branch })}
      consequence={
        track
          ? t('workbench.publish.consequence', { branch: target.branch, remote: selected })
          : t('workbench.publish.consequenceKeep', { branch: target.branch, remote: selected })
      }
      confirmLabel={t('workbench.publish.confirm', {
        branch: target.branch,
        remote: selected,
      })}
      tone="primary"
      onCancel={onCancel}
      onConfirm={() => onConfirm({ remote: selected, setUpstream: track })}
    >
      <div className={bar.choice}>
        {remotes.length > 1 ? (
          <label>
            {t('workbench.publish.remoteLabel')}
            <select
              value={selected}
              aria-label={t('workbench.publish.remoteLabel')}
              onChange={(event) => setRemote(event.target.value)}
            >
              {remotes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={track}
            onChange={(event) => setTrack(event.target.checked)}
          />
          {t('workbench.publish.trackLabel')}
        </label>
      </div>
    </ConfirmBar>
  )
}
