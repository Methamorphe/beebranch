/**
 * Web URLs for branches and commits, derived from what the repository already
 * knows: the GitLab link when the project is associated, else the remote
 * fetch URL. Nothing is fetched, and no host is invented: an unrecognised
 * remote yields `null` instead of a broken link.
 */

type RefLinkTarget = 'branch' | 'commit'

/** `git@host:owner/repo.git`, `ssh://…`, `https://…:port/…` → `https://host/owner/repo`. */
function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  const scp = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+)$/.exec(trimmed)
  if (!scp) return null
  const [, host, path] = scp
  if (!host || !path) return null
  const clean = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  if (clean.length === 0) return null
  return `https://${host}/${clean}`
}

/** Escape a ref for a URL path while keeping the slashes of `feature/x`. */
function encodePath(value: string) {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * `base` is a project web root (`https://gitlab.example/group/project`).
 * GitLab nests these pages under `/-/`, GitHub and Bitbucket do not.
 */
export function refWebUrl(
  base: string,
  target: RefLinkTarget,
  reference: string,
): string | null {
  let root: string
  try {
    root = new URL(base).toString().replace(/\/+$/, '')
  } catch {
    return null
  }
  const path = encodePath(reference)
  if (!path) return null
  const host = new URL(root).host
  if (/gitlab/i.test(host)) {
    return `${root}/-/${target === 'branch' ? 'tree' : 'commit'}/${path}`
  }
  if (/bitbucket/i.test(host)) {
    return `${root}/${target === 'branch' ? 'src' : 'commits'}/${path}`
  }
  return `${root}/${target === 'branch' ? 'tree' : 'commit'}/${path}`
}

/**
 * Project web root: the GitLab project when linked, else the remote the
 * branch is pushed to, else the first remote with a fetch URL.
 */
export function projectWebUrl(
  remoteUrls: { name: string; url: string; direction: string }[] | undefined,
  gitlabWebUrl: string | null,
  remoteName?: string | null,
): string | null {
  if (gitlabWebUrl) {
    return gitlabWebUrl
  }
  const remotes = remoteUrls ?? []
  const preferred =
    (remoteName && remotes.find((entry) => entry.name === remoteName)) ||
    remotes.find((entry) => entry.direction === 'push') ||
    remotes.find((entry) => entry.direction === 'fetch') ||
    remotes[0]
  if (!preferred) return null
  return normalizeRemoteUrl(preferred.url)
}
