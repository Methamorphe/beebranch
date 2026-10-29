import { useCallback, useEffect, useState } from 'react'
import {
  remoteAdd,
  remoteList,
  remotePrune,
  remoteRemove,
  remoteSetUrl,
  tagCreate,
  tagDelete,
  tagList,
  tagPush,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { RemoteInfo, TagInfo } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  initialTab: 'tags' | 'remotes'
  onMutated: () => void
}

type Pending =
  | { kind: 'tag'; name: string }
  | { kind: 'remote'; name: string }
  | null

export function RefsAdminPanel({ repoId, generation, initialTab, onMutated }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'tags' | 'remotes'>(initialTab)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [remotes, setRemotes] = useState<RemoteInfo[]>([])
  const [tagName, setTagName] = useState('')
  const [tagMessage, setTagMessage] = useState('')
  const [tagTarget, setTagTarget] = useState('HEAD')
  const [tagForce, setTagForce] = useState(false)
  const [pushRemote, setPushRemote] = useState('')
  const [pushTag, setPushTag] = useState('')
  const [remoteName, setRemoteName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [setUrlName, setSetUrlName] = useState('')
  const [setUrlValue, setSetUrlValue] = useState('')
  const [setUrlPush, setSetUrlPush] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [pushConfirm, setPushConfirm] = useState(false)

  const load = useCallback(async () => {
    try {
      const [nextTags, nextRemotes] = await Promise.all([
        tagList(repoId),
        remoteList(repoId),
      ])
      setTags(nextTags)
      setRemotes(nextRemotes)
      setPushRemote((current) => current || nextRemotes[0]?.name || '')
      setSetUrlName((current) => current || nextRemotes[0]?.name || '')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, generation])

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <div className={p2.segmented} role="group" aria-label={t('ops.refs.groupAria')}>
          <button
            type="button"
            className={tab === 'tags' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'tags'}
            onClick={() => setTab('tags')}
          >
            {t('ops.refs.tagsTab', { count: tags.length })}
          </button>
          <button
            type="button"
            className={tab === 'remotes' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'remotes'}
            onClick={() => setTab('remotes')}
          >
            {t('ops.refs.remotesTab', { count: remotes.length })}
          </button>
        </div>
        <span className={p2.spacer} />
        {tab === 'tags' ? (
          <label className={p2.fieldInline}>
            <span className={p2.toolbarLabel}>{t('ops.refs.pushRemoteLabel')}</span>
            <select
              value={pushRemote}
              onChange={(event) => setPushRemote(event.target.value)}
              aria-label={t('ops.refs.pushRemoteAria')}
            >
              {remotes.length === 0 ? <option value="">{t('ops.refs.noRemote')}</option> : null}
              {remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>
                  {remote.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className={p2.listHeader} role="status">
          <span className={p2.meta}>{notice}</span>
        </div>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          {tab === 'tags' ? (
            <>
              <div className={p2.listHeader}>
                <span className={p2.label}>{t('ops.refs.tagsLabel')}</span>
                <span className={`${p2.count} ${p2.tabnum}`}>{tags.length}</span>
                <span className={p2.spacer} />
                <span className={p2.count}>{t('ops.refs.pushExplicit')}</span>
              </div>
              <div className={p2.rows}>
                {tags.map((tag) => (
                  <div key={tag.name} className={p2.entry}>
                    <span className={p2.dot} data-tone="accent" />
                    <div className={p2.entryStack}>
                      <span className={p2.entryTitle}>
                        <strong className={p2.mono}>{tag.name}</strong>
                      </span>
                      <span className={p2.entryMeta}>
                        <span className={`${p2.chip} ${tag.annotated ? p2.chipInfo : ''}`}>
                          {tag.annotated ? t('ops.refs.annotated') : t('ops.refs.lightweight')}
                        </span>
                        <span className={p2.mono}>{tag.oid.slice(0, 10)}</span>
                        <span>·</span>
                        <span>{tag.tagger ?? t('ops.refs.unknownAuthor')}</span>
                      </span>
                      {tag.message ? (
                        <span className={p2.entryMeta}>
                          <span>{tag.message}</span>
                        </span>
                      ) : null}
                    </div>
                    <span className={p2.entryActions}>
                      <button
                        type="button"
                        className={p2.secondary}
                        disabled={busy || !pushRemote}
                        onClick={() => {
                          setPushTag(tag.name)
                          setPushConfirm(true)
                        }}
                      >
                        {t('ops.refs.push')}
                      </button>
                      <button
                        type="button"
                        className={p2.ghostDanger}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'tag', name: tag.name })}
                      >
                        {t('common.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {tags.length === 0 ? (
                <div className={p2.empty} role="status">
                  <h2>{t('ops.refs.emptyTagsTitle')}</h2>
                  <p>{t('ops.refs.emptyTagsBody')}</p>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className={p2.listHeader}>
                <span className={p2.label}>{t('ops.refs.remotesLabel')}</span>
                <span className={`${p2.count} ${p2.tabnum}`}>{remotes.length}</span>
                <span className={p2.spacer} />
                <span className={p2.count}>{t('ops.refs.urlNoPassword')}</span>
              </div>
              <div className={p2.rows}>
                {remotes.map((remote) => (
                  <div key={remote.name} className={p2.entry}>
                    <span className={p2.dot} data-tone="info" />
                    <div className={p2.entryStack}>
                      <span className={p2.entryTitle}>
                        <strong className={p2.mono}>{remote.name}</strong>
                      </span>
                      <span className={`${p2.entryMeta} ${p2.mono}`}>
                        <span>{remote.fetchUrl ?? '—'}</span>
                      </span>
                      {remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? (
                        <span className={`${p2.entryMeta} ${p2.mono}`}>
                          <span>{t('ops.refs.pushUrl', { url: remote.pushUrl })}</span>
                        </span>
                      ) : null}
                    </div>
                    <span className={p2.entryActions}>
                      <button
                        type="button"
                        className={p2.secondary}
                        disabled={busy}
                        onClick={() =>
                          void run(t('ops.refs.notice.pruneDone'), () =>
                            remotePrune({ repoId, name: remote.name }),
                          )
                        }
                      >
                        {t('ops.refs.prune')}
                      </button>
                      <button
                        type="button"
                        className={p2.ghostDanger}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'remote', name: remote.name })}
                      >
                        {t('common.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {remotes.length === 0 ? (
                <div className={p2.empty} role="status">
                  <h2>{t('ops.refs.emptyRemotesTitle')}</h2>
                  <p>{t('ops.refs.emptyRemotesBody')}</p>
                </div>
              ) : null}
            </>
          )}
        </div>

        <aside className={p2.screenAside}>
          {tab === 'tags' ? (
            <section className={p2.asideSection}>
              <h2 className={p2.asideTitle}>{t('ops.refs.createTagTitle')}</h2>
              <label className={p2.field}>
                {t('common.name')}
                <input
                  value={tagName}
                  onChange={(event) => setTagName(event.target.value)}
                  placeholder="v2.8.0"
                  spellCheck={false}
                />
              </label>
              <label className={p2.field}>
                {t('ops.refs.targetLabel')}
                <input
                  value={tagTarget}
                  onChange={(event) => setTagTarget(event.target.value)}
                  placeholder={t('ops.refs.targetPlaceholder')}
                  spellCheck={false}
                />
              </label>
              <label className={p2.field}>
                {t('ops.refs.tagMessageLabel')}
                <textarea
                  value={tagMessage}
                  onChange={(event) => setTagMessage(event.target.value)}
                  rows={3}
                  placeholder="chore(release): prepare v2.8.0"
                />
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={tagForce}
                  onChange={(event) => setTagForce(event.target.checked)}
                />
                {t('ops.refs.forceLabel')}
              </label>
              <button
                type="button"
                className={p2.primary}
                disabled={busy || !tagName.trim()}
                onClick={() =>
                  void run(t('ops.refs.notice.tagCreated'), async () => {
                    await tagCreate({
                      repoId,
                      name: tagName.trim(),
                      message: tagMessage.trim() || undefined,
                      target: tagTarget.trim() || undefined,
                      force: tagForce,
                    })
                    setTagName('')
                    setTagMessage('')
                  })
                }
              >
                {t('ops.refs.createTag')}
              </button>
              <p className={p2.asideHint}>
                {t('ops.refs.createTagHint')}
              </p>
            </section>
          ) : (
            <>
              <section className={p2.asideSection}>
                <h2 className={p2.asideTitle}>{t('ops.refs.addRemoteTitle')}</h2>
                <label className={p2.field}>
                  {t('common.name')}
                  <input
                    value={remoteName}
                    onChange={(event) => setRemoteName(event.target.value)}
                    placeholder="origin"
                    spellCheck={false}
                  />
                </label>
                <label className={p2.field}>
                  {t('common.url')}
                  <input
                    value={remoteUrl}
                    onChange={(event) => setRemoteUrl(event.target.value)}
                    placeholder="git@gitlab.example.com:team/repo.git"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className={p2.primary}
                  disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
                  onClick={() =>
                    void run(t('ops.refs.notice.remoteAdded'), async () => {
                      await remoteAdd({
                        repoId,
                        name: remoteName.trim(),
                        url: remoteUrl.trim(),
                      })
                      setRemoteName('')
                      setRemoteUrl('')
                    })
                  }
                >
                  {t('common.add')}
                </button>
              </section>

              <section className={p2.asideSection}>
                <h2 className={p2.asideTitle}>{t('ops.refs.setUrlTitle')}</h2>
                <label className={p2.field}>
                  {t('ops.refs.remoteLabel')}
                  <select
                    value={setUrlName}
                    onChange={(event) => setSetUrlName(event.target.value)}
                  >
                    {remotes.length === 0 ? <option value="">{t('ops.refs.noRemote')}</option> : null}
                    {remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>
                        {remote.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={p2.field}>
                  {t('ops.refs.newUrlLabel')}
                  <input
                    value={setUrlValue}
                    onChange={(event) => setSetUrlValue(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label className={p2.checkbox}>
                  <input
                    type="checkbox"
                    checked={setUrlPush}
                    onChange={(event) => setSetUrlPush(event.target.checked)}
                  />
                  {t('ops.refs.pushUrlLabel')}
                </label>
                <button
                  type="button"
                  className={p2.secondary}
                  disabled={busy || !setUrlName || !setUrlValue.trim()}
                  onClick={() =>
                    void run(t('ops.refs.notice.urlChanged'), async () => {
                      await remoteSetUrl({
                        repoId,
                        name: setUrlName,
                        url: setUrlValue.trim(),
                        push: setUrlPush,
                      })
                      setSetUrlValue('')
                    })
                  }
                >
                  {t('common.apply')}
                </button>
                <p className={p2.asideHint}>
                  {t('ops.refs.setUrlHint')}
                </p>
              </section>
            </>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'tag' ? t('ops.refs.deleteTagTitle') : t('ops.refs.deleteRemoteTitle')}
        consequence={
          pending?.kind === 'tag'
            ? t('ops.refs.deleteTagConsequence', { name: pending.name })
            : t('ops.refs.deleteRemoteConsequence', { name: pending?.name ?? '' })
        }
        irreversible
        typed={pending?.name}
        confirmLabel={t('common.delete')}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={(typed) => {
          const target = pending
          setPending(null)
          if (!target) {
            return
          }
          if (target.kind === 'tag') {
            void run(t('ops.refs.notice.tagDeleted'), () =>
              tagDelete({
                repoId,
                name: target.name,
                confirmation: { acknowledged: true, typed },
              }),
            )
          } else {
            void run(t('ops.refs.notice.remoteDeleted'), () =>
              remoteRemove({
                repoId,
                name: target.name,
                confirmation: { acknowledged: true, typed },
              }),
            )
          }
        }}
      />

      <ConfirmDialog
        open={pushConfirm}
        title={t('ops.refs.pushTagTitle')}
        consequence={t('ops.refs.pushTagConsequence', { tag: pushTag, remote: pushRemote })}
        confirmLabel={t('ops.refs.pushConfirm')}
        busy={busy}
        onCancel={() => setPushConfirm(false)}
        onConfirm={() => {
          setPushConfirm(false)
          void run(t('ops.refs.notice.tagPushed'), () =>
            tagPush({
              repoId,
              remote: pushRemote,
              name: pushTag,
              confirmation: { acknowledged: true },
            }),
          )
        }}
      />
    </div>
  )
}
