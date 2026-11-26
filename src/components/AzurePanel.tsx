import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  azureConfigure,
  azureConnectFromGit,
  azureDisconnect,
  azureProjectsPage,
  azureRepoLink,
  azureRepoLinkGet,
  azureRepoLinkManual,
  azureStatus,
  branchCheckout,
  openExternalUrl,
} from '../ipc/commands'
import { presentError, type PresentedError } from '../ipc/client'
import { ErrorNotice } from './ui/ErrorNotice'
import { formatDate, useI18n } from '../i18n'
import { azureForge, tokenCreateUrl, type ForgeNotice } from '../lib/forge'
import { groupProjects } from '../lib/forgeProjects'
import type { GitlabProject, GitlabSession } from '../types/git'
import { ReviewRequestsPanel } from './ReviewRequestsPanel'
import { ForgeHubHeader, type ForgeHubTab } from './ForgeHubHeader'
import { useCheckoutConfirm } from './OperationConfirm'
import styles from './GitlabPanel.module.css'

type Props = {
  repoId?: string | null
  generation?: number
  onLinked?: () => void
  hubTab?: ForgeHubTab
  onHubTab?: (tab: ForgeHubTab) => void
  grouped?: boolean
  onGrouped?: (grouped: boolean) => void
  collapsedGroups?: ReadonlySet<string>
  onToggleGroup?: (key: string) => void
}

export function AzurePanel({
  repoId = null,
  generation = 0,
  onLinked,
  hubTab: hubTabProp,
  onHubTab,
  grouped = false,
  onGrouped,
  collapsedGroups,
  onToggleGroup,
}: Props) {
  const { t } = useI18n()
  const confirmCheckout = useCheckoutConfirm()
  const [session, setSession] = useState<GitlabSession | null>(null)
  const [projects, setProjects] = useState<GitlabProject[]>([])
  const [nextPage, setNextPage] = useState<number | undefined>()
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [caPem, setCaPem] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PresentedError | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<ForgeNotice>(null)
  const [editing, setEditing] = useState(false)
  const [linkedId, setLinkedId] = useState<number | null>(null)
  const [ownHubTab, setOwnHubTab] = useState<ForgeHubTab>('projects')
  const hubTab = hubTabProp ?? ownHubTab
  const setHubTab = (tab: ForgeHubTab) => {
    onHubTab?.(tab)
    setOwnHubTab(tab)
  }
  const activeTab = hubTab

  const loadProjects = useCallback(async (page = 1, searchValue = '', append = false) => {
    try {
      const result = await azureProjectsPage({
        page,
        search: searchValue.trim() || undefined,
        perPage: 50,
      })
      setProjects((current) => (append ? [...current, ...result.items] : result.items))
      setNextPage(result.nextPage)
      setNotice(result.fromCache ? { key: 'forge.connect.notice.cached' } : null)
    } catch (cause) {
      setError(presentError(cause))
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('azure://auth-expired', () => {
      void azureStatus()
        .then((value) => {
          setSession(value)
          setEditing(!value.connected)
        })
        .catch(() => undefined)
    }).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!repoId) {
      setLinkedId(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const existing = await azureRepoLinkGet(repoId)
        if (cancelled) return
        if (existing) {
          setLinkedId(existing.projectId)
          return
        }
        const discovered = await azureRepoLink(repoId)
        if (!cancelled) setLinkedId(discovered.projectId)
      } catch {
        if (!cancelled) setLinkedId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoId])

  useEffect(() => {
    let cancelled = false
    void azureStatus()
      .then((value) => {
        if (cancelled) return
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
        if (!cancelled) setError(presentError(cause))
      })
    return () => {
      cancelled = true
    }
  }, [loadProjects])

  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [error])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const connected = await azureConfigure({
        baseUrl,
        token,
        displayName: displayName || undefined,
        caPem: caPem.trim() || undefined,
      })
      setSession(connected)
      setHubTab('projects')
      onLinked?.()
      setToken('')
      setEditing(false)
      setNotice({ key: 'forge.connect.notice.validated' })
      await loadProjects()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setBusy(false)
    }
  }

  const connectFromGit = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const connected = await azureConnectFromGit({
        baseUrl,
        displayName: displayName || undefined,
      })
      setSession(connected)
      setHubTab('projects')
      onLinked?.()
      setEditing(false)
      setNotice({
        key: 'forge.connect.notice.fromGit',
        params: { source: connected.credentialSource ?? '' },
      })
      await loadProjects()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await azureDisconnect()
      setSession({ connected: false })
      setProjects([])
      setToken('')
      setEditing(true)
      setNotice({ key: 'forge.connect.notice.disconnected' })
      onLinked?.()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root} data-forge="azure">
      <ForgeHubHeader
        provider="azure"
        session={session}
        active={activeTab}
        count={projects.length}
        onSelect={setHubTab}
      />
      <div className={styles.top} hidden={activeTab === 'reviews'}>
        <section
          className={styles.connection}
          role="tabpanel"
          id="azure-panel-connection"
          aria-labelledby="azure-tab-connection"
          hidden={activeTab !== 'connection'}
        >
          <header className={styles.header}>
            <div>
              <p className={styles.lead}>{t('forge.connect.azure.description')}</p>
            </div>
          </header>
          {error ? (
            <div className={styles.forgeError} ref={errorRef}>
              <ErrorNotice error={error} />
            </div>
          ) : null}
          {session?.connected && !editing ? (
            <div className={styles.identity}>
              <span className={styles.badge}>{t('forge.connect.badge.connected')}</span>
              {session.credentialSource && session.credentialSource !== 'keychain' ? (
                <span className={styles.badge}>{t('forge.connect.badge.viaGit')}</span>
              ) : null}
              <strong>{session.user?.name ?? t('forge.connect.azure.connectedName')}</strong>
              {session.user ? <code>@{session.user.username}</code> : null}
              <span>{session.instance?.baseUrl ?? t('forge.connect.instanceActive')}</span>
              <span className={styles.identityActions}>
                <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                  {t('forge.connect.changeInstance')}
                </button>
                <button type="button" onClick={() => void disconnect()} disabled={busy}>
                  {t('forge.connect.disconnect')}
                </button>
              </span>
            </div>
          ) : (
            <form className={styles.form} onSubmit={submit}>
              {session?.connected ? (
                <p className={styles.notice}>{t('forge.connect.alreadyConnected')}</p>
              ) : null}
              <label>
                {t('forge.connect.urlLabel')}
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={t('forge.connect.urlPlaceholderAzure')}
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
                  required={!session?.connected}
                />
              </label>
              <p className={styles.tokenHelp}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => void openExternalUrl(tokenCreateUrl('azure', baseUrl))}
                >
                  {t('forge.connect.createToken')}
                </button>
              </p>
              <label>
                {t('forge.connect.displayNameLabel')}
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t('forge.connect.displayNamePlaceholderAzure')}
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
          )}
          {session?.connected && !editing && session.credentialSource && session.credentialSource !== 'keychain' ? (
            <p className={styles.notice}>
              {t('forge.connect.tokenFromGit', { source: session.credentialSource })}
            </p>
          ) : null}
          {notice ? <p className={styles.notice}>{t(notice.key, notice.params)}</p> : null}
        </section>

        {session?.connected ? (
          <section
            className={styles.projects}
            role="tabpanel"
            id="azure-panel-projects"
            aria-labelledby="azure-tab-projects"
            hidden={activeTab !== 'projects'}
          >
            <header className={styles.projectsHeader}>
              <div className={styles.projectsIntro}>
                <h3>{t('forge.projects.azure.title')}</h3>
                <label className={styles.groupToggle}>
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={(event) => onGrouped?.(event.target.checked)}
                  />
                  {t('forge.projects.groupByAzure')}
                </label>
              </div>
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
                  placeholder={t('forge.projects.searchPlaceholderAzure')}
                  aria-label={t('forge.projects.searchAriaAzure')}
                />
                <button type="submit">{t('forge.projects.searchSubmit')}</button>
              </form>
            </header>
            <div className={styles.list}>
              {projects.length === 0 ? <p className={styles.empty}>{t('forge.projects.emptyAzure')}</p> : null}
              {(grouped ? groupProjects(projects) : [{ key: '', items: projects }]).map((group) => (
                <div key={group.key || 'all'}>
                  {grouped ? (
                    <button
                      type="button"
                      className={styles.groupHeading}
                      aria-expanded={!collapsedGroups?.has(group.key)}
                      aria-label={t('forge.projects.groupAria', {
                        name: group.key || t('forge.projects.ungroupedAzure'),
                        count: group.items.length,
                      })}
                      onClick={() => onToggleGroup?.(group.key)}
                    >
                      <span className={styles.chevron} aria-hidden="true">›</span>
                      <span>{group.key || t('forge.projects.ungroupedAzure')}</span>
                      <span className={styles.groupCount}>{group.items.length}</span>
                    </button>
                  ) : null}
                  {grouped && collapsedGroups?.has(group.key)
                    ? null
                    : group.items.map((project) => (
                        <article key={project.id} className={styles.project}>
                          <div>
                            <strong>{project.name}</strong>
                            <code>{project.pathWithNamespace}</code>
                          </div>
                          <div className={styles.projectMeta}>
                            <span>{project.defaultBranch ?? t('forge.projects.defaultBranchUnknown')}</span>
                            {project.lastActivityAt ? <span>{formatDate(new Date(project.lastActivityAt))}</span> : null}
                            <span className={styles.url}>{project.webUrl}</span>
                          </div>
                          {repoId ? (
                            <button
                              type="button"
                              className={styles.more}
                              disabled={linkedId === project.id}
                              title={t('forge.projects.linkTitle')}
                              onClick={() => {
                                setError(null)
                                void azureRepoLinkManual(repoId, project.id)
                                  .then((link) => {
                                    setNotice({
                                      key: 'forge.projects.linked',
                                      params: { path: link.pathWithNamespace, id: link.projectId },
                                    })
                                    onLinked?.()
                                    setLinkedId(project.id)
                                  })
                                  .catch((cause: unknown) => setError(presentError(cause)))
                              }}
                            >
                              {linkedId === project.id
                                ? t('forge.projects.linkCurrent')
                                : t('forge.projects.link')}
                            </button>
                          ) : null}
                        </article>
                      ))}
                </div>
              ))}
            </div>
            {nextPage ? (
              <button type="button" className={styles.more} onClick={() => void loadProjects(nextPage, search, true)}>
                {t('forge.projects.nextPage', { page: nextPage })}
              </button>
            ) : null}
          </section>
        ) : activeTab === 'projects' ? (
          <section className={styles.projects} role="tabpanel" id="azure-panel-projects" aria-labelledby="azure-tab-projects">
            <p className={styles.empty}>{t('forge.hub.connectHint')}</p>
          </section>
        ) : null}
      </div>
      {session?.connected ? (
        <div className={styles.reviews} role="tabpanel" id="azure-panel-reviews" aria-labelledby="azure-tab-reviews" hidden={activeTab !== 'reviews'}>
          <ReviewRequestsPanel
            api={azureForge}
            repoId={repoId}
            generation={generation}
            connected={session.connected}
            onCheckout={(branch) => {
              if (!repoId) return
              void confirmCheckout(repoId, {
                title: t('workbench.operationPreview.title.checkout', { target: branch }),
                confirmLabel: t('workbench.operationPreview.action.checkout'),
                operation: { kind: 'checkout', name: branch },
              }).then((confirmed) => {
                if (confirmed) void branchCheckout({ repoId, name: branch })
              })
            }}
          />
        </div>
      ) : activeTab === 'reviews' ? (
        <div className={styles.reviews} role="tabpanel" id="azure-panel-reviews" aria-labelledby="azure-tab-reviews">
          <p className={styles.empty}>{t('forge.hub.connectHint')}</p>
        </div>
      ) : null}
    </div>
  )
}
