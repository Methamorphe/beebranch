import { useEffect, useState, type FormEvent } from 'react'
import type { ViewId } from '../data/navigation'
import type { GitlabProject, GitlabSession, RecentRepo } from '../types/git'
import {
  githubProjectsPage,
  githubStatus,
  gitlabProjectsPage,
  gitlabStatus,
} from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
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
  onOpen,
  onOpenDialog,
  onClone,
  onCreate,
  onPickDirectory,
}: Props) {
  const [mode, setMode] = useState<'idle' | 'clone'>('idle')
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
        : repoNameFromUrl(url) || 'depot'
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
        <h1 id="start-title">Ouvrir un dépôt</h1>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={onOpenDialog}
            disabled={busy}
          >
            Ouvrir un dépôt local…
          </button>
          {onCreate ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={onCreate}
              disabled={busy}
            >
              Créer un dépôt…
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
            Cloner un dépôt…
          </button>
        </div>

        {mode === 'clone' ? (
          <form className={styles.cloneForm} onSubmit={(event) => void submit(event)}>
            <div className={styles.cloneHeader}>
              <strong>Projets {providerName} accessibles</strong>
              {anyConnected ? (
                <span
                  className={styles.toggleGroup}
                  role="group"
                  aria-label="Fournisseur"
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
                saisir une URL manuellement
              </label>
            </div>

            {activeSession?.connected ? null : (
              <div className={styles.notice}>
                <span>
                  {sessionError ??
                    `${providerName} n’est pas connecté. Connectez une instance pour lister vos projets, ou saisissez une URL manuelle.`}
                </span>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => onSelect(provider)}
                >
                  Connecter {providerName} →
                </button>
              </div>
            )}

            {!manual && activeSession?.connected ? (
              <div className={styles.projectPanel}>
                {activeSession.credentialSource &&
                activeSession.credentialSource !== 'keychain' ? (
                  <p className={styles.hint}>
                    Connecté avec un token déjà présent dans Git (
                    {activeSession.credentialSource}) : aucune configuration{' '}
                    {providerName} n’est nécessaire.
                  </p>
                ) : null}
                <input
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder={`Rechercher un projet ${providerName}…`}
                  aria-label={`Rechercher un projet ${providerName}`}
                  spellCheck={false}
                />
                {projectError ? (
                  <p className={styles.error}>{projectError}</p>
                ) : null}
                <div
                  className={styles.projectList}
                  role="listbox"
                  aria-label={`Projets ${providerName}`}
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
                    <p className={styles.projectEmpty}>Recherche…</p>
                  ) : null}
                  {!projectLoading && projects.length === 0 ? (
                    <p className={styles.projectEmpty}>
                      Aucun projet accessible avec ce token.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className={styles.cloneSettings}>
              {manual ? (
                <label className={styles.field}>
                  URL du dépôt
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="git@hote:owner/repo.git"
                    spellCheck={false}
                    required={manual}
                  />
                </label>
              ) : selectedProject ? (
                <div className={styles.chosen}>
                  <div className={styles.chosenRow}>
                    <span className={styles.chosenLabel}>Dépôt sélectionné</span>
                    <strong>{selectedProject.pathWithNamespace}</strong>
                    <label className={styles.inlineField}>
                      Protocole
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
                    HTTPS utilise le token {providerName}. SSH utilise votre agent
                    et <code>known_hosts</code>.
                  </p>
                </div>
              ) : activeSession?.connected ? (
                <p className={styles.hint}>
                  Choisissez un projet dans la liste pour remplir l’URL
                  automatiquement.
                </p>
              ) : null}

              <div className={styles.field}>
                <label htmlFor="clone-destination">
                  Dossier de destination (absolu, inexistant)
                </label>
                <div className={styles.pathRow}>
                  <input
                    id="clone-destination"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    placeholder="/Users/vous/src/repo"
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
                      Parcourir…
                    </button>
                  ) : null}
                </div>
                <span className={styles.hint}>
                  « Parcourir… » ouvre le sélecteur de dossiers de l’OS ; le nom du
                  dépôt est ajouté au dossier choisi.
                </span>
              </div>
              <div className={styles.options}>
                <label className={styles.field}>
                  Branche (optionnel)
                  <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="main"
                    spellCheck={false}
                  />
                </label>
                <label className={styles.field}>
                  Profondeur (optionnel)
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
                  sous-modules récursifs
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
                {busy ? 'Clonage…' : 'Cloner le dépôt'}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setMode('idle')}
                disabled={busy}
              >
                Annuler
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className={styles.recent} aria-label="Dépôts récents">
        <div className={styles.sectionHeading}>
          <h2>Reprendre le travail</h2>
          <span>
            {recent.length
              ? `${recent.length} dépôt${recent.length > 1 ? 's' : ''} récent${recent.length > 1 ? 's' : ''}`
              : 'Vos dépôts apparaîtront ici'}
          </span>
        </div>
        {recent.length ? (
          <div className={styles.list}>
            {recent.map((entry) => (
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
          </div>
        ) : (
          <div className={styles.empty}>
            Ouvrez un dossier existant, créez un dépôt local ou clonez un
            dépôt distant pour commencer.
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <span>
          <span className={styles.dot} />
          Votre code reste sur votre machine.
        </span>
        <span className={styles.row}>
          <button type="button" onClick={() => onSelect('gitlab')}>
            Connecter GitLab →
          </button>
          <button type="button" onClick={() => onSelect('github')}>
            Connecter GitHub →
          </button>
        </span>
      </footer>
    </div>
  )
}
