import { useCallback, useEffect, useRef, useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { LOCALES, LOCALE_NAMES, useI18n } from '../i18n'
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
import {
  DEFAULT_MEDIA_OPTIONS,
  MEDIA_EXTENSIONS,
  mediaLabel,
  type MediaFit,
  type MediaSettings,
} from '../lib/mediaSettings'
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
import { Markdown } from './Markdown'
import p2 from './p2.module.css'
import styles from './ProfilesPanel.module.css'

type Props = {
  repoId: string | null
  connected: boolean
  theme: 'dark' | 'light' | 'system'
  onThemeChange: (theme: 'dark' | 'light' | 'system') => void
  density: 'compact' | 'comfortable'
  onDensityChange: (density: 'compact' | 'comfortable') => void
  background: MediaSettings | null
  backgroundError: string | null
  onBackgroundChange: (next: MediaSettings | null) => void
  splash: MediaSettings | null
  splashError: string | null
  onSplashChange: (next: MediaSettings | null) => void
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

type ImageSettingProps = {
  /** Suffix used in aria labels, e.g. `du fond d’écran`. */
  label: string
  title: string
  description: string
  hint?: string
  emptyLabel: string
  clearLabel: string
  settings: MediaSettings | null
  error: string | null
  onPick: () => void
  onChange: (next: MediaSettings | null) => void
}

/** Wallpaper and boot splash share the same controls, so they share the rows. */
function ImageSetting({
  label,
  title,
  description,
  hint,
  emptyLabel,
  clearLabel,
  settings,
  error,
  onPick,
  onChange,
}: ImageSettingProps) {
  const { t } = useI18n()
  return (
    <>
      <div className={p2.setting}>
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
          {settings ? (
            <p className={p2.small} title={settings.path}>
              {mediaLabel(settings.path)}
            </p>
          ) : null}
          {hint ? <p className={p2.small}>{hint}</p> : null}
        </div>
        <div className={p2.settingControls}>
          <button type="button" className={p2.secondary} onClick={onPick}>
            {settings ? t('settings.media.change') : emptyLabel}
          </button>
          {settings ? (
            <button type="button" className={p2.ghost} onClick={() => onChange(null)}>
              {clearLabel}
            </button>
          ) : null}
        </div>
      </div>
      {settings ? (
        <>
          <div className={p2.setting}>
            <div>
              <strong>{t('settings.media.fit.title')}</strong>
              <p>{t('settings.media.fit.description')}</p>
            </div>
            <div className={p2.settingControls}>
              <select
                value={settings.fit}
                onChange={(event) =>
                  onChange({ ...settings, fit: event.target.value as MediaFit })
                }
                aria-label={t('settings.media.fit.aria', { suffix: label })}
              >
                <option value="cover">{t('settings.media.fit.cover')}</option>
                <option value="contain">{t('settings.media.fit.contain')}</option>
                <option value="tile">{t('settings.media.fit.tile')}</option>
              </select>
            </div>
          </div>
          <div className={p2.setting}>
            <div>
              <strong>{t('settings.media.dim.title')}</strong>
              <p>{t('settings.media.dim.description')}</p>
            </div>
            <div className={p2.settingControls}>
              <input
                type="range"
                min={0}
                max={90}
                step={5}
                value={settings.dim}
                onChange={(event) =>
                  onChange({ ...settings, dim: Number(event.target.value) })
                }
                aria-label={t('settings.media.dim.aria', { suffix: label })}
              />
              <span className={p2.mono}>{settings.dim} %</span>
            </div>
          </div>
          <div className={p2.setting}>
            <div>
              <strong>{t('settings.media.blur.title')}</strong>
              <p>{t('settings.media.blur.description')}</p>
            </div>
            <div className={p2.settingControls}>
              <input
                type="range"
                min={0}
                max={24}
                step={2}
                value={settings.blur}
                onChange={(event) =>
                  onChange({ ...settings, blur: Number(event.target.value) })
                }
                aria-label={t('settings.media.blur.aria', { suffix: label })}
              />
              <span className={p2.mono}>{settings.blur} px</span>
            </div>
          </div>
        </>
      ) : null}
      {error ? (
        <p className={p2.errorText} role="alert">
          {t('settings.media.unavailable', { title, error })}
        </p>
      ) : null}
    </>
  )
}


export function ProfilesPanel({
  repoId,
  connected,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  background,
  backgroundError,
  onBackgroundChange,
  splash,
  splashError,
  onSplashChange,
  onMutated,
  onOpenGitlab,
  shortcuts,
  onShortcutsChange,
}: Props) {
  const { t, locale, changeLocale } = useI18n()
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
    void run(editing ? t('settings.profiles.updated') : t('settings.profiles.created'), async () => {
      if (editing) {
        await profileUpdate(editing, input)
      } else {
        await profileCreate(input)
      }
      setForm(EMPTY)
      setEditing(null)
    })
  }

  // The backend reads the file, so the webview never touches the filesystem;
  // only the path and the presentation options are persisted.
  const pickImage = async (
    current: MediaSettings | null,
    apply: (next: MediaSettings) => void,
  ) => {
    const selected = await openNativeDialog({
      title: t('settings.media.dialog.title'),
      multiple: false,
      directory: false,
      filters: [{ name: t('settings.media.dialog.images'), extensions: MEDIA_EXTENSIONS }],
    })
    if (typeof selected !== 'string') {
      return
    }
    apply({ ...(current ?? DEFAULT_MEDIA_OPTIONS), path: selected })
  }

  return (
    <div className={p2.page}>
      <div className={p2.settingsGrid}>
        <h2 className={p2.cardTitle}>{t('settings.general.title')}</h2>
        <div className={p2.setting}>
          <div>
            <strong>{t('settings.appearance.title')}</strong>
            <p>{t('settings.appearance.theme.description')}</p>
          </div>
          <div className={p2.settingControls}>
            <select
              value={theme}
              onChange={(event) =>
                onThemeChange(event.target.value as 'dark' | 'light' | 'system')
              }
              aria-label={t('settings.appearance.theme.aria')}
            >
              <option value="dark">{t('settings.appearance.theme.dark')}</option>
              <option value="light">{t('settings.appearance.theme.light')}</option>
              <option value="system">{t('settings.appearance.theme.system')}</option>
            </select>
            <select
              value={density}
              onChange={(event) =>
                onDensityChange(event.target.value as 'compact' | 'comfortable')
              }
              aria-label={t('settings.appearance.density.aria')}
            >
              <option value="comfortable">{t('settings.appearance.density.comfortable')}</option>
              <option value="compact">{t('settings.appearance.density.compact')}</option>
            </select>
          </div>
        </div>
        <div className={p2.setting}>
          <div>
            <strong>{t('settings.language.title')}</strong>
            <p>{t('settings.language.description')}</p>
          </div>
          <div className={p2.settingControls}>
            <select
              value={locale}
              onChange={(event) => changeLocale(event.target.value as typeof locale)}
              aria-label={t('settings.language.aria')}
            >
              {LOCALES.map((value) => (
                <option key={value} value={value}>
                  {LOCALE_NAMES[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ImageSetting
          label={t('settings.media.wallpaper.suffix')}
          title={t('settings.media.wallpaper.title')}
          description={t('settings.media.wallpaper.description')}
          emptyLabel={t('settings.media.pick')}
          clearLabel={t('settings.media.clear')}
          settings={background}
          error={backgroundError}
          onPick={() => void pickImage(background, onBackgroundChange)}
          onChange={onBackgroundChange}
        />
        <ImageSetting
          label={t('settings.media.splash.suffix')}
          title={t('settings.media.splash.title')}
          description={t('settings.media.splash.description')}
          hint={t('settings.media.splash.hint')}
          emptyLabel={t('settings.media.pick')}
          clearLabel={t('settings.media.resetLogo')}
          settings={splash}
          error={splashError}
          onPick={() => void pickImage(splash, onSplashChange)}
          onChange={onSplashChange}
        />
        <div className={p2.setting}>
          <div>
            <strong>{t('settings.updates.title')}</strong>
            <p>
              {t('settings.updates.version', {
                version: update?.currentVersion ?? '—',
                platform: update?.platform ?? '',
              })}{' '}
              {update?.endpoint
                ? t('settings.updates.signedManifest')
                : t('settings.updates.noEndpoint')}{' '}
              {t('settings.updates.localOnly')}
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
                        ? t('settings.updates.available', { version: next.version })
                        : t('settings.updates.upToDate'),
                    )
                  })
                  .catch((cause) => setError(errorMessage(cause)))
                  .finally(() => setUpdateBusy(false))
              }}
            >
              {restarting
                ? t('settings.updates.restarting')
                : updateBusy
                  ? t('settings.updates.checking')
                  : t('settings.updates.check')}
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
                  {t('common.install')}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={p2.secondary}
              disabled={updateBusy || restarting || !update?.rollbackEndpoint}
              onClick={() => setPendingRollback(true)}
            >
              {t('settings.updates.rollback')}
            </button>
          </div>
        </div>
        {available?.notes ? (
          <section className={styles.notes} aria-label={t('settings.updates.notes')}>
            <strong>{t('settings.updates.notes')}</strong>
            <Markdown source={available.notes} />
          </section>
        ) : null}
        <div className={p2.setting}>
          <div>
            <strong>{t('settings.identity.title')}</strong>
            <p>{t('settings.identity.description')}</p>
          </div>
          <div className={p2.settingControls}>
            <span className={p2.mono}>
              {identity?.name ?? t('settings.identity.unset')}
              {identity?.email ? ` <${identity.email}>` : ''}
            </span>
          </div>
        </div>
        <div className={p2.setting}>
          <div>
            <strong>GitLab</strong>
            <p>
              {connected
                ? t('settings.gitlab.connected', {
                    instance: session?.instance?.baseUrl ?? t('settings.gitlab.instanceFallback'),
                    user: session?.user?.username ?? t('settings.gitlab.userFallback'),
                  })
                : t('settings.gitlab.none')}
            </p>
          </div>
          <div className={p2.settingControls}>
            <button type="button" className={p2.secondary} onClick={onOpenGitlab}>
              {connected ? t('settings.gitlab.manage') : t('settings.gitlab.configure')}
            </button>
          </div>
        </div>

        <h2 className={p2.sectionTitle}>{t('settings.shortcuts.title')}</h2>
        <p className={p2.notice}>
          {t('settings.shortcuts.notice')}
        </p>
        {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
          <div key={action} className={p2.setting}>
            <div>
              <strong>{t(SHORTCUT_LABELS[action])}</strong>
              <p>{t('settings.shortcuts.global')}</p>
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
                aria-label={t('settings.shortcuts.aria', { label: t(SHORTCUT_LABELS[action]) })}
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
                {t('settings.shortcuts.default')}
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
                    t('settings.shortcuts.invalid', { label: t(SHORTCUT_LABELS[action]) }),
                  )
                  return
                }
                normalized[action] = value
              }
              const conflicts = findConflicts(normalized)
              if (conflicts.length > 0) {
                setShortcutError(
                  t('settings.shortcuts.conflict', {
                    labels: conflicts
                      .map((action) => t(SHORTCUT_LABELS[action]))
                      .join(', '),
                  }),
                )
                return
              }
              setShortcutError(null)
              onShortcutsChange(normalized)
              setShortcutDraft(normalized)
              setNotice(t('settings.shortcuts.saved'))
            }}
          >
            {t('settings.shortcuts.save')}
          </button>
          {shortcutError ? <span className={p2.errorText}>{shortcutError}</span> : null}
        </div>

        <section className={styles.profiles} aria-labelledby="profiles-title">
          <div className={styles.sectionHeader}>
            <h2 id="profiles-title">{t('settings.profiles.title')}</h2>
            <p>{t('settings.profiles.description')}</p>
          </div>

          <div className={styles.profileList}>
            {view?.profiles.map((profile) => {
              const activeProfile = profile.id === view.activeId
              return (
                <article key={profile.id} className={styles.profile} data-active={activeProfile} aria-label={t('settings.profiles.itemAria', { name: profile.name })}>
                  <div className={styles.profileHeading}>
                    <span className={styles.avatar} aria-hidden="true">{profile.name.slice(0, 1).toLocaleUpperCase()}</span>
                    <div className={styles.identity}>
                      <h3>{profile.name}</h3>
                      <p>{profile.userName} <span>· {profile.userEmail}</span></p>
                    </div>
                    {activeProfile ? <span className={styles.activeBadge}>{t('settings.profiles.active')}</span> : null}
                  </div>
                  <div className={styles.profileMeta}>
                    <span>{t('settings.profiles.pull', {
                      mode:
                        profile.defaultPull === 'ffOnly'
                          ? t('settings.profiles.pull.ffOnly')
                          : profile.defaultPull === 'merge'
                            ? t('settings.profiles.pull.merge')
                            : t('settings.profiles.pull.rebase'),
                    })}</span>
                    <span>{profile.gitlabInstanceId ? t('settings.profiles.gitlabLinked') : t('settings.profiles.gitlabNone')}</span>
                  </div>
                  <div className={styles.profileActions}>
                    <button type="button" className={p2.secondary} disabled={busy || activeProfile}
                      onClick={() => void run(t('settings.profiles.activated', { name: profile.name }), () => profileSetActive(profile.id))}>
                      {activeProfile ? t('settings.profiles.current') : t('settings.profiles.activate')}
                    </button>
                    <button type="button" className={p2.secondary} disabled={busy || !repoId}
                      title={repoId ? t('settings.profiles.applyRepoTitle') : t('settings.profiles.applyRepoBlocked')}
                      onClick={() => void run(t('settings.profiles.identityApplied'), async () => {
                        await profileApplyIdentity(profile.id, repoId ?? undefined)
                        onMutated()
                      })}>
                      {t('settings.profiles.applyRepo')}
                    </button>
                    {profile.gitlabInstanceId ? (
                      <button type="button" className={p2.secondary} disabled={busy}
                        onClick={() => void run(t('settings.profiles.gitlabActivated'), () => profileGitlabActivate(profile.id))}>
                        {t('settings.profiles.activateGitlab')}
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
                      {t('common.edit')}
                    </button>
                    <button type="button" className={p2.ghost} disabled={busy}
                      aria-label={t('settings.profiles.deleteAria', { name: profile.name })} onClick={() => setPendingDelete(profile)}>
                      {t('settings.profiles.delete')}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>

          <form ref={editorRef} className={styles.editor} aria-labelledby="profile-editor-title"
            onSubmit={(event) => { event.preventDefault(); if (!busy) submit() }}>
            <div className={styles.editorHeader}>
              <h3 id="profile-editor-title">{editing ? t('settings.profiles.editTitle') : t('settings.profiles.createTitle')}</h3>
              <p>{editing ? t('settings.profiles.editDescription') : t('settings.profiles.createDescription')}</p>
            </div>
            <fieldset disabled={busy} className={styles.fields}>
              <legend className={styles.srOnly}>{t('settings.profiles.legend')}</legend>
              <label className={styles.field}>
                {t('settings.profiles.nameLabel')}
                <input ref={nameRef} name="profileName" required value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t('settings.profiles.namePlaceholder')} />
              </label>
              <div className={styles.fieldGroup}>
                <h4>{t('settings.profiles.identityTitle')}</h4>
                <p>{t('settings.profiles.identityDescription')}</p>
                <div className={styles.fieldGrid}>
                  <label className={styles.field}>
                    {t('settings.profiles.gitName')}
                    <input name="gitName" required value={form.userName}
                      onChange={(event) => setForm({ ...form, userName: event.target.value })} placeholder={t('settings.profiles.gitNamePlaceholder')} />
                  </label>
                  <label className={styles.field}>
                    {t('settings.profiles.gitEmail')}
                    <input name="gitEmail" type="email" required value={form.userEmail}
                      onChange={(event) => setForm({ ...form, userEmail: event.target.value })} placeholder={t('settings.profiles.gitEmailPlaceholder')} spellCheck={false} />
                  </label>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <h4>{t('settings.profiles.preferencesTitle')}</h4>
                <div className={styles.fieldGrid}>
                  <label className={styles.field}>
                    {t('settings.profiles.pullBehaviour')}
                    <select name="defaultPull" value={form.defaultPull}
                      onChange={(event) => setForm({ ...form, defaultPull: event.target.value })}>
                      <option value="rebase">Rebase</option>
                      <option value="merge">{t('settings.profiles.pull.mergeOption')}</option>
                      <option value="ffOnly">{t('settings.profiles.pull.ffOnly')}</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    {t('settings.profiles.gitlabInstance')} <span className={styles.optional}>{t('settings.profiles.gitlabOptional')}</span>
                    <input name="gitlabInstance" value={form.gitlabInstanceId}
                      onChange={(event) => setForm({ ...form, gitlabInstanceId: event.target.value })}
                      placeholder={t('settings.profiles.gitlabPlaceholder')} spellCheck={false} aria-describedby="profile-gitlab-hint" />
                  </label>
                </div>
                {session?.instance && form.gitlabInstanceId !== session.instance.id ? (
                  <button type="button" className={`${p2.secondary} ${styles.instanceButton}`}
                    onClick={() => setForm({ ...form, gitlabInstanceId: session.instance!.id })}>
                    {t('settings.profiles.useConnectedInstance', {
                      instance: session.instance.displayName || session.instance.baseUrl,
                    })}
                  </button>
                ) : null}
                <p id="profile-gitlab-hint">{t('settings.profiles.gitlabHint')}</p>
              </div>
            </fieldset>
            <div className={styles.editorFooter}>
              <span>{t('settings.profiles.repoNote')}</span>
              <div className={styles.footerActions}>
                {editing ? <button type="button" className={p2.secondary} disabled={busy} onClick={() => {
                  setEditing(null); setForm(EMPTY)
                }}>{t('common.cancel')}</button> : null}
                <button type="submit" className={p2.primary}
                  disabled={busy || !form.name.trim() || !form.userName.trim() || !form.userEmail.trim()}>
                  {busy ? t('settings.profiles.saving') : editing ? t('settings.profiles.saveChanges') : t('settings.profiles.create')}
                </button>
              </div>
            </div>
          </form>
        </section>

        {active ? (
          <p className={p2.notice} style={{ marginTop: 12 }}>
            {t('settings.profiles.activeNotice', { name: active.name })}
          </p>
        ) : null}
        {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
        {notice ? <p className={p2.notice} role="status">{notice}</p> : null}
      </div>

      <ConfirmDialog
        open={pendingInstall}
        title={t('settings.updates.installTitle', { version: available?.version ?? '' })}
        consequence={t('settings.updates.installConsequence')}
        confirmLabel={t('settings.updates.downloadInstall')}
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
                  ? t('settings.updates.installedRestarting', { version: result.installedVersion })
                  : t('settings.updates.installed', { version: result.installedVersion }),
              )
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setUpdateBusy(false))
        }}
      />
      <ConfirmDialog
        open={pendingRollback}
        title={t('settings.updates.rollbackTitle')}
        consequence={t('settings.updates.rollbackConsequence')}
        confirmLabel={t('settings.updates.downloadRollback')}
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
                  ? t('settings.updates.restoredRestarting', { version: result.installedVersion })
                  : t('settings.updates.restored', { version: result.installedVersion }),
              )
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setUpdateBusy(false))
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('settings.profiles.deleteTitle')}
        consequence={t('settings.profiles.deleteConsequence', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) {
            void run(t('settings.profiles.deleted'), async () => {
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
