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
    <div className={p2.pageColumn}>
      <div className={p2.tabs} style={{ padding: '0 0 10px', borderBottom: 0 }}>
        <button
          type="button"
          className={tab === 'tags' ? p2.tabOn : p2.tab}
          onClick={() => setTab('tags')}
        >
          Tags ({tags.length})
        </button>
        <button
          type="button"
          className={tab === 'remotes' ? p2.tabOn : p2.tab}
          onClick={() => setTab('remotes')}
        >
          Remotes ({remotes.length})
        </button>
      </div>

      {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
      {notice ? <p className={p2.notice}>{notice}</p> : null}

      {tab === 'tags' ? (
        <div className={p2.split}>
          <div className={p2.splitMain}>
            <div className={p2.table}>
              <div className={p2.tableHead}>
                <span>Tag</span>
                <span>Objet</span>
                <span>Tagger</span>
                <span />
              </div>
              {tags.map((tag) => (
                <div key={tag.name} className={p2.tableRow}>
                  <div style={{ minWidth: 0 }}>
                    <div className={p2.mono}>{tag.name}</div>
                    <div className={p2.listSub}>
                      {tag.message ?? '(pas de message)'}
                    </div>
                  </div>
                  <span className={p2.listSub}>{tag.oid.slice(0, 10)}</span>
                  <span className={p2.listSub}>
                    {tag.tagger ?? '—'}
                    {tag.annotated ? '' : ' · lightweight'}
                  </span>
                  <span className={p2.row}>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy || !pushRemote}
                      onClick={() => {
                        setPushTag(tag.name)
                        setPushConfirm(true)
                      }}
                    >
                      Push
                    </button>
                    <button
                      type="button"
                      className={p2.danger}
                      disabled={busy}
                      onClick={() => setPending({ kind: 'tag', name: tag.name })}
                    >
                      Supprimer
                    </button>
                  </span>
                </div>
              ))}
              {tags.length === 0 ? <p className={p2.notice} style={{ padding: 12 }}>Aucun tag.</p> : null}
            </div>
          </div>

          <div className={p2.splitSide}>
            <h3 className={p2.cardTitle}>Créer un tag</h3>
            <label className={p2.field}>
              Nom
              <input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v2.8.0" />
            </label>
            <label className={p2.field}>
              Cible
              <input value={tagTarget} onChange={(event) => setTagTarget(event.target.value)} placeholder="HEAD ou sha" />
            </label>
            <label className={p2.field}>
              Message (annoté si rempli)
              <textarea
                value={tagMessage}
                onChange={(event) => setTagMessage(event.target.value)}
                rows={3}
                placeholder="chore(release): prepare v2.8.0"
              />
            </label>
            <label className={p2.checkbox}>
              <input type="checkbox" checked={tagForce} onChange={(event) => setTagForce(event.target.checked)} />
              Forcer (déplace un tag existant)
            </label>
            <label className={p2.field}>
              Remote de push
              <select value={pushRemote} onChange={(event) => setPushRemote(event.target.value)}>
                {remotes.map((remote) => (
                  <option key={remote.name} value={remote.name}>
                    {remote.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={p2.primary}
              disabled={busy || !tagName.trim()}
              onClick={() =>
                void run('Tag créé.', async () => {
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
              Créer le tag
            </button>
            <p className={p2.notice}>
              Un tag annoté conserve son message et son tagger. Le push de tag est
              toujours explicite.
            </p>
          </div>
        </div>
      ) : (
        <div className={p2.split}>
          <div className={p2.splitMain}>
            <div className={p2.table}>
              <div className={p2.tableHead}>
                <span>Remote</span>
                <span>Fetch</span>
                <span>Push</span>
                <span />
              </div>
              {remotes.map((remote) => (
                <div key={remote.name} className={p2.tableRow}>
                  <span className={p2.mono}>{remote.name}</span>
                  <span className={p2.listSub}>{remote.fetchUrl ?? '—'}</span>
                  <span className={p2.listSub}>{remote.pushUrl ?? '—'}</span>
                  <span className={p2.row}>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() => void run('Prune terminé.', () => remotePrune({ repoId, name: remote.name }))}
                    >
                      Prune
                    </button>
                    <button
                      type="button"
                      className={p2.danger}
                      disabled={busy}
                      onClick={() => setPending({ kind: 'remote', name: remote.name })}
                    >
                      Supprimer
                    </button>
                  </span>
                </div>
              ))}
              {remotes.length === 0 ? <p className={p2.notice} style={{ padding: 12 }}>Aucun remote.</p> : null}
            </div>
          </div>

          <div className={p2.splitSide}>
            <h3 className={p2.cardTitle}>Ajouter un remote</h3>
            <label className={p2.field}>
              Nom
              <input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} placeholder="origin" />
            </label>
            <label className={p2.field}>
              URL
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
                void run('Remote ajouté.', async () => {
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
              Ajouter
            </button>

            <h3 className={p2.cardTitle} style={{ marginTop: 14 }}>
              Modifier une URL
            </h3>
            <label className={p2.field}>
              Remote
              <select value={setUrlName} onChange={(event) => setSetUrlName(event.target.value)}>
                {remotes.map((remote) => (
                  <option key={remote.name} value={remote.name}>
                    {remote.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={p2.field}>
              Nouvelle URL
              <input value={setUrlValue} onChange={(event) => setSetUrlValue(event.target.value)} spellCheck={false} />
            </label>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={setUrlPush}
                onChange={(event) => setSetUrlPush(event.target.checked)}
              />
              URL de push
            </label>
            <button
              type="button"
              className={p2.secondary}
              disabled={busy || !setUrlName || !setUrlValue.trim()}
              onClick={() =>
                void run('URL modifiée.', async () => {
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
              Appliquer
            </button>
            <p className={p2.notice}>
              Les URL contenant un mot de passe sont refusées : utilisez un
              credential helper ou une clé SSH.
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'tag' ? 'Supprimer un tag' : 'Supprimer un remote'}
        consequence={
          pending?.kind === 'tag'
            ? `Le tag ${pending.name} sera supprimé localement. Le commit reste intact.`
            : `Le remote ${pending?.name ?? ''} sera retiré et ses refs distantes associées supprimées.`
        }
        irreversible
        typed={pending?.name}
        confirmLabel="Supprimer"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={(typed) => {
          const target = pending
          setPending(null)
          if (!target) {
            return
          }
          if (target.kind === 'tag') {
            void run('Tag supprimé.', () =>
              tagDelete({
                repoId,
                name: target.name,
                confirmation: { acknowledged: true, typed },
              }),
            )
          } else {
            void run('Remote supprimé.', () =>
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
        title="Pousser un tag"
        consequence={`Le tag ${pushTag} sera poussé vers ${pushRemote}. Un tag distant existant ne sera pas écrasé par ce push.`}
        confirmLabel="Pousser"
        busy={busy}
        onCancel={() => setPushConfirm(false)}
        onConfirm={() => {
          setPushConfirm(false)
          void run('Tag poussé.', () =>
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
