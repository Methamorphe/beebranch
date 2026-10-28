import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  gitlabConfigure,
  gitlabDisconnect,
  gitlabProjectsPage,
  gitlabRepoLinkManual,
  gitlabStatus,
  branchCheckout,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { GitlabProject, GitlabSession } from '../types/git'
import { MergeRequestsPanel } from './MergeRequestsPanel'
import styles from './GitlabPanel.module.css'

type Props = {
  repoId?: string | null
  generation?: number
  onLinked?: () => void
}

export function GitlabPanel({ repoId = null, generation = 0, onLinked }: Props) {
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
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

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
          result.fromCache
            ? 'Données servies depuis le cache local (ETag).'
            : null,
        )
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [],
  )

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
      setToken('')
      setEditing(false)
      setNotice('Connexion validée. Le token est stocké dans le keychain OS.')
      await loadProjects()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await gitlabDisconnect()
      setSession({ connected: false })
      setEditing(false)
      setProjects([])
      setNextPage(undefined)
      setNotice('Instance déconnectée ; le token a été supprimé du keychain.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.top}>
      <section className={styles.connection}>
        <header className={styles.header}>
          <h2>GitLab self-hosted</h2>
          <p>
            REST v4, Personal Access Token (scopes <code>api</code>,{' '}
            <code>read_user</code>, et <code>read_repository</code> pour cloner
            en HTTPS). Le token reste dans le keychain et n'est jamais renvoyé au
            frontend.
          </p>
        </header>

        {session && !session.connected && session.instance ? (
          <p className={styles.missingToken}>
            Instance connue ({session.instance.baseUrl}) mais aucun token local.
            Saisissez un Personal Access Token pour la reconnecter.
          </p>
        ) : null}

        {session?.connected && !editing ? (
          <div className={styles.identity}>
            <span className={styles.badge}>connecté</span>
            <strong>{session.user?.name ?? 'Instance GitLab connectée'}</strong>
            {session.user ? <code>@{session.user.username}</code> : null}
            <span>{session.instance?.baseUrl ?? 'instance active'}</span>
            <span className={styles.identityActions}>
              <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                Changer d'instance
              </button>
              <button type="button" onClick={() => void disconnect()} disabled={busy}>
                Déconnecter
              </button>
            </span>
          </div>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            {session?.connected ? (
              <p className={styles.notice}>
                Une instance est déjà connectée. Se connecter à une autre instance
                remplace la session active pour l'application.
              </p>
            ) : null}
            <label>
              URL de l'instance
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gitlab.example.com"
                required
              />
            </label>
            <label>
              Personal Access Token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <label>
              Nom d'affichage (optionnel)
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="GitLab interne"
              />
            </label>
            <label className={styles.ca}>
              CA interne PEM (optionnel)
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
                {busy ? 'Validation…' : 'Connecter'}
              </button>
              {session?.connected ? (
                <button type="button" onClick={() => setEditing(false)} disabled={busy}>
                  Annuler
                </button>
              ) : null}
            </span>
          </form>
        )}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className={styles.notice}>{notice}</p> : null}
      </section>

      {session?.connected ? (
        <section className={styles.projects}>
          <header className={styles.projectsHeader}>
            <h3>Projets accessibles</h3>
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
                placeholder="Rechercher un projet"
                aria-label="Rechercher un projet GitLab"
              />
              <button type="submit">Chercher</button>
            </form>
          </header>

          <div className={styles.list}>
            {projects.length === 0 ? (
              <p className={styles.empty}>Aucun projet chargé.</p>
            ) : null}
            {projects.map((project) => (
              <article key={project.id} className={styles.project}>
                <div>
                  <strong>{project.name}</strong>
                  <code>{project.pathWithNamespace}</code>
                </div>
                <div className={styles.projectMeta}>
                  <span>{project.defaultBranch ?? 'branche par défaut inconnue'}</span>
                  {project.lastActivityAt ? (
                    <span>
                      {new Date(project.lastActivityAt).toLocaleDateString('fr-FR')}
                    </span>
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
                          setNotice(
                            `Dépôt associé à ${link.pathWithNamespace} (#${link.projectId}).`,
                          )
                          onLinked?.()
                        })
                        .catch((cause: unknown) => setError(errorMessage(cause)))
                    }}
                  >
                    Associer ce dépôt
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
              Charger la page suivante ({nextPage})
            </button>
          ) : null}
        </section>
      ) : null}
      </div>
      {session?.connected ? (
        <MergeRequestsPanel
          repoId={repoId}
          generation={generation}
          connected={session.connected}
          onCheckout={(branch) => {
            if (repoId) {
              void branchCheckout({ repoId, name: branch })
            }
          }}
        />
      ) : null}
    </div>
  )
}
