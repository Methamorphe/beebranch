// Marketing captures (README, Product Hunt): same headless Chrome + mocked
// Tauri IPC as `ui-smoke.mjs`, but with an English interface, a clean
// repository state and realistic demo data layered over the smoke mock.
//
// Usage: npm run build && node scripts/marketing-shots.mjs [outDir]
// Requires a Chrome/Chromium binary (CHROME_BIN) and Node 22+.

import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? join(root, 'target', 'marketing-shots'))
const chrome =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDTH = 1440
const HEIGHT = 900
const SCALE = Number(process.env.SHOT_SCALE ?? 2)

// --- Reuse the smoke harness helpers (server, base mock, CDP client) --------
// `ui-smoke.mjs` runs its checks at top level, so only its helper prelude is
// loaded: everything before its fixture data.
const smokeSource = await readFile(join(root, 'scripts', 'ui-smoke.mjs'), 'utf8')
const fixtureMarker = '\nconst count = 800'
const cut = smokeSource.indexOf(fixtureMarker)
if (cut < 0) throw new Error('ui-smoke.mjs layout changed: fixture marker not found')
await mkdir(outDir, { recursive: true })
const helperPath = join(outDir, '.smoke-helpers.mjs')
const prelude = smokeSource
  .slice(0, cut)
  .replaceAll('import.meta.dirname', JSON.stringify(join(root, 'scripts')))
await writeFile(helperPath, prelude + '\nexport { serve, mockScript, connect, evaluate, waitFor }\n')
const { serve, mockScript, connect, evaluate, waitFor } = await import(pathToFileURL(helperPath).href)
await rm(helperPath)

// --- Demo data --------------------------------------------------------------
const sha = (index) => (0x9a3f00 + index * 7919).toString(16).padStart(8, '0').repeat(5).slice(0, 40)
const now = Math.floor(Date.now() / 1000)
const people = [
  { name: 'Maya Chen', email: 'maya@example.com' },
  { name: 'Lucas Martin', email: 'lucas@example.com' },
  { name: 'Priya Nair', email: 'priya@example.com' },
  { name: 'Tom Becker', email: 'tom@example.com' },
]
const subjects = [
  'Merge branch \'feat/workspace-sync\'',
  'feat(workspaces): pull every repository in one click',
  'fix(sync): reuse forge tokens for grouped fetch',
  'feat(workspaces): show the sync scope before running',
  'chore(release): 2.0.0',
  'feat(graph): choose the date format of the history',
  'Merge branch \'feat/integrations-hub\'',
  'feat(integrations): one screen for GitLab and GitHub',
  'feat(integrations): group projects by namespace',
  'feat(integrations): link a folder to its remote project',
  'refactor(nav): one catalog for sidebar and command menu',
  'fix(tabs): keep overflowing tabs reachable',
  'Merge branch \'fix/terminal-panel\'',
  'feat(terminal): dock the terminal below the history',
  'fix(terminal): restore focus after closing the panel',
  'docs: refresh the GitHub integration guide',
  'perf(graph): virtualise ref badges off screen',
  'fix(diff): keep word wrap when switching files',
  'Merge branch \'feat/profiles-github\'',
  'feat(profiles): remember the GitHub account',
  'test(profiles): cover account switching',
  'chore(deps): update tauri to 2.9',
  'fix(merge): always create a merge commit',
  'feat(stash): preview a stash before applying it',
]
// The smoke mock dereferences commits[300]; keep enough rows for it.
const count = 320
const commits = Array.from({ length: count }, (_, index) => {
  const person = people[(index * 3 + Math.floor(index / 5)) % people.length]
  const timestamp = now - 40 * 60 - index * 4 * 3600 - (index % 3) * 1700
  return {
    sha: sha(index + 1),
    parents: index + 1 < count ? [sha(index + 2)] : [],
    author: { ...person, timestamp },
    committer: { ...person, timestamp },
    refs:
      index === 0 ? ['HEAD -> main', 'origin/main', 'origin/HEAD']
        : index === 2 ? ['feat/workspace-sync', 'origin/feat/workspace-sync']
          : index === 4 ? ['tag: v2.0.0']
            : index === 8 ? ['feat/integrations-hub']
              : index === 14 ? ['origin/fix/terminal-panel']
                : index === 20 ? ['feat/profiles-github', 'origin/feat/profiles-github']
                  : index === 28 ? ['tag: v1.11.0']
                    : [],
    subject: subjects[index % subjects.length],
  }
})
// Same two-lane layout as the smoke fixture: a merge every six rows.
const rail = (lane, fromTop, toBottom) => ({ lane, fromTop, toBottom })
const rows = commits.map((commit, index) => {
  if (commit.parents.length === 0) return { nodeLane: 0, laneCount: 1, rails: [rail(0, true, false)], arrivals: [], departures: [], overflow: false }
  const phase = index % 6
  if (phase === 0) return { nodeLane: 0, laneCount: 2, rails: [rail(0, false, true), rail(1, false, true)], arrivals: [], departures: [1], overflow: false }
  if (phase === 4) return { nodeLane: 0, laneCount: 2, rails: [rail(0, true, true), rail(1, true, false)], arrivals: [1], departures: [], overflow: false }
  if (phase === 5) return { nodeLane: 0, laneCount: 1, rails: [rail(0, true, true)], arrivals: [], departures: [], overflow: false }
  return { nodeLane: 1, laneCount: 2, rails: [rail(0, true, true), rail(1, true, true)], arrivals: [], departures: [], overflow: false }
})

const branch = (name, index, extra = {}) => ({ fullName: 'refs/heads/' + name, name, kind: 'branch', targetOid: commits[index].sha, objectType: 'commit', isHead: false, ...extra })
const remote = (name, index, extra = {}) => ({ fullName: 'refs/remotes/origin/' + name, name: 'origin/' + name, kind: 'remoteBranch', remote: 'origin', targetOid: commits[index].sha, objectType: 'commit', isHead: false, ...extra })
const tag = (name, index) => ({ fullName: 'refs/tags/' + name, name, kind: 'tag', targetOid: commits[index].sha, objectType: 'commit', isHead: false })
const refs = {
  head: { fullName: 'refs/heads/main', name: 'main', oid: commits[0].sha },
  entries: [
    branch('main', 0, { upstream: 'refs/remotes/origin/main', isHead: true }),
    remote('main', 0),
    remote('HEAD', 0, { symref: 'refs/remotes/origin/main' }),
    branch('feat/workspace-sync', 2, { upstream: 'refs/remotes/origin/feat/workspace-sync' }),
    remote('feat/workspace-sync', 2),
    branch('feat/integrations-hub', 8),
    remote('fix/terminal-panel', 14),
    branch('feat/profiles-github', 20, { upstream: 'refs/remotes/origin/feat/profiles-github' }),
    remote('feat/profiles-github', 20),
    tag('v2.0.0', 4),
    tag('v1.11.0', 28),
  ],
  remotes: ['origin'],
  remoteUrls: [{ name: 'origin', url: 'git@gitlab.example.com:acme/beebranch.git', direction: 'push' }],
}

const statusEntries = [
  { kind: 'ordinary', path: 'src/lib/graphDate.ts', index: 'M', worktree: '.' },
  { kind: 'ordinary', path: 'src/i18n/messages/en/settings.ts', index: 'M', worktree: '.' },
  { kind: 'ordinary', path: 'src/components/SettingsAppearance.tsx', index: '.', worktree: 'M' },
  { kind: 'ordinary', path: 'src/components/GraphCanvas.tsx', index: '.', worktree: 'M' },
  { kind: 'ordinary', path: 'README.md', index: '.', worktree: 'M' },
  { kind: 'untracked', path: 'scripts/graph-date-format-check.ts', index: '.', worktree: '.' },
]
const worktreeCounts = { staged: 2, unstaged: 3, untracked: 1, conflicted: 0 }
const status = {
  branch: { oid: commits[0].sha, head: 'main', detached: false, unborn: false, upstream: 'origin/main', ahead: 1, behind: 0 },
  entries: statusEntries, ignored: [], counts: worktreeCounts, truncated: false,
}

const diffSource = [
  [' ', "export const GRAPH_DATE_PREFERENCE = 'ui.graphDateFormat'"],
  [' ', ''],
  [' ', 'export const GRAPH_DATE_FORMATS = ['],
  [' ', "  'relative',"],
  [' ', "  'dateTime',"],
  [' ', "  'date',"],
  ['-', "  'numeric',"],
  ['+', "  'numericTime',"],
  ['+', "  'numeric',"],
  ['+', "  'isoTime',"],
  ['+', "  'iso',"],
  [' ', '] as const'],
  [' ', ''],
  [' ', 'export type GraphDateFormat = (typeof GRAPH_DATE_FORMATS)[number]'],
  [' ', ''],
  ['-', 'export function formatGraphDate(date: Date, locale: Locale): string {'],
  ['-', '  return formatRelativeTime(date, locale)'],
  ['+', 'export function formatGraphDate('],
  ['+', '  date: Date,'],
  ['+', '  format: GraphDateFormat,'],
  ['+', '  locale: Locale,'],
  ['+', '): string {'],
  ['+', "  if (format === 'relative') return relativeThenAbsolute(date, locale)"],
  ['+', "  if (format === 'iso') return date.toISOString().slice(0, 10)"],
  ['+', "  if (format === 'isoTime') return date.toISOString().slice(0, 16).replace('T', ' ')"],
  ['+', '  return new Intl.DateTimeFormat(localeTag(locale), DATE_FIELDS[format]).format(date)'],
  [' ', '}'],
]
let oldLine = 14
let newLine = 14
const diffLines = diffSource.map(([marker, content]) => {
  const kind = marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context'
  const line = { kind, oldLineno: kind === 'added' ? null : oldLine, newLineno: kind === 'removed' ? null : newLine, content, noNewline: false }
  if (kind !== 'added') oldLine += 1
  if (kind !== 'removed') newLine += 1
  return line
})
const diff = {
  files: [{
    oldPath: 'src/lib/graphDate.ts', newPath: 'src/lib/graphDate.ts', kind: 'modified', binary: false,
    additions: diffLines.filter((line) => line.kind === 'added').length,
    deletions: diffLines.filter((line) => line.kind === 'removed').length, truncated: false,
    hunks: [{ oldStart: 14, oldLines: oldLine - 14, newStart: 14, newLines: newLine - 14, section: 'graph date formats', lines: diffLines }],
  }],
  truncated: false,
}

const repoInfo = (name, path, id) => ({ repoId: id, name, worktree: path, gitDir: path + '/.git', commonDir: path + '/.git', bare: false, linkedWorktree: false, submodule: false, shallow: false, gitVersion: '2.51.0' })
const cleanState = { head: { kind: 'branch', name: 'main', upstream: 'origin/main' }, operation: null, conflicts: { files: [] }, worktree: worktreeCounts }
const repo = { repo: repoInfo('beebranch', '/Users/maya/code/beebranch', 'repo_demo'), state: cleanState, generation: 1, created: false, locks: [] }

const user = (id, username, name) => ({ id, username, name, avatarUrl: undefined })
const maya = user(1, 'maya', 'Maya Chen')
const lucas = user(2, 'lucas', 'Lucas Martin')
const priya = user(3, 'priya', 'Priya Nair')
const tom = user(4, 'tom', 'Tom Becker')
const project = (id, path, host, extra = {}) => ({
  id, name: path.split('/').pop(), pathWithNamespace: path, webUrl: `https://${host}/${path}`,
  sshUrlToRepo: `git@${host}:${path}.git`, httpUrlToRepo: `https://${host}/${path}.git`,
  defaultBranch: 'main', lastActivityAt: new Date((now - id * 5400) * 1000).toISOString(), description: undefined, ...extra,
})
const page = (items) => ({ items, page: 1, perPage: 50, nextPage: undefined, total: items.length, notModified: false, fromCache: false })
const gitlabHost = 'gitlab.example.com'
const gitlabProjects = [
  project(11, 'acme/beebranch', gitlabHost),
  project(12, 'acme/design-system', gitlabHost),
  project(13, 'acme/docs', gitlabHost),
  project(21, 'platform/api-gateway', gitlabHost),
  project(22, 'platform/billing-service', gitlabHost),
  project(23, 'platform/infra-terraform', gitlabHost),
  project(31, 'mobile/ios-app', gitlabHost),
  project(32, 'mobile/android-app', gitlabHost),
]
const githubProjects = [
  project(101, 'acme-oss/beebranch', 'github.com'),
  project(102, 'acme-oss/beebranch-website', 'github.com'),
  project(103, 'acme-oss/homebrew-tap', 'github.com'),
]
const pipeline = (id, state) => ({ id, status: state, refName: 'main', sha: commits[0].sha, webUrl: 'https://example.com/pipelines/' + id, source: 'merge_request_event', updatedAt: new Date((now - 1800) * 1000).toISOString() })
const review = (iid, title, author, sourceBranch, extra = {}) => ({
  projectId: 11, iid, title, description: undefined, state: 'opened', draft: false, workInProgress: false,
  sourceBranch, targetBranch: 'main', author, assignees: [author], reviewers: [maya], labels: [],
  detailedMergeStatus: 'mergeable', mergeStatus: 'can_be_merged', hasConflicts: false, sha: commits[0].sha,
  webUrl: 'https://example.com/acme/beebranch/-/merge_requests/' + iid,
  updatedAt: new Date((now - iid * 2700) * 1000).toISOString(), userNotesCount: 0, ...extra,
})
const gitlabReviews = [
  review(184, 'Workspaces: pull every repository in one click', lucas, 'feat/workspace-sync', { labels: ['workspaces'], userNotesCount: 4, headPipeline: pipeline(9031, 'success') }),
  review(183, 'Integrations: group projects by namespace', priya, 'feat/integrations-hub', { labels: ['forge', 'ux'], userNotesCount: 2, headPipeline: pipeline(9024, 'running') }),
  review(181, 'Terminal: dock below the history', tom, 'fix/terminal-panel', { userNotesCount: 7, headPipeline: pipeline(9012, 'failed') }),
  review(179, 'Draft: profiles remember the GitHub account', lucas, 'feat/profiles-github', { draft: true, headPipeline: pipeline(9001, 'success') }),
]
const githubReviews = gitlabReviews.map((item, index) => ({
  ...item, iid: 412 - index * 3, repositoryName: 'acme-oss/beebranch',
  webUrl: 'https://github.com/acme-oss/beebranch/pull/' + (412 - index * 3),
}))

const workspaces = [
  { id: 'ws_product', name: 'Product', createdAt: now - 864000, updatedAt: now - 3600, repos: [
    { path: '/Users/maya/code/beebranch', name: 'beebranch', addedAt: now - 864000 },
    { path: '/Users/maya/code/design-system', name: 'design-system', addedAt: now - 864000 },
    { path: '/Users/maya/code/docs', name: 'docs', addedAt: now - 800000 },
  ] },
  { id: 'ws_platform', name: 'Platform', createdAt: now - 700000, updatedAt: now - 7200, repos: [
    { path: '/Users/maya/code/api-gateway', name: 'api-gateway', addedAt: now - 700000 },
    { path: '/Users/maya/code/billing-service', name: 'billing-service', addedAt: now - 700000 },
    { path: '/Users/maya/code/infra-terraform', name: 'infra-terraform', addedAt: now - 650000 },
  ] },
]
const repoState = (branchName, counts, upstream = 'origin/' + branchName) => ({
  head: { kind: 'branch', name: branchName, upstream }, operation: null, conflicts: { files: [] },
  worktree: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...counts },
})
const workspaceStatus = [
  { path: '/Users/maya/code/beebranch', name: 'beebranch', available: true, repoId: 'repo_demo', state: cleanState },
  { path: '/Users/maya/code/design-system', name: 'design-system', available: true, repoId: 'repo_ds', state: repoState('main', {}) },
  { path: '/Users/maya/code/docs', name: 'docs', available: true, repoId: 'repo_docs', state: repoState('docs/integrations', { unstaged: 2 }) },
  { path: '/Users/maya/code/api-gateway', name: 'api-gateway', available: true, repoId: 'repo_api', state: repoState('main', {}) },
  { path: '/Users/maya/code/billing-service', name: 'billing-service', available: true, repoId: 'repo_billing', state: repoState('fix/invoice-rounding', { staged: 1, unstaged: 1 }) },
  { path: '/Users/maya/code/infra-terraform', name: 'infra-terraform', available: true, repoId: 'repo_infra', state: repoState('main', {}) },
]

const overrides = {
  app_info: { name: 'BeeBranch', version: '2.0.0', platform: 'macos', arch: 'aarch64', dataDir: '/tmp' },
  repo_list_recent: workspaceStatus.map((item, index) => ({ repoId: item.repoId, path: item.path, name: item.name, lastOpenedAt: now - index * 3600 })),
  repo_list_open: [repo.repo],
  repo_open: repo,
  repo_get_state: repo,
  repo_refresh: repo,
  status_get: { data: status, generation: 1 },
  refs_get: { data: refs, generation: 1 },
  graph_page: { commits, rows, next: undefined, generation: 1, truncated: false },
  diff_get: { data: diff, generation: 1 },
  commit_get: {
    data: {
      summary: commits[0],
      message: commits[0].subject + '\n',
      files: [
        { path: 'src/lib/graphDate.ts', status: 'M', additions: 48, deletions: 6, binary: false },
        { path: 'src/components/SettingsAppearance.tsx', status: 'M', additions: 31, deletions: 2, binary: false },
        { path: 'src/i18n/messages/en/settings.ts', status: 'M', additions: 12, deletions: 0, binary: false },
      ],
      filesTruncated: false, messageTruncated: false,
    },
    generation: 1,
  },
  stash_list: [],
  worktree_list: { mainWorktree: repo.repo.worktree, entries: [
    { path: repo.repo.worktree, head: commits[0].sha, branch: 'main', bare: false, detached: false, main: true, changedFiles: 6, dirty: true },
  ] },
  tag_list: [
    { name: 'v2.0.0', oid: commits[4].sha, objectType: 'commit', annotated: false, targetOid: commits[4].sha },
    { name: 'v1.11.0', oid: commits[28].sha, objectType: 'commit', annotated: false, targetOid: commits[28].sha },
  ],
  remote_list: [{ name: 'origin', fetchUrl: 'git@gitlab.example.com:acme/beebranch.git', pushUrl: 'git@gitlab.example.com:acme/beebranch.git' }],
  submodule_list: { entries: [], truncated: false },
  profiles_list: { profiles: [
    { id: 'profile-work', name: 'Work', userName: 'Maya Chen', userEmail: 'maya@example.com', defaultPull: 'rebase', createdAt: now - 864000 },
    { id: 'profile-oss', name: 'Open source', userName: 'Maya Chen', userEmail: 'maya@users.noreply.example.com', defaultPull: 'merge', createdAt: now - 432000 },
  ], activeId: 'profile-work' },
  commit_identity: { name: 'Maya Chen', email: 'maya@example.com' },
  commit_config: { name: 'Maya Chen', email: 'maya@example.com', signing: true },
  undo_status: { undo: null, redo: null, failed: [], recent: [] },
  gitlab_status: { connected: true, instance: { id: 'gl_acme', baseUrl: 'https://' + gitlabHost, displayName: 'GitLab (self-hosted)' }, user: maya },
  github_status: { connected: true, instance: { id: 'gh_acme', baseUrl: 'https://github.com', displayName: 'GitHub' }, user: maya },
  gitlab_projects_page: page(gitlabProjects),
  github_projects_page: page(githubProjects),
  gitlab_repo_link_get: { repoId: 'repo_demo', instanceId: 'gl_acme', projectId: 11, matchKind: 'remote', pathWithNamespace: 'acme/beebranch', name: 'beebranch', webUrl: 'https://' + gitlabHost + '/acme/beebranch' },
  github_repo_link_get: null,
  gitlab_mr_page: { ...page(gitlabReviews), perPage: 25 },
  github_pr_page: { ...page(githubReviews), perPage: 25 },
  workspace_list: workspaces,
  workspace_status: workspaceStatus,
  update_status: { currentVersion: '2.0.0', endpoint: 'https://example.com/latest.json', rollbackEndpoint: 'https://example.com/rollback.json', signatureRequired: true, platform: 'macos-aarch64' },
  update_check: null,
}
const preferences = {
  'ui.language': 'en',
  'git.autoFetchPrompted': true,
  'git.autoFetchMinutes': 15,
  'ui.graphDateFormat': 'relative',
}

// Runs after the smoke mock: wraps its invoke with the demo data above.
const overlay = `(() => {
  const overrides = ${JSON.stringify(overrides)};
  const preferences = Object.assign(${JSON.stringify(preferences)}, JSON.parse(localStorage.getItem('__shotPrefs') || '{}'));
  const base = window.__TAURI_INTERNALS__.invoke;
  const clone = (value) => structuredClone(value);
  // Answers that depend on the request: per-workspace status, per-path repo
  // and diff, so tabs, workspace rows and the diff header stay consistent.
  const dynamic = {
    workspace_status: (args) => {
      const workspace = overrides.workspace_list.find((item) => item.id === args.request?.workspaceId);
      const paths = new Set((workspace?.repos ?? []).map((item) => item.path));
      return clone(overrides.workspace_status.filter((item) => paths.has(item.path)));
    },
    repo_open: (args) => {
      const known = overrides.workspace_status.find((item) => item.path === args.path);
      const repo = clone(overrides.repo_open);
      if (!known || known.repoId === repo.repo.repoId) return repo;
      repo.repo = { ...repo.repo, repoId: known.repoId, name: known.name, worktree: known.path, gitDir: known.path + '/.git', commonDir: known.path + '/.git' };
      repo.state = clone(known.state);
      return repo;
    },
    diff_get: (args) => {
      const diff = clone(overrides.diff_get);
      const path = args.request?.path;
      if (path) diff.data.files = diff.data.files.map((file) => ({ ...file, oldPath: path, newPath: path }));
      return diff;
    },
  };
  window.__TAURI_INTERNALS__.invoke = (command, args) => {
    if (command === 'preference_get' && args && args.key in preferences) return Promise.resolve(preferences[args.key]);
    if (command === 'preference_set' && args) { preferences[args.key] = args.value; return Promise.resolve(null); }
    if (command in dynamic) {
      try { return Promise.resolve(dynamic[command](args ?? {})); } catch (error) { return Promise.reject(error); }
    }
    if (command in overrides) return Promise.resolve(structuredClone(overrides[command]));
    return base(command, args);
  };
})();`

// --- Browser ---------------------------------------------------------------
const server = await serve()
const port = server.address().port
const debugProbe = createServer()
await new Promise((ready) => debugProbe.listen(0, '127.0.0.1', ready))
const debugPort = debugProbe.address().port
await new Promise((closed) => debugProbe.close(closed))
const profileDir = join(outDir, '.chrome-profile')
await rm(profileDir, { recursive: true, force: true })
const browserState = { stderr: '', exit: null }
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
browser.stderr.on('data', (chunk) => { browserState.stderr = `${browserState.stderr}${chunk}`.slice(-4000) })
browser.on('exit', (code, signal) => { browserState.exit = { code, signal } })

const shots = []
try {
  const client = await connect(debugPort, browserState)
  const shot = async (name) => {
    await evaluate(client, `document.fonts.ready.then(() => true)`)
    await delay(400)
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
    const path = join(outDir, name)
    await writeFile(path, Buffer.from(data, 'base64'))
    shots.push(path)
  }
  const clickSelector = async (selector) => {
    const ok = await evaluate(client, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el) })()`)
    if (!ok) throw new Error('missing element: ' + selector)
    await delay(250)
  }
  const clickText = async (text, scope = 'button, a, [role="tab"], [role="button"]') => {
    const ok = await evaluate(client, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((item) => item.textContent.trim() === ${JSON.stringify(text)} || item.getAttribute('aria-label') === ${JSON.stringify(text)}); el?.click(); return Boolean(el) })()`)
    if (!ok) throw new Error('missing control: ' + text)
    await delay(250)
  }

  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false })
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: mockScript(commits, rows, []) })
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: overlay })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await waitFor(client, `document.documentElement.lang === 'en' && document.body.innerText.includes('Resume your work')`, 'home')
  await shot('home.png')

  // Workspaces: activate "Product" so its repositories open as tabs.
  await clickSelector('[data-view="workspaces"]')
  await waitFor(client, `document.body.innerText.includes('design-system')`, 'workspace status')
  await clickText('Activate')
  await delay(800)
  await clickSelector('[data-view="workspaces"]')
  await waitFor(client, `document.body.innerText.includes('/Users/maya/code/docs')`, 'workspace status after activation')
  await shot('workspaces.png')

  // History of the beebranch tab.
  await evaluate(client, `[...document.querySelectorAll('[role="tab"], button')].find((item) => item.textContent.trim() === 'beebranch')?.click()`)
  await clickSelector('[data-view="graph"]').catch(() => undefined)
  await waitFor(client, `document.querySelector('canvas') !== null`, 'graph canvas')
  await shot('history.png')

  // Local changes: the WIP row opens the files, then one file's diff.
  await clickSelector('[data-role="worktree"]')
  await clickSelector('button[title="src/components/GraphCanvas.tsx"]')
  await waitFor(client, `document.body.innerText.includes('relativeThenAbsolute')`, 'diff')
  await shot('changes.png')
  await evaluate(client, `document.querySelector('button[aria-label="Close the preview"]')?.click()`)
  await delay(300)
  await evaluate(client, `document.querySelector('button[aria-label="Close commit preparation"]')?.click()`)
  await delay(300)

  // Integrations: GitLab repositories grouped by namespace, then reviews.
  await clickSelector('[data-view="integrations"]')
  await clickSelector('[data-forge-link="gitlab"]')
  await waitFor(client, `document.querySelector('#gitlab-panel-projects')?.textContent.includes('acme/')`, 'gitlab projects')
  await evaluate(client, `(() => { const box = document.querySelector('#gitlab-panel-projects input[type="checkbox"]'); if (box && !box.checked) box.click(); return true })()`)
  await delay(300)
  await shot('integrations-gitlab.png')
  await clickSelector('#gitlab-tab-reviews')
  await shot('integrations-gitlab-reviews.png')
  await clickSelector('[data-view="integrations"]')
  await clickSelector('[data-forge-link="github"]')
  await clickSelector('#github-tab-reviews')
  await shot('integrations-github-reviews.png')

  // Settings: appearance with the graph date format.
  await clickSelector('[data-view="profiles"]')
  await waitFor(client, `document.body.innerText.includes('Appearance')`, 'settings')
  await shot('settings.png')
} finally {
  browser.kill()
  server.close()
}
console.log(shots.join('\n'))
