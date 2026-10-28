import { useCallback, useEffect, useRef, useState } from 'react'
import {
  commitIdentity,
  gitlabStatus,
  profileApplyIdentity,
  profileCreate,
  profileDelete,
  profileGitlabActivate,
  profileSetActive,
  profileUpdate,
  profilesList,
  updateCheck,
  updateInstall,
  updateRollback,
  updateStatus,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type {
  GitIdentity,
  GitlabSession,
  Profile,
  ProfilesView,
  UpdateInfo,
  UpdateStatus,
} from '../types/git'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  findConflicts,
  normalizeShortcut,
  type ShortcutAction,
  type ShortcutMap,
} from '../lib/shortcuts'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'
import styles from './ProfilesPanel.module.css'

type Props = {
  repoId: string | null
  connected: boolean
  theme: 'dark' | 'light' | 'system'
  onThemeChange: (theme: 'dark' | 'light' | 'system') => void
  density: 'compact' | 'comfortable'
  onDensityChange: (density: 'compact' | 'comfortable') => void
  onMutated: () => void
  onOpenGitlab: () => void
  shortcuts: ShortcutMap
  onShortcutsChange: (next: ShortcutMap) => void
}

const EMPTY = {
  name: '',
  userName: '',
  userEmail: '',
  defaultPull: 'rebase',
  gitlabInstanceId: '',
}

export function ProfilesPanel({
  repoId,
  connected,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  onMutated,
  onOpenGitlab,
  shortcuts,
  onShortcutsChange,
}: Props) {
  const editorRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<ProfilesView | null>(null)
  const [session, setSession] = useState<GitlabSession | null>(null)
  const [identity, setIdentity] = useState<GitIdentity | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutMap>(shortcuts)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [available, setAvailable] = useState<UpdateInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [pendingInstall, setPendingInstall] = useState(false)
  const [pendingRollback, setPendingRollback] = useState(false)

  const load = useCallback(async () => {
    try {
      setView(await profilesList())
      setSession(await gitlabStatus())
      if (repoId) {
        setIdentity(await commitIdentity(repoId))
      } else {
        setIdentity(null)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void updateStatus()
      .then(setUpdate)
      .catch(() => setUpdate(null))
  }, [])

  useEffect(() => {
    setShortcutDraft(shortcuts)
  }, [shortcuts])

  const active = view?.profiles.find((profile) => profile.id === view.activeId) ?? null

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    const input = {
      name: form.name.trim(),
      userName: form.userName.trim(),
      userEmail: form.userEmail.trim(),
      defaultPull: form.defaultPull,
      gitlabInstanceId: form.gitlabInstanceId.trim() || undefined,
    }
    void run(editing ? 'Profil mis à jour.' : 'Profil créé.', async () => {
      if (editing) {
        await profileUpdate(editing, input)
      } else {
        await profileCreate(input)
      }
      setForm(EMPTY)
      setEditing(null)
    })
  }

  return (
    <div className={p2.page}>
      <div className={p2.settingsGrid}>
        <h2 className={p2.cardTitle}>Général</h2>
        <div className={p2.setting}>
          <div>
            <strong>Apparence</strong>
            <p>Thème du poste de travail</p>
          </div>
          <div className={p2.settingControls}>
            <select
              value={theme}
              onChange={(event) =>
                onThemeChange(event.target.value as 'dark' | 'light' | 'system')
              }
              aria-label="Thème"
            >
              <option value="dark">Sombre</option>
              <option value="light">Clair</option>
              <option value="system">Système</option>
            </select>
            <select
              value={density}
              onChange={(event) =>
                onDensityChange(event.target.value as 'compact' | 'comfortable')
              }
              aria-label="Densité"
            >
              <option value="comfortable">Confortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </div>
        <div className={p2.setting}>
          <div>
            <strong>Mises à jour signées</strong>
            <p>
              Version {update?.currentVersion ?? '—'} · {update?.platform ?? ''}.
              {update?.endpoint ? ' Manifeste signé vérifié avant installation.' : ' Aucun endpoint configuré.'}
              {' '}Aucune télémétrie n'est envoyée.
            </p>
          </div>
          <div className={p2.settingControls}>
            <button
              type="button"
              className={p2.secondary}
              disabled={updateBusy || restarting || !update?.endpoint}
              onClick={() => {
                setUpdateBusy(true)
                setError(null)
                void updateCheck()
                  .then((next) => {
                    setAvailable(next)
                    setNotice(
                      next
                        ? `Mise à jour ${next.version} disponible.`
                        : 'BeeBranch est à jour.',
                    )
                  })
                  .catch((cause) => setError(errorMessage(cause)))
                  .finally(() => setUpdateBusy(false))
              }}
            >
              {restarting ? 'Redémarrage…' : updateBusy ? 'Vérification…' : 'Vérifier les mises à jour'}
            </button>
            {available ? (
              <>
                <span className={p2.pill}>v{available.version}</span>
                <button
                  type="button"
                  className={p2.primary}
                  disabled={updateBusy || restarting}
                  onClick={() => setPendingInstall(true)}
                >
                  Installer
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={p2.secondary}
              disabled={updateBusy || restarting || !update?.rollbackEndpoint}
              onClick={() => setPendingRollback(true)}
            >
              Revenir à la version précédente
            </button>
          </div>
        </div>
        {available?.notes ? (
          <div className={p2.setting}>
            <div>
              <strong>Notes de version</strong>
              <pre className={p2.pre}>{available.notes}</pre>
            </div>
          </div>
        ) : null}
        <div className={p2.setting}>
          <div>
            <strong>Identité Git du dépôt</strong>
            <p>Utilisée par le prochain commit (configuration Git locale)</p>
          </div>
          <div className={p2.settingControls}>
            <span className={p2.mono}>
              {identity?.name ?? 'non configurée'}
              {identity?.email ? ` <${identity.email}>` : ''}
            </span>
          </div>
        </div>
        <div className={p2.setting}>
          <div>
            <strong>GitLab</strong>
            <p>
              {connected
                ? `${session?.instance?.baseUrl ?? 'instance'} · @${session?.user?.username ?? 'connecté'}`
                : 'Aucune instance active'}
            </p>
          </div>
          <div className={p2.settingControls}>
            <button type="button" className={p2.secondary} onClick={onOpenGitlab}>
              {connected ? 'Gérer la connexion' : 'Configurer GitLab'}
            </button>
          </div>
        </div>

        <h2 className={p2.sectionTitle}>Raccourcis clavier</h2>
        <p className={p2.notice}>
          Format : Mod+Shift+F (Mod = ⌘ ou Ctrl). Escape ferme toujours les
          dialogues. Les doublons sont refusés explicitement.
        </p>
        {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
          <div key={action} className={p2.setting}>
            <div>
              <strong>{SHORTCUT_LABELS[action]}</strong>
              <p>Raccourci global de l’application</p>
            </div>
            <div className={p2.settingControls}>
              <input
                value={shortcutDraft[action]}
                onChange={(event) =>
                  setShortcutDraft((current) => ({
                    ...current,
                    [action]: event.target.value,
                  }))
                }
                spellCheck={false}
                aria-label={`Raccourci ${SHORTCUT_LABELS[action]}`}
              />
              <button
                type="button"
                className={p2.ghost}
                onClick={() => {
                  setShortcutDraft((current) => ({
                    ...current,
                    [action]: DEFAULT_SHORTCUTS[action],
                  }))
                  setShortcutError(null)
                }}
              >
                Défaut
              </button>
            </div>
          </div>
        ))}
        <div className={p2.row} style={{ marginTop: 10 }}>
          <button
            type="button"
            className={p2.primary}
            onClick={() => {
              const normalized = {} as ShortcutMap
              for (const action of Object.keys(SHORTCUT_LABELS) as ShortcutAction[]) {
                const value = normalizeShortcut(shortcutDraft[action])
                if (!value) {
                  setShortcutError(
                    `Raccourci invalide pour « ${SHORTCUT_LABELS[action]} ».`,
                  )
                  return
                }
                normalized[action] = value
              }
              const conflicts = findConflicts(normalized)
              if (conflicts.length > 0) {
                setShortcutError(
                  `Conflit de raccourcis : ${conflicts
                    .map((action) => SHORTCUT_LABELS[action])
                    .join(', ')}.`,
                )
                return
              }
              setShortcutError(null)
              onShortcutsChange(normalized)
              setShortcutDraft(normalized)
              setNotice('Raccourcis enregistrés.')
            }}
          >
            Enregistrer les raccourcis
          </button>
          {shortcutError ? <span className={p2.errorText}>{shortcutError}</span> : null}
        </div>

        <section className={styles.profiles} aria-labelledby="profiles-title">
          <div className={styles.sectionHeader}>
            <h2 id="profiles-title">Profils</h2>
            <p>Enregistrez vos identités et vos préférences pour passer facilement d’un contexte à l’autre.</p>
          </div>

          <div className={styles.profileList}>
            {view?.profiles.map((profile) => {
              const activeProfile = profile.id === view.activeId
              return (
                <article key={profile.id} className={styles.profile} data-active={activeProfile} aria-label={`Profil ${profile.name}`}>
                  <div className={styles.profileHeading}>
                    <span className={styles.avatar} aria-hidden="true">{profile.name.slice(0, 1).toLocaleUpperCase()}</span>
                    <div className={styles.identity}>
                      <h3>{profile.name}</h3>
                      <p>{profile.userName} <span>· {profile.userEmail}</span></p>
                    </div>
                    {activeProfile ? <span className={styles.activeBadge}>Actif</span> : null}
                  </div>
                  <div className={styles.profileMeta}>
                    <span>Pull : {profile.defaultPull === 'ffOnly' ? 'Avance rapide uniquement' : profile.defaultPull === 'merge' ? 'Fusion' : 'Rebase'}</span>
                    <span>{profile.gitlabInstanceId ? 'Instance GitLab associée' : 'Sans instance GitLab'}</span>
                  </div>
                  <div className={styles.profileActions}>
                    <button type="button" className={p2.secondary} disabled={busy || activeProfile}
                      onClick={() => void run(`Profil ${profile.name} activé.`, () => profileSetActive(profile.id))}>
                      {activeProfile ? 'Profil actif' : 'Activer'}
                    </button>
                    <button type="button" className={p2.secondary} disabled={busy || !repoId}
                      title={repoId ? 'Utiliser cette identité Git pour le dépôt ouvert' : 'Ouvrez un dépôt pour appliquer cette identité'}
                      onClick={() => void run('Identité appliquée au dépôt.', async () => {
                        await profileApplyIdentity(profile.id, repoId ?? undefined)
                        onMutated()
                      })}>
                      Appliquer au dépôt
                    </button>
                    {profile.gitlabInstanceId ? (
                      <button type="button" className={p2.secondary} disabled={busy}
                        onClick={() => void run('Instance GitLab du profil activée.', () => profileGitlabActivate(profile.id))}>
                        Activer GitLab
                      </button>
                    ) : null}
                    <span className={styles.actionSpacer} />
                    <button type="button" className={p2.ghost} disabled={busy}
                      onClick={() => {
                        setEditing(profile.id)
                        setForm({ name: profile.name, userName: profile.userName, userEmail: profile.userEmail,
                          defaultPull: profile.defaultPull, gitlabInstanceId: profile.gitlabInstanceId ?? '' })
                        requestAnimationFrame(() => {
                          editorRef.current?.scrollIntoView({ block: 'nearest' })
                          nameRef.current?.focus({ preventScroll: true })
                        })
                      }}>
                      Modifier
                    </button>
                    <button type="button" className={p2.ghost} disabled={busy}
                      aria-label={`Supprimer le profil ${profile.name}`} onClick={() => setPendingDelete(profile)}>
                      Supprimer…
                    </button>
                  </div>
                </article>
              )
            })}
          </div>

          <form ref={editorRef} className={styles.editor} aria-labelledby="profile-editor-title"
            onSubmit={(event) => { event.preventDefault(); if (!busy) submit() }}>
            <div className={styles.editorHeader}>
              <h3 id="profile-editor-title">{editing ? 'Modifier le profil' : 'Créer un profil'}</h3>
              <p>{editing ? 'Ces réglages seront enregistrés dans ce profil.' : 'Donnez un nom à votre profil, puis renseignez l’identité de vos commits.'}</p>
            </div>
            <fieldset disabled={busy} className={styles.fields}>
              <legend className={styles.srOnly}>Informations du profil</legend>
              <label className={styles.field}>
                Nom du profil
                <input ref={nameRef} name="profileName" required value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex. Travail, Personnel" />
              </label>
              <div className={styles.fieldGroup}>
                <h4>Identité Git</h4>
                <p>Le nom et l’adresse e-mail qui signeront vos commits.</p>
                <div className={styles.fieldGrid}>
                  <label className={styles.field}>
                    Nom Git
                    <input name="gitName" required value={form.userName}
                      onChange={(event) => setForm({ ...form, userName: event.target.value })} placeholder="Prénom Nom" />
                  </label>
                  <label className={styles.field}>
                    Adresse e-mail Git
                    <input name="gitEmail" type="email" required value={form.userEmail}
                      onChange={(event) => setForm({ ...form, userEmail: event.target.value })} placeholder="vous@exemple.fr" spellCheck={false} />
                  </label>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <h4>Préférences</h4>
                <div className={styles.fieldGrid}>
                  <label className={styles.field}>
                    Comportement du pull
                    <select name="defaultPull" value={form.defaultPull}
                      onChange={(event) => setForm({ ...form, defaultPull: event.target.value })}>
                      <option value="rebase">Rebase</option>
                      <option value="merge">Fusion (merge)</option>
                      <option value="ffOnly">Avance rapide uniquement</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    Instance GitLab <span className={styles.optional}>Optionnelle</span>
                    <input name="gitlabInstance" value={form.gitlabInstanceId}
                      onChange={(event) => setForm({ ...form, gitlabInstanceId: event.target.value })}
                      placeholder="Aucune instance associée" spellCheck={false} aria-describedby="profile-gitlab-hint" />
                  </label>
                </div>
                {session?.instance && form.gitlabInstanceId !== session.instance.id ? (
                  <button type="button" className={`${p2.secondary} ${styles.instanceButton}`}
                    onClick={() => setForm({ ...form, gitlabInstanceId: session.instance!.id })}>
                    Utiliser l’instance connectée · {session.instance.displayName || session.instance.baseUrl}
                  </button>
                ) : null}
                <p id="profile-gitlab-hint">Laissez l’instance vide pour utiliser ce profil sans GitLab. Les jetons restent dans le trousseau du système.</p>
              </div>
            </fieldset>
            <div className={styles.editorFooter}>
              <span>Le profil ne modifie pas automatiquement l’identité du dépôt.</span>
              <div className={styles.footerActions}>
                {editing ? <button type="button" className={p2.secondary} disabled={busy} onClick={() => {
                  setEditing(null); setForm(EMPTY)
                }}>Annuler</button> : null}
                <button type="submit" className={p2.primary}
                  disabled={busy || !form.name.trim() || !form.userName.trim() || !form.userEmail.trim()}>
                  {busy ? 'Enregistrement…' : editing ? 'Enregistrer les modifications' : 'Créer le profil'}
                </button>
              </div>
            </div>
          </form>
        </section>

        {active ? (
          <p className={p2.notice} style={{ marginTop: 12 }}>
            Profil actif : {active.name}. L’identité affichée ci-dessus reste celle du
            dépôt tant que « Appliquer au dépôt » n’a pas été utilisé.
          </p>
        ) : null}
        {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
        {notice ? <p className={p2.notice} role="status">{notice}</p> : null}
      </div>

      <ConfirmDialog
        open={pendingInstall}
        title={`Installer BeeBranch ${available?.version ?? ''}`}
        consequence="Le paquet est téléchargé puis sa signature minisign est vérifiée. Un binaire non signé ou altéré est refusé. L'application redémarre automatiquement sur la nouvelle version. Un rollback signé reste disponible."
        confirmLabel="Télécharger et installer"
        busy={updateBusy}
        onCancel={() => setPendingInstall(false)}
        onConfirm={() => {
          setPendingInstall(false)
          setUpdateBusy(true)
          setError(null)
          void updateInstall()
            .then((result) => {
              setAvailable(null)
              setRestarting(result.restarting)
              setNotice(
                result.restarting
                  ? `Version ${result.installedVersion} installée. Redémarrage…`
                  : `Version ${result.installedVersion} installée.`,
              )
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setUpdateBusy(false))
        }}
      />
      <ConfirmDialog
        open={pendingRollback}
        title="Revenir à la version précédente"
        consequence="Le manifeste rollback.json est vérifié comme toute mise à jour. La version précédente doit être signée et encore publiée."
        confirmLabel="Télécharger et revenir"
        busy={updateBusy}
        onCancel={() => setPendingRollback(false)}
        onConfirm={() => {
          setPendingRollback(false)
          setUpdateBusy(true)
          setError(null)
          void updateRollback()
            .then((result) => {
              setRestarting(result.restarting)
              setNotice(
                result.restarting
                  ? `Version ${result.installedVersion} restaurée. Redémarrage…`
                  : `Version ${result.installedVersion} restaurée.`,
              )
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setUpdateBusy(false))
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Supprimer un profil"
        consequence={`Le profil ${pendingDelete?.name ?? ''} et ses préférences seront supprimés. L’instance GitLab et son token ne sont pas supprimés.`}
        confirmLabel="Supprimer"
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) {
            void run('Profil supprimé.', async () => {
              await profileDelete(target.id)
              if (editing === target.id) {
                setEditing(null)
                setForm(EMPTY)
              }
            })
          }
        }}
      />
    </div>
  )
}
