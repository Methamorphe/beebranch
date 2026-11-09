import { useEffect, useState, type FormEvent } from 'react'
import { errorMessage } from '../ipc/client'
import {
  githubProjectsPage,
  githubStatus,
  gitlabProjectsPage,
  gitlabStatus,
  repoListRecent,
  type CloneInput,
} from '../ipc/commands'
import { useI18n } from '../i18n'
import type { GitlabProject, GitlabSession } from '../types/git'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'
import styles from './WorkspaceCloneDialog.module.css'

type Props = {
  open: boolean
  busy: boolean
  draft: boolean
  onClose: () => void
  onClone: (input: CloneInput) => Promise<void>
  onPickDirectory?: (defaultPath?: string) => Promise<string | null>
  onOpenProvider?: (provider: 'gitlab' | 'github') => void
}

function projectUrl(project: GitlabProject, protocol: 'ssh' | 'https' = 'ssh'): string {
  if (protocol === 'ssh') return project.sshUrlToRepo || project.httpUrlToRepo || ''
  return project.httpUrlToRepo || project.sshUrlToRepo || ''
}

function repoNameFromUrl(url: string) {
  let path = url.trim()
  if (path.includes('://')) {
    try {
      path = new URL(path).pathname
    } catch {
      return ''
    }
  } else if (!/^[a-z]:/i.test(path) && /^[^/\\:]+:/.test(path)) {
    path = path.slice(path.indexOf(':') + 1)
  }
  const segments = path.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  const name = last.endsWith('.git') ? last.slice(0, -4) : last
  return name === '.' || name === '..' || name === '.git' ? '' : name
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(0, index + 1) : null
}

export function WorkspaceCloneDialog({
  open,
  busy,
  draft,
  onClose,
  onClone,
  onPickDirectory,
  onOpenProvider,
}: Props) {
  const { t } = useI18n()
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
  const [parent, setParent] = useState('')
  const [branch, setBranch] = useState('')
  const [depth, setDepth] = useState('')
  const [recurse, setRecurse] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeSession = provider === 'github' ? githubSession : session
  const anyConnected = Boolean(session?.connected || githubSession?.connected)
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab'
  const name = repoNameFromUrl(url)
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  const destination = parent.trim() && name
    ? `${parent.trim().replace(/[\\/]+$/, '')}${separator}${name}`
    : ''
  const canSubmit = Boolean(url.trim() && destination) && (manual || Boolean(selectedProject))

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.allSettled([gitlabStatus(), githubStatus(), repoListRecent(1)]).then(([gitlab, github, recent]) => {
      if (cancelled) return
      const gitlabSession = gitlab.status === 'fulfilled' ? gitlab.value : null
      const githubSessionValue = github.status === 'fulfilled' ? github.value : null
      setSession(gitlabSession)
      setGithubSession(githubSessionValue)
      setManual(!(gitlabSession?.connected || githubSessionValue?.connected))
      if (!gitlabSession?.connected && githubSessionValue?.connected) setProvider('github')
      setSessionError(gitlab.status === 'rejected' ? errorMessage(gitlab.reason) : null)
      const recentPath = recent.status === 'fulfilled' ? recent.value[0]?.path : undefined
      if (recentPath) {
        const suggestion = parentDirectory(recentPath)
        if (suggestion) setParent((current) => current.trim() ? current : suggestion)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || manual || !activeSession?.connected) return
    let cancelled = false
    const fetchProjects = provider === 'github' ? githubProjectsPage : gitlabProjectsPage
    const timer = window.setTimeout(() => {
      setProjectLoading(true)
      setProjectError(null)
      void fetchProjects({ search: projectSearch.trim() || undefined, perPage: 50 })
        .then((page) => {
          if (!cancelled) setProjects(page.items)
        })
        .catch((cause) => {
          if (!cancelled) setProjectError(errorMessage(cause))
        })
        .finally(() => {
          if (!cancelled) setProjectLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, manual, provider, activeSession?.connected, projectSearch])

  const selectProject = (project: GitlabProject) => {
    setSelectedProject(project)
    setUrl(projectUrl(project, protocol))
    setManual(false)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || busy) return
    setError(null)
    const parsedDepth = Number(depth)
    try {
      await onClone({
        url: url.trim(),
        destination: destination.trim(),
        branch: branch.trim() || undefined,
        depth: Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : undefined,
        recurseSubmodules: recurse,
      })
      setUrl('')
      setSelectedProject(null)
      setBranch('')
      setDepth('')
      setRecurse(false)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Dialog open={open} onClose={onClose} busy={busy} titleId="workspace-clone-title" className={styles.dialog}>
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="workspace-clone-title">{t('workspaces.panel.cloneTitle')}</h2>
        <p className={shared.notice}>
          {t(draft ? 'workspaces.panel.cloneDraftIntro' : 'workspaces.panel.cloneIntro')}
        </p>
        <div className={styles.header}>
          <strong>{t('shell.home.projectsAccessible', { provider: providerName })}</strong>
          {anyConnected ? (
            <span className={styles.toggle} role="group" aria-label={t('shell.home.provider')}>
              <button
                type="button"
                aria-pressed={provider === 'gitlab'}
                disabled={busy}
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
                disabled={busy}
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
          <label className={shared.checkbox}>
            <input
              type="checkbox"
              checked={manual}
              disabled={busy}
              onChange={(event) => {
                setManual(event.target.checked)
                setSelectedProject(null)
                setUrl('')
              }}
            />
            {t('shell.home.manualUrl')}
          </label>
        </div>

        {activeSession?.connected ? null : (
          <div className={styles.notice}>
            <span>{sessionError ?? t('shell.home.notConnected', { provider: providerName })}</span>
            {onOpenProvider ? (
              <button
                type="button"
                className={shared.secondary}
                onClick={() => {
                  onOpenProvider(provider)
                  onClose()
                }}
              >
                {t('shell.home.connectProvider', { provider: providerName })}
              </button>
            ) : null}
          </div>
        )}

        {!manual && activeSession?.connected ? (
          <div className={styles.projects}>
            {activeSession.credentialSource && activeSession.credentialSource !== 'keychain' ? (
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
              disabled={busy}
            />
            {projectError ? <p className={styles.error}>{projectError}</p> : null}
            <div className={styles.projectList} role="listbox" aria-label={t('shell.home.projectsLabel', { provider: providerName })}>
              {projects.map((project) => (
                <button
                  key={`${provider}-${project.id}`}
                  type="button"
                  role="option"
                  aria-selected={selectedProject?.id === project.id}
                  className={selectedProject?.id === project.id ? styles.projectOn : styles.project}
                  disabled={busy}
                  onClick={() => selectProject(project)}
                >
                  <strong>{project.name}</strong>
                  <span>{project.pathWithNamespace}</span>
                </button>
              ))}
              {projectLoading ? <p className={styles.projectEmpty}>{t('shell.home.searching')}</p> : null}
              {!projectLoading && projects.length === 0 ? (
                <p className={styles.projectEmpty}>{t('shell.home.noAccessibleProject')}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        {manual ? (
          <label className={shared.field}>
            {t('shell.home.repoUrl')}
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('shell.home.urlPlaceholder')}
              spellCheck={false}
              disabled={busy}
            />
          </label>
        ) : selectedProject ? (
          <div className={styles.chosen}>
            <span>{t('shell.home.selectedRepo')}</span>
            <strong>{selectedProject.pathWithNamespace}</strong>
            <label className={styles.protocol}>
              {t('shell.home.protocol')}
              <select
                value={protocol}
                disabled={busy}
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
        ) : activeSession?.connected ? (
          <p className={styles.hint}>{t('shell.home.chooseProjectHint')}</p>
        ) : null}

        <div className={shared.field}>
          <label htmlFor="workspace-clone-destination">{t('shell.home.destinationLabel')}</label>
          <div className={styles.pathRow}>
            <input
              id="workspace-clone-destination"
              value={parent}
              onChange={(event) => setParent(event.target.value)}
              placeholder={t('shell.home.destinationPlaceholder')}
              spellCheck={false}
              disabled={busy}
            />
            {onPickDirectory ? (
              <button
                type="button"
                className={shared.secondary}
                disabled={busy}
                onClick={() => {
                  void onPickDirectory(parent || undefined).then((picked) => {
                    if (picked) setParent(picked)
                  })
                }}
              >
                {t('shell.action.browse')}
              </button>
            ) : null}
          </div>
          {destination ? (
            <output className={styles.hint} htmlFor="workspace-clone-destination">
              {t('shell.home.destinationPreview', { path: destination })}
            </output>
          ) : (
            <span className={styles.hint}>{t('shell.home.browseHint')}</span>
          )}
        </div>
        <div className={styles.options}>
          <label className={shared.field}>
            {t('shell.home.branchOptional')}
            <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" spellCheck={false} disabled={busy} />
          </label>
          <label className={shared.field}>
            {t('shell.home.depthOptional')}
            <input value={depth} onChange={(event) => setDepth(event.target.value)} placeholder="1" inputMode="numeric" disabled={busy} />
          </label>
        </div>
        <label className={shared.checkbox}>
          <input type="checkbox" checked={recurse} disabled={busy} onChange={(event) => setRecurse(event.target.checked)} />
          {t('shell.home.recursiveSubmodules')}
        </label>
        <div className={shared.row}>
          <button type="button" className={shared.secondary} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={shared.primary} disabled={busy || !canSubmit}>
            {busy ? t('shell.home.cloning') : t('shell.home.clone')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
