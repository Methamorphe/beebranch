import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ViewId } from '../data/navigation'
import type { GitlabProject, GitlabSession, RecentRepo } from '../types/git'
import {
  githubProjectsPage,
  githubStatus,
  gitlabProjectsPage,
  gitlabStatus,
} from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import { formatNumber, useI18n } from '../i18n'
import styles from './Home.module.css'

type CloneInput = {
  url: string
  destination: string
  branch?: string
  depth?: number
  recurseSubmodules?: boolean
}

type Props = {
  onSelect: (view: ViewId) => void
  recent: RecentRepo[]
  /** Changes whenever a new-tab request must refocus the recent search. */
  focusRequest?: number
  onOpen: (path: string) => void
  onOpenDialog: () => void
  onClone: (input: CloneInput) => Promise<void>
  onCreate?: () => void
  onPickDirectory?: (defaultPath?: string) => Promise<string | null>
}

function projectUrl(
  project: GitlabProject,
  protocol: 'ssh' | 'https' = 'ssh',
): string {
  if (protocol === 'ssh') {
    return project.sshUrlToRepo || project.httpUrlToRepo || ''
  }
  return project.httpUrlToRepo || project.sshUrlToRepo || ''
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index > 0 ? trimmed.slice(0, index) : null
}

function repoNameFromUrl(url: string) {
  const trimmed = url.trim().replace(/[\\/]+$/, '')
  if (!trimmed) {
    return ''
  }
  const path = trimmed.includes('://')
    ? trimmed.replace(/^[a-z]+:\/\//i, '').replace(/^[^/]+\//, '')
    : trimmed.includes('@') && trimmed.includes(':')
      ? trimmed.slice(trimmed.indexOf(':') + 1)
      : trimmed
  const segments = path.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  return last.endsWith('.git') ? last.slice(0, -4) : last
}

function suggestedDestination(
  project: GitlabProject,
  recent: RecentRepo[],
): string | null {
  const reference = recent[0]?.path
  if (!reference) {
    return null
  }
  const parent = reference.replace(/\/[^/]+\/?$/, '')
  if (!parent || parent === reference) {
    return null
  }
  return `${parent}/${project.pathWithNamespace.split('/').pop() ?? project.name}`
}

export function Home({
  onSelect,
  recent,
  focusRequest = 0,
  onOpen,
  onOpenDialog,
  onClone,
  onCreate,
  onPickDirectory,
}: Props) {
  const { t, plural } = useI18n()
  const [mode, setMode] = useState<'idle' | 'clone'>('idle')
  const [recentQuery, setRecentQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const lastFocusRequest = useRef(focusRequest)
  const [provider, setProvider] = useState<'gitlab' | 'github'>('gitlab')
  const [session, setSession] = useState<GitlabSession | null>(null)
  const [githubSession, setGithubSession] = useState<GitlabSession | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [projects, setProjects] = useState<GitlabProject[]>([])
  const [projectSearch, setProjectSearch] = useState('')
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<GitlabProject | null>(null)
  const [protocol, setProtocol] = useState<'ssh' | 'https'>('https')
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [destination, setDestination] = useState('')
  const [branch, setBranch] = useState('')
  const [depth, setDepth] = useState('')
  const [recurse, setRecurse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A new tab lands here ready to search: focus the recent-repos field, and
  // start from a clean query when the tab is opened again. The field only
  // exists once recents are loaded, so the effect must also run on that edge.
  const hasRecent = recent.length > 0
  useEffect(() => {
    if (focusRequest !== lastFocusRequest.current) {
      lastFocusRequest.current = focusRequest
      setRecentQuery('')
    }
    if (hasRecent) {
      searchInput.current?.focus()
    }
  }, [focusRequest, hasRecent])

  const recentFilter = recentQuery.trim().toLowerCase()
  const filteredRecent = recentFilter
    ? recent.filter((entry) => {
        const name = (entry.name ?? entry.path.split('/').pop() ?? '').toLowerCase()
        return (
          name.includes(recentFilter) || entry.path.toLowerCase().includes(recentFilter)
        )
      })
    : recent

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [gitlab, github] = await Promise.allSettled([gitlabStatus(), githubStatus()])
      if (cancelled) {
        return
      }
      const gitlabSession = gitlab.status === 'fulfilled' ? gitlab.value : null
      const githubSessionValue = github.status === 'fulfilled' ? github.value : null
      setSession(gitlabSession)
      setGithubSession(githubSessionValue)
      setManual(!(gitlabSession?.connected || githubSessionValue?.connected))
      if (!gitlabSession?.connected && githubSessionValue?.connected) {
        setProvider('github')
      }
      if (gitlab.status === 'rejected') {
        setSessionError(errorMessage(gitlab.reason))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const activeSession = provider === 'github' ? githubSession : session
  const anyConnected = Boolean(session?.connected || githubSession?.connected)
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab'

  useEffect(() => {
    if (mode !== 'clone' || !activeSession?.connected) {
      return
    }
    let cancelled = false
    const fetchProjects = provider === 'github' ? githubProjectsPage : gitlabProjectsPage
    const timer = window.setTimeout(() => {
      setProjectLoading(true)
      setProjectError(null)
      void fetchProjects({
        search: projectSearch.trim() || undefined,
        perPage: 50,
      })
        .then((page) => {
          if (!cancelled) {
            setProjects(page.items)
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setProjectError(errorMessage(cause))
          }
        })
        .finally(() => {
          if (!cancelled) {
            setProjectLoading(false)
          }
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mode, provider, activeSession, projectSearch])

  const selectProject = (project: GitlabProject) => {
    setSelectedProject(project)
    setUrl(projectUrl(project, protocol))
    setManual(false)
    setError(null)
    if (!destination.trim()) {
      const suggestion = suggestedDestination(project, recent)
      if (suggestion) {
        setDestination(suggestion)
      }
    }
  }

  const browseDestination = async () => {
    if (!onPickDirectory) {
      return
    }
    setError(null)
    const current = destination.trim()
    const start =
      (current ? parentDirectory(current) : null) ??
      (recent[0]?.path ? parentDirectory(recent[0].path) ?? recent[0].path : undefined)
    try {
      const parent = await onPickDirectory(start)
      if (!parent) {
        return
      }
      const name = selectedProject
        ? (selectedProject.pathWithNamespace.split('/').pop() ?? selectedProject.name)
        : repoNameFromUrl(url) || t('shell.home.defaultRepoName')
      const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
      setDestination(`${parent.replace(/[\\/]+$/, '')}${separator}${name}`)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim() || !destination.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const parsedDepth = Number(depth)
      await onClone({
        url: url.trim(),
        destination: destination.trim(),
        branch: branch.trim() || undefined,
        depth:
          Number.isFinite(parsedDepth) && parsedDepth > 0
            ? parsedDepth
            : undefined,
        recurseSubmodules: recurse,
      })
    } catch (cause) {
      const detail = errorDetail(cause)
      setError(
        detail
          ? `${errorMessage(cause)}\n${detail.slice(-700)}`
          : errorMessage(cause),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <section className={styles.start} aria-labelledby="start-title">
        <h1 id="start-title">{t('shell.topbar.openRepo')}</h1>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={onOpenDialog}
            disabled={busy}
          >
            {t('shell.home.openLocalRepo')}
          </button>
          {onCreate ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={onCreate}
              disabled={busy}
            >
              {t('shell.home.createRepo')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setMode(mode === 'clone' ? 'idle' : 'clone')
              setError(null)
              setSelectedProject(null)
              setUrl('')
              setManual(!session?.connected)
            }}
            aria-expanded={mode === 'clone'}
          >
            {t('shell.home.cloneRepo')}
          </button>
        </div>

        {mode === 'clone' ? (
          <form className={styles.cloneForm} onSubmit={(event) => void submit(event)}>
            <div className={styles.cloneHeader}>
              <strong>{t('shell.home.projectsAccessible', { provider: providerName })}</strong>
              {anyConnected ? (
                <span
                  className={styles.toggleGroup}
                  role="group"
                  aria-label={t('shell.home.provider')}
                >
                  <button
                    type="button"
                    aria-pressed={provider === 'gitlab'}
                    onClick={() => {
                      setProvider('gitlab')
                      setProjects([])
                      setSelectedProject(null)
                      setUrl('')
                      setProjectSearch('')
                      setManual(!session?.connected)
                    }}
                  >
                    GitLab
                  </button>
                  <button
                    type="button"
                    aria-pressed={provider === 'github'}
                    onClick={() => {
                      setProvider('github')
                      setProjects([])
                      setSelectedProject(null)
                      setUrl('')
                      setProjectSearch('')
                      setManual(!githubSession?.connected)
                    }}
                  >
                    GitHub
                  </button>
                </span>
              ) : null}
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(event) => {
                    setManual(event.target.checked)
                    if (event.target.checked) {
                      setSelectedProject(null)
                    }
                  }}
                />
                {t('shell.home.manualUrl')}
              </label>
            </div>

            {activeSession?.connected ? null : (
              <div className={styles.notice}>
                <span>
                  {sessionError ??
                    t('shell.home.notConnected', { provider: providerName })}
                </span>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => onSelect(provider)}
                >
                  {t('shell.home.connectProvider', { provider: providerName })}
                </button>
              </div>
            )}

            {!manual && activeSession?.connected ? (
              <div className={styles.projectPanel}>
                {activeSession.credentialSource &&
                activeSession.credentialSource !== 'keychain' ? (
                  <p className={styles.hint}>
                    {t('shell.home.tokenHint', { source: activeSession.credentialSource, provider: providerName })}
                  </p>
                ) : null}
                <input
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder={t('shell.home.searchProject', { provider: providerName })}
                  aria-label={t('shell.home.searchProjectLabel', { provider: providerName })}
                  spellCheck={false}
                />
                {projectError ? (
                  <p className={styles.error}>{projectError}</p>
                ) : null}
                <div
                  className={styles.projectList}
                  role="listbox"
                  aria-label={t('shell.home.projectsLabel', { provider: providerName })}
                >
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      role="option"
                      aria-selected={selectedProject?.id === project.id}
                      className={
                        selectedProject?.id === project.id
                          ? styles.projectOn
                          : styles.project
                      }
                      onClick={() => selectProject(project)}
                    >
                      <strong>{project.name}</strong>
                      <span>{project.pathWithNamespace}</span>
                    </button>
                  ))}
                  {projectLoading ? (
                    <p className={styles.projectEmpty}>{t('shell.home.searching')}</p>
                  ) : null}
                  {!projectLoading && projects.length === 0 ? (
                    <p className={styles.projectEmpty}>
                      {t('shell.home.noAccessibleProject')}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className={styles.cloneSettings}>
              {manual ? (
                <label className={styles.field}>
                  {t('shell.home.repoUrl')}
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder={t('shell.home.urlPlaceholder')}
                    spellCheck={false}
                    required={manual}
                  />
                </label>
              ) : selectedProject ? (
                <div className={styles.chosen}>
                  <div className={styles.chosenRow}>
                    <span className={styles.chosenLabel}>{t('shell.home.selectedRepo')}</span>
                    <strong>{selectedProject.pathWithNamespace}</strong>
                    <label className={styles.inlineField}>
                      {t('shell.home.protocol')}
                      <select
                        value={protocol}
                        onChange={(event) => {
                          const next = event.target.value as 'ssh' | 'https'
                          setProtocol(next)
                          setUrl(projectUrl(selectedProject, next))
                        }}
                      >
                        <option value="ssh">SSH</option>
                        <option value="https">HTTPS</option>
                      </select>
                    </label>
                    <code>{projectUrl(selectedProject, protocol)}</code>
                  </div>
                  <p className={styles.hint}>
                    {t('shell.home.protocolHint.before', { provider: providerName })} <code>known_hosts</code>{t('shell.home.protocolHint.after')}
                  </p>
                </div>
              ) : activeSession?.connected ? (
                <p className={styles.hint}>
                  {t('shell.home.chooseProjectHint')}
                </p>
              ) : null}

              <div className={styles.field}>
                <label htmlFor="clone-destination">
                  {t('shell.home.destinationLabel')}
                </label>
                <div className={styles.pathRow}>
                  <input
                    id="clone-destination"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    placeholder={t('shell.home.destinationPlaceholder')}
                    spellCheck={false}
                    required
                  />
                  {onPickDirectory ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => void browseDestination()}
                      disabled={busy}
                    >
                      {t('shell.action.browse')}
                    </button>
                  ) : null}
                </div>
                <span className={styles.hint}>
                  {t('shell.home.browseHint')}
                </span>
              </div>
              <div className={styles.options}>
                <label className={styles.field}>
                  {t('shell.home.branchOptional')}
                  <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="main"
                    spellCheck={false}
                  />
                </label>
                <label className={styles.field}>
                  {t('shell.home.depthOptional')}
                  <input
                    value={depth}
                    onChange={(event) => setDepth(event.target.value)}
                    placeholder="1"
                    inputMode="numeric"
                  />
                </label>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={recurse}
                    onChange={(event) => setRecurse(event.target.checked)}
                  />
                  {t('shell.home.recursiveSubmodules')}
                </label>
              </div>
            </div>

            <div className={styles.cloneFooter}>
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                className={styles.primary}
                disabled={busy || !url.trim() || !destination.trim()}
              >
                {busy ? t('shell.home.cloning') : t('shell.home.clone')}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setMode('idle')}
                disabled={busy}
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className={styles.recent} aria-label={t('shell.home.recentRepos')}>
        <div className={styles.sectionHeading}>
          <h2>{t('shell.home.resumeWork')}</h2>
          <span>
            {recent.length
              ? recentFilter
                ? plural('shell.home.filteredCount.one', 'shell.home.filteredCount.other', recent.length, {
                    count: formatNumber(filteredRecent.length),
                    total: formatNumber(recent.length),
                  })
                : plural('shell.home.recentCount.one', 'shell.home.recentCount.other', recent.length, {
                    count: formatNumber(recent.length),
                  })
              : t('shell.home.noRecents')}
          </span>
        </div>
        {recent.length ? (
          <input
            ref={searchInput}
            type="search"
            className={styles.recentSearch}
            value={recentQuery}
            onChange={(event) => setRecentQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && filteredRecent[0]) {
                event.preventDefault()
                onOpen(filteredRecent[0].path)
              }
            }}
            placeholder={t('shell.home.searchRecent')}
            aria-label={t('shell.home.searchRecentLabel')}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        {recent.length ? (
          <div className={styles.list}>
            {filteredRecent.map((entry) => (
              <button
                key={entry.repoId}
                type="button"
                className={styles.repo}
                onClick={() => onOpen(entry.path)}
                title={entry.path}
              >
                <span className={styles.repoIcon} aria-hidden="true">
                  ⑂
                </span>
                <span className={styles.repoText}>
                  <strong>{entry.name ?? entry.path.split('/').pop()}</strong>
                  <span>{entry.path}</span>
                </span>
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              </button>
            ))}
            {filteredRecent.length === 0 ? (
              <p className={styles.searchEmpty} role="status">
                {t('shell.home.noRecentMatch', { query: recentQuery.trim() })}
              </p>
            ) : null}
          </div>
        ) : (
          <div className={styles.empty}>
            {t('shell.home.emptyHint')}
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <span>
          <span className={styles.dot} />
          {t('shell.home.localCode')}
        </span>
        <span className={styles.row}>
          <button type="button" onClick={() => onSelect('gitlab')}>
            {t('shell.home.connectGitlab')}
          </button>
          <button type="button" onClick={() => onSelect('github')}>
            {t('shell.home.connectGithub')}
          </button>
        </span>
      </footer>
    </div>
  )
}
