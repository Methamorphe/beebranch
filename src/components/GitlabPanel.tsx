import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  gitlabConfigure,
  gitlabConnectFromGit,
  gitlabDeviceFlowCancel,
  gitlabDeviceFlowPoll,
  gitlabDeviceFlowStart,
  gitlabDisconnect,
  gitlabProjectsPage,
  gitlabRepoLinkManual,
  gitlabStatus,
  branchCheckout,
  openExternalUrl,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import {
  formatDate,
  useI18n,
} from '../i18n'
import type { GitlabProject, GitlabSession } from '../types/git'
import { gitlabForge, tokenCreateUrl, type ForgeNotice } from '../lib/forge'
import { ReviewRequestsPanel } from './ReviewRequestsPanel'
import { ForgeHubHeader, type ForgeHubTab } from './ForgeHubHeader'
import styles from './GitlabPanel.module.css'

type Props = {
  repoId?: string | null
  generation?: number
  onLinked?: () => void
}

/**
 * Render a translated sentence whose `{placeholder}` parts carry markup
 * (monospaced scope names) instead of plain text.
 */
export function RichMessage({
  template,
  parts,
}: {
  template: string
  parts: Record<string, ReactNode>
}) {
  return (
    <>
      {template.split(/(\{\w+\})/g).map((chunk, index) => {
        const name = /^\{(\w+)\}$/.exec(chunk)?.[1]
        return (
          <Fragment key={index}>{name ? (parts[name] ?? chunk) : chunk}</Fragment>
        )
      })}
    </>
  )
}

export function GitlabPanel({ repoId = null, generation = 0, onLinked }: Props) {
  const { t } = useI18n()
  const [session, setSession] = useState<GitlabSession | null>(null)
  const [projects, setProjects] = useState<GitlabProject[]>([])
  const [nextPage, setNextPage] = useState<number | undefined>()
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [caPem, setCaPem] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<ForgeNotice>(null)
  const [editing, setEditing] = useState(false)
  const [hubTab, setHubTab] = useState<ForgeHubTab>('reviews')
  const [device, setDevice] = useState<{
    userCode: string
    verificationUri: string
  } | null>(null)
  const pollTimer = useRef<number | null>(null)

  const clearPoll = () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }

  const loadProjects = useCallback(
    async (page = 1, searchValue = '', append = false) => {
      try {
        const result = await gitlabProjectsPage({
          page,
          search: searchValue.trim() || undefined,
          perPage: 50,
        })
        setProjects((current) =>
          append ? [...current, ...result.items] : result.items,
        )
        setNextPage(result.nextPage)
        setNotice(
          result.fromCache ? { key: 'forge.connect.notice.cached' } : null,
        )
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current)
      }
      void gitlabDeviceFlowCancel().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('gitlab://auth-expired', () => {
      void gitlabStatus()
        .then((value) => {
          setSession(value)
          setEditing(false)
        })
        .catch(() => undefined)
    }).then((off) => {
      if (disposed) {
        off()
      } else {
        unlisten = off
      }
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void gitlabStatus()
      .then((value) => {
        if (cancelled) {
          return
        }
        setSession(value)
        if (value.instance) {
          setBaseUrl(value.instance.baseUrl)
          setDisplayName(value.instance.displayName ?? '')
        }
        if (value.connected) {
          setEditing(false)
          void loadProjects()
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadProjects])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const connected = await gitlabConfigure({
        baseUrl,
        token,
        displayName: displayName || undefined,
        caPem: caPem.trim() || undefined,
      })
      setSession(connected)
      setHubTab('reviews')
      onLinked?.()
      setToken('')
      setEditing(false)
      setNotice({ key: 'forge.connect.notice.validated' })
      await loadProjects()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const connectFromGit = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const connected = await gitlabConnectFromGit({
        baseUrl,
        displayName: displayName || undefined,
      })
      setSession(connected)
      setHubTab('reviews')
      onLinked?.()
      setEditing(false)
      setNotice(
        connected.credentialSource
          ? {
              key: 'forge.connect.notice.fromGit',
              params: { source: connected.credentialSource },
            }
          : { key: 'forge.connect.notice.fromGitFallback' },
      )
      await loadProjects()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function pollDeviceFlow(interval: number) {
    try {
      const result = await gitlabDeviceFlowPoll()
      if (result.status === 'connected' && result.session) {
        clearPoll()
        setDevice(null)
        setSession(result.session)
        setHubTab('reviews')
        onLinked?.()
        setEditing(false)
        setNotice({ key: 'forge.connect.notice.oauthGitlab' })
        await loadProjects()
        return
      }
      scheduleDevicePoll(result.interval ?? interval)
    } catch (cause) {
      clearPoll()
      setDevice(null)
      setError(errorMessage(cause))
    }
  }

  function scheduleDevicePoll(seconds: number) {
    clearPoll()
    pollTimer.current = window.setTimeout(
      () => void pollDeviceFlow(seconds),
      Math.max(1, seconds) * 1000,
    )
  }

  const startDeviceFlow = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const started = await gitlabDeviceFlowStart({
        baseUrl: baseUrl.trim() || undefined,
        displayName: displayName || undefined,
      })
      setDevice({
        userCode: started.userCode,
        verificationUri: started.verificationUri,
      })
      void openExternalUrl(started.verificationUri)
      scheduleDevicePoll(started.interval)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancelDeviceFlow = async () => {
    clearPoll()
    setDevice(null)
    await gitlabDeviceFlowCancel().catch((cause: unknown) =>
      setError(errorMessage(cause)),
    )
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await gitlabDisconnect()
      setSession({ connected: false })
      onLinked?.()
      setEditing(false)
      setProjects([])
      setNextPage(undefined)
      setNotice({ key: 'forge.connect.notice.disconnected' })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const activeTab = session?.connected ? hubTab : 'connection'
  const supportsDeviceFlow = !baseUrl.trim() || /^https:\/\/gitlab\.com(\/|$)/i.test(baseUrl.trim())

  return (
    <div className={styles.root} data-forge="gitlab">
      <ForgeHubHeader provider="gitlab" session={session} active={activeTab} count={projects.length} onSelect={setHubTab} />
      <div className={styles.top} hidden={activeTab === 'reviews'}>
      <section className={styles.connection} role="tabpanel" id="gitlab-panel-connection" aria-labelledby="gitlab-tab-connection" hidden={activeTab !== 'connection'}>
        <header className={styles.header}>
          <h2>{t('forge.hub.connection')}</h2>
          <details className={styles.connectionGuide}><summary>{t('forge.hub.connectionGuide')}</summary>
          <p>
            <RichMessage
              template={t('forge.connect.gitlab.description')}
              parts={{
                api: <code>api</code>,
                readUser: <code>read_user</code>,
                readRepository: <code>read_repository</code>,
                gitCredentialFill: <code>git credential fill</code>,
                gitCredentials: <code>~/.git-credentials</code>,
              }}
            />
          </p>
        </details>
        </header>

        {session?.connected === false && !device && supportsDeviceFlow ? <div className={styles.connectPrompt}>
          <h3>{t('forge.hub.connectTitle', { provider: 'GitLab' })}</h3>
          <p>{t('forge.hub.connectHint')}</p>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void startDeviceFlow()}>
            {t('forge.connect.gitlab.deviceButton')}
          </button>
        </div> : null}
        {session && !session.connected && session.instance ? (
          <p className={styles.missingToken}>
            {t('forge.connect.missingToken', { url: session.instance.baseUrl })}
          </p>
        ) : null}

        {session === null && !error ? <p className={styles.empty} role="status">{t('common.loading')}</p> : session?.connected && !editing ? (
          <div className={styles.identity}>
            <span className={styles.badge}>{t('forge.connect.badge.connected')}</span>
            {session.credentialSource && session.credentialSource !== 'keychain' ? (
              <span className={styles.badge}>{t('forge.connect.badge.viaGit')}</span>
            ) : null}
            <strong>
              {session.user?.name ?? t('forge.connect.gitlab.connectedName')}
            </strong>
            {session.user ? <code>@{session.user.username}</code> : null}
            <span>{session.instance?.baseUrl ?? t('forge.connect.instanceActive')}</span>
            <span className={styles.identityActions}>
              <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                {t('forge.connect.changeInstance')}
              </button>
              {session.credentialSource && session.credentialSource !== 'keychain' ? null : (
                <button type="button" onClick={() => void disconnect()} disabled={busy}>
                  {t('forge.connect.disconnect')}
                </button>
              )}
            </span>
          </div>
        ) : device ? (
          <div className={styles.deviceFlow}>
            <p>
              <RichMessage
                template={t('forge.connect.gitlab.devicePrompt')}
                parts={{
                  url: (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => void openExternalUrl(device.verificationUri)}
                    >
                      {device.verificationUri.replace(/^https?:\/\//, '')}
                    </button>
                  ),
                }}
              />
            </p>
            <code className={styles.userCode}>{device.userCode}</code>
            <p className={styles.deviceWait}>
              {t('forge.connect.gitlab.deviceWaiting')}
            </p>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void cancelDeviceFlow()}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <details className={styles.advanced} open={editing || !supportsDeviceFlow}>
              <summary>{t('forge.hub.manualConnection')}</summary>
            <form className={styles.form} onSubmit={submit}>
            {session?.connected ? (
              <p className={styles.notice}>
                {t('forge.connect.alreadyConnected')}
              </p>
            ) : null}
            <label>
              {t('forge.connect.urlLabel')}
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gitlab.example.com"
                required
              />
            </label>
            <label>
              {t('forge.connect.tokenLabel')}
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <p className={styles.tokenHelp}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() =>
                  void openExternalUrl(tokenCreateUrl('gitlab', baseUrl))
                }
              >
                {t('forge.connect.createToken')}
              </button>
            </p>
            <label>
              {t('forge.connect.displayNameLabel')}
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('forge.connect.displayNamePlaceholderGitlab')}
              />
            </label>
            <label className={styles.ca}>
              {t('forge.connect.caLabel')}
              <textarea
                value={caPem}
                onChange={(event) => setCaPem(event.target.value)}
                rows={3}
                placeholder="-----BEGIN CERTIFICATE-----"
                spellCheck={false}
              />
            </label>
            <span className={styles.formActions}>
              <button type="submit" className={styles.primary} disabled={busy}>
                {busy ? t('forge.connect.validating') : t('forge.connect.submit')}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void connectFromGit()}
                disabled={busy || baseUrl.trim() === ''}
              >
                {t('forge.connect.useGitCredentials')}
              </button>

              {session?.connected ? (
                <button type="button" onClick={() => setEditing(false)} disabled={busy}>
                  {t('common.cancel')}
                </button>
              ) : null}
            </span>
          </form>
            </details>
        )}

        {session?.connected &&
        !editing &&
        session.credentialSource &&
        session.credentialSource !== 'keychain' ? (
          <p className={styles.notice}>
            {t('forge.connect.tokenFromGit', { source: session.credentialSource })}
          </p>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.notice}>{t(notice.key, notice.params)}</p>
        ) : null}
      </section>

      {session?.connected ? (
        <section className={styles.projects} role="tabpanel" id="gitlab-panel-projects" aria-labelledby="gitlab-tab-projects" hidden={activeTab !== 'projects'}>
          <header className={styles.projectsHeader}>
            <h3>{t('forge.projects.gitlab.title')}</h3>
            <form
              className={styles.search}
              onSubmit={(event) => {
                event.preventDefault()
                setError(null)
                void loadProjects(1, search)
              }}
            >
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('forge.projects.searchPlaceholderGitlab')}
                aria-label={t('forge.projects.searchAriaGitlab')}
              />
              <button type="submit">{t('forge.projects.searchSubmit')}</button>
            </form>
          </header>

          <div className={styles.list}>
            {projects.length === 0 ? (
              <p className={styles.empty}>{t('forge.projects.emptyGitlab')}</p>
            ) : null}
            {projects.map((project) => (
              <article key={project.id} className={styles.project}>
                <div>
                  <strong>{project.name}</strong>
                  <code>{project.pathWithNamespace}</code>
                </div>
                <div className={styles.projectMeta}>
                  <span>
                    {project.defaultBranch ?? t('forge.projects.defaultBranchUnknown')}
                  </span>
                  {project.lastActivityAt ? (
                    <span>{formatDate(new Date(project.lastActivityAt))}</span>
                  ) : null}
                  <span className={styles.url}>{project.webUrl}</span>
                </div>
                {repoId ? (
                  <button
                    type="button"
                    className={styles.more}
                    onClick={() => {
                      setError(null)
                      setNotice(null)
                      void gitlabRepoLinkManual(repoId, project.id)
                        .then((link) => {
                          setNotice({
                            key: 'forge.projects.linked',
                            params: {
                              path: link.pathWithNamespace,
                              id: link.projectId,
                            },
                          })
                          onLinked?.()
                          setHubTab('reviews')
                        })
                        .catch((cause: unknown) => setError(errorMessage(cause)))
                    }}
                  >
                    {t('forge.projects.link')}
                  </button>
                ) : null}
              </article>
            ))}
          </div>

          {nextPage ? (
            <button
              type="button"
              className={styles.more}
              onClick={() => void loadProjects(nextPage, search, true)}
            >
              {t('forge.projects.nextPage', { page: nextPage })}
            </button>
          ) : null}
        </section>
      ) : null}
      </div>
      {session?.connected ? (
        <div className={styles.reviews} role="tabpanel" id="gitlab-panel-reviews" aria-labelledby="gitlab-tab-reviews" hidden={activeTab !== 'reviews'}>
        <ReviewRequestsPanel
          api={gitlabForge}
          repoId={repoId}
          generation={generation}
          connected={session.connected}
          onCheckout={(branch) => {
            if (repoId) {
              void branchCheckout({ repoId, name: branch })
            }
          }}
        />
        </div>
      ) : null}
    </div>
  )
}
