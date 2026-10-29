// Headless UI proof: serves the production bundle, injects a mocked Tauri IPC
// layer with deterministic data, exercises the graph and diff views, measures
// first paint and frame timing, and writes screenshots.
//
// Usage: node scripts/ui-smoke.mjs [outDir]
// Requires a Chrome/Chromium binary and Node 22+.

import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const outDir = resolve(process.argv[2] ?? join(root, 'target', 'ui-smoke'))
const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function serve() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const path = url.pathname === '/' ? '/index.html' : url.pathname
      const file = join(dist, path)
      if (!file.startsWith(dist)) {
        response.writeHead(403).end()
        return
      }
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

const sha = (index) => index.toString(16).padStart(40, '0')

function mockScript(commits, rows, diffLines) {
  return `
(() => {
  const commits = ${JSON.stringify(commits)};
  const rows = ${JSON.stringify(rows)};
  const statusEntries = Array.from({ length: 24 }, (_, index) => ({
    kind: index % 5 === 0 ? 'untracked' : 'ordinary',
    path: index % 5 === 0 ? 'notes/file-' + index + '.md' : 'src/module-' + index + '.ts',
    index: index % 3 === 0 ? 'M' : '.',
    worktree: index % 3 === 0 ? '.' : 'M',
  }));
  const status = {
    branch: { oid: commits[0].sha, head: 'main', detached: false, unborn: false,
      upstream: 'origin/main', ahead: 2, behind: 1 },
    entries: statusEntries,
    ignored: [],
    counts: { staged: 8, unstaged: 16, untracked: 5, conflicted: 0 },
    truncated: false,
  };
  const refs = {
    head: { fullName: 'refs/heads/main', name: 'main', oid: commits[0].sha },
    entries: [
      { fullName: 'refs/heads/main', name: 'main', kind: 'branch', targetOid: commits[0].sha,
        objectType: 'commit', upstream: 'refs/remotes/origin/main', isHead: true },
      { fullName: 'refs/heads/feature', name: 'feature', kind: 'branch', targetOid: commits[12].sha,
        objectType: 'commit', isHead: false },
      { fullName:'refs/remotes/origin/main', name:'origin/main', kind:'remoteBranch', remote:'origin', targetOid:commits[0].sha, objectType:'commit', isHead:false },
      { fullName:'refs/heads/feature/group', name:'feature/group', kind:'branch', targetOid:commits[0].sha, objectType:'commit', isHead:false },
      { fullName:'refs/remotes/origin/feature/deep', name:'origin/feature/deep', kind:'remoteBranch', remote:'origin', targetOid:commits[0].sha, objectType:'commit', isHead:false },
      { fullName:'refs/heads/collision', name:'collision', kind:'branch', targetOid:commits[2].sha, objectType:'commit', isHead:false },
      { fullName:'refs/remotes/origin/collision', name:'origin/collision', kind:'remoteBranch', remote:'origin', targetOid:commits[0].sha, objectType:'commit', isHead:false },
      { fullName:'refs/tags/main', name:'main', kind:'tag', targetOid:commits[0].sha, objectType:'commit', isHead:false },
      { fullName: 'refs/tags/v0.1', name: 'v0.1', kind: 'tag', targetOid: commits[5].sha,
        objectType: 'commit', isHead: false },
      // Local branch and its remote mirror on the same commit: one branch.
      { fullName: 'refs/heads/synced', name: 'synced', kind: 'branch', targetOid: commits[3].sha,
        objectType: 'commit', upstream: 'refs/remotes/origin/synced', isHead: false },
      { fullName:'refs/remotes/origin/synced', name:'origin/synced', kind:'remoteBranch', remote:'origin', targetOid:commits[3].sha, objectType:'commit', isHead:false },
      // Local branch lagging behind its own remote-tracking ref.
      { fullName: 'refs/heads/behind', name: 'behind', kind: 'branch', targetOid: commits[6].sha,
        objectType: 'commit', upstream: 'refs/remotes/origin/behind', isHead: false },
      { fullName:'refs/remotes/origin/behind', name:'origin/behind', kind:'remoteBranch', remote:'origin', targetOid:commits[7].sha, objectType:'commit', isHead:false },
      // A remote branch sharing its commit with another local branch: the
      // badge under the cursor decides which ref is checked out.
      { fullName: 'refs/heads/other', name: 'other', kind: 'branch', targetOid: commits[8].sha,
        objectType: 'commit', isHead: false },
      { fullName:'refs/remotes/origin/topic', name:'origin/topic', kind:'remoteBranch', remote:'origin', targetOid:commits[8].sha, objectType:'commit', isHead:false },
      // Remote-only branch: its badge must read as remote, not local.
      { fullName:'refs/remotes/origin/hotfix', name:'origin/hotfix', kind:'remoteBranch', remote:'origin', targetOid:commits[18].sha, objectType:'commit', isHead:false },
      // Symbolic remote HEAD: an alias of origin/main, never a branch of its own.
      { fullName:'refs/remotes/origin/HEAD', name:'origin/HEAD', kind:'remoteBranch', remote:'origin', targetOid:commits[0].sha, objectType:'commit', isHead:false, symref:'refs/remotes/origin/main' },
    ],
    remotes: ['origin'],
    remoteUrls: [{ name: 'origin', url: 'git@gitlab.example.test:team/beebranch-demo.git', direction: 'push' }],
  };
  const lines = ${JSON.stringify(diffLines)};
  const diff = {
    files: [
      {
        oldPath: 'src/pair.ts', newPath: 'src/pair.ts', kind: 'modified',
        binary: false, additions: 1, deletions: 1, truncated: false,
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: 'value',
          lines: [
            { kind: 'removed', oldLineno: 1, newLineno: null,
              content: '    render_row(7, "windowed diff payload"); // ' +
                'horizontal-scroll-probe '.repeat(20) + 'old', noNewline: false },
            { kind: 'added', oldLineno: null, newLineno: 1,
              content: '    render_row(7, "windowed diff payload"); // ' +
                'horizontal-scroll-probe '.repeat(20) + 'new', noNewline: false },
          ],
        }],
      },
      { oldPath: 'src/main.rs', newPath: 'src/main.rs', kind: 'modified',
        binary: false, additions: lines.length, deletions: 0, truncated: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length,
          section: 'fn main', lines: lines.map((content, index) => ({
            kind: 'added', oldLineno: null, newLineno: index + 1, content,
            noNewline: false })) }] },
    ],
    truncated: false,
  };
  const commit = {
    summary: commits[0],
    message: commits[0].subject + '\\n\\nCorps du commit pour la démonstration UI.\\n',
    files: [
      { path: 'src/main.rs', status: 'M', additions: 42, deletions: 7, binary: false },
      { path: 'src/graph.rs', status: 'M', additions: 210, deletions: 15, binary: false },
      { path: 'assets/logo.png', status: 'M', additions: null, deletions: null, binary: true },
    ],
    filesTruncated: false,
    messageTruncated: false,
  };
  const repo = {
    repo: { repoId: 'repo_demo', name: 'beebranch-demo', worktree: '/tmp/beebranch-demo',
      gitDir: '/tmp/beebranch-demo/.git', commonDir: '/tmp/beebranch-demo/.git',
      bare: false, linkedWorktree: false, submodule: false, shallow: false, gitVersion: '2.55.0' },
    state: { head: { kind: 'branch', name: 'main', upstream: 'origin/main' },
      operation: { kind: 'merge' },
      conflicts: { files: ['src/main.rs'] }, worktree: { staged: 8, unstaged: 16, untracked: 5, conflicted: 1 } },
    generation: 1, created: true, locks: [],
  };
  const handlers = {
    app_info: () => ({ name: 'BeeBranch', version: '0.1.0', platform: 'macos', arch: 'aarch64', dataDir: '/tmp' }),
    repo_list_recent: () => [{ repoId: 'repo_demo', path: '/tmp/beebranch-demo', name: 'beebranch-demo', lastOpenedAt: 1 }],
    repo_open: (args) => { (window.__repoOpenCalls ??= []).push(args.path); if (window.__repoOpenFailure) throw { code:'repo.not_git', message:'Le dossier choisi ne contient pas de dépôt Git.' }; return repo; },
    repo_clone: (args) => { (window.__cloneCalls ??= []).push(args.request); if (window.__cloneFailure) throw { code:'repo.clone_failed', message:'Le clonage a échoué.' }; return { ...repo, repo:{ ...repo.repo, repoId:'repo_cloned', name:'cloned-demo', worktree:args.request.destination }, state:{ ...repo.state, operation:null, conflicts:{ files:[] }, worktree:{ staged:0, unstaged:0, untracked:0, conflicted:0 } }, generation:2 }; },
    repo_init: (args) => {
      (window.__initCalls ??= []).push(args.request)
      if (window.__initFailure) throw { code:'init.failed', message:'La création du dépôt a échoué.' }
      return { ...repo,
        repo: { ...repo.repo, repoId:'repo_initialized', name: args.request.destination.split(/[\\\\/]/).pop(), worktree: args.request.destination },
        state: { ...repo.state, operation:null, conflicts:{ files:[] }, worktree:{ staged:0, unstaged:0, untracked:0, conflicted:0 } },
        generation: 3 }
    },
    repo_list_open: () => [repo.repo],
    repo_get_state: (args) => {
      (window.__stateCalls ??= []).push(args)
      return {
        ...repo,
        generation: window.__generationOverride ?? repo.generation,
        state: {
          ...repo.state,
          operation: window.__operationOverride === undefined ? repo.state.operation : window.__operationOverride,
          conflicts: window.__conflictsOverride ?? repo.state.conflicts,
          worktree: window.__worktreeOverride ?? repo.state.worktree,
        },
      };
    },
    repo_refresh: () => ({
      ...repo,
      state: {
        ...repo.state,
        operation: window.__operationOverride === undefined ? repo.state.operation : window.__operationOverride,
        conflicts: window.__conflictsOverride ?? repo.state.conflicts,
        worktree: window.__worktreeOverride ?? repo.state.worktree,
      },
    }),
    status_get: () => ({ data: status, generation: 1 }),
    refs_get: () => ({ data: refs, generation: 1 }),
    commit_get: (args) => ({
      data: { ...commit, summary: { ...commit.summary, sha: args.sha ?? commit.summary.sha } },
      generation: 1,
    }),
    diff_get: (args) => {
      (window.__diffCalls ??= []).push(args)
      const path = args.request?.path
      // A path filter returns exactly that file, like the backend does, so the
      // embedded preview never repeats the file sidebar.
      const files = path
        ? [{
            ...(diff.files.find((file) => file.newPath === path || file.oldPath === path) ?? diff.files[0]),
            oldPath: path,
            newPath: path,
          }]
        : diff.files
      return { data: { ...diff, files }, generation: 1 }
    },
    file_content_get: (args) => {
      (window.__contentCalls ??= []).push(args)
      return {
        path: args.request.path,
        revision: args.request.revision ?? 'worktree',
        content: '# Notes du fichier\\n\\nUn paragraphe **important** avec du \`code\`.\\n\\n- premier point\\n- second point\\n\\n| Clé | Valeur |\\n| --- | --- |\\n| rendu | Markdown |\\n\\n[documentation](https://example.test/doc)\\n\\n![capture](https://example.test/capture.png)\\n\\n<script>window.__markdownInjected = true</script>\\n',
        bytes: 320,
        truncated: false,
        binary: false,
      }
    },
    graph_page: (args) => args.request && args.request.after
      ? { commits: [], rows: [], generation: 1, truncated: false }
      : { commits, rows, next: undefined, generation: 1, truncated: false },
    recovery_list: () => [],
    operation_journal: () => [],
    preference_get: () => null,
    preference_set: (args) => { (window.__preferenceSets ??= []).push(args); return null },
    tools_detect: () => ({ editors: [], terminals: [], diffTools: [], mergeTools: [], configured: [] }),
    stash_list: () => [],
    worktree_list: () => ({ mainWorktree: '/tmp/beebranch-demo', entries: [
      { path: '/tmp/beebranch-demo', head: commits[0].sha, branch: 'main', bare: false, detached: false, main: true, changedFiles: 3, dirty: true },
      { path: '/tmp/beebranch-demo-hotfix', head: commits[3].sha, branch: 'fix/hotfix', bare: false, detached: false, main: false, changedFiles: 0, dirty: false },
    ] }),
    tag_list: () => ([
      { name: 'v0.1', oid: commits[5].sha, objectType: 'tag', annotated: true, targetOid: commits[5].sha, message: 'Release', tagger: 'Alice', taggerTime: 1700000000 },
    ]),
    remote_list: () => ([
      { name: 'origin', fetchUrl: 'git@example.test:team/demo.git', pushUrl: 'git@example.test:team/demo.git' },
    ]),
    submodule_list: () => ({ entries: [
      { path: 'vendor/sdk', sha: commits[2].sha, state: 'upToDate', describe: 'v1.2.0', nested: false },
    ], truncated: false }),
    profiles_list: () => ({ profiles: [
      { id: 'profile-1', name: 'Travail', userName: 'Alice', userEmail: 'alice@example.test', defaultPull: 'rebase', createdAt: 1700000000 },
    ], activeId: 'profile-1' }),
    commit_identity: () => ({ name: 'Alice', email: 'alice@example.test' }),
    file_history_get: () => ({ path: 'src/main.rs', follow: true, truncated: false, entries: [
      { sha: commits[0].sha, author: 'Alice', authorMail: 'a@b.c', authorTime: 1700000000, subject: 'first', status: 'M' },
    ] }),
    blame_get: () => ({ path: 'src/main.rs', truncated: false, firstLine: 1, lastLine: 2, lines: [
      { line: 1, sha: commits[0].sha, author: 'Alice', authorMail: 'a@b.c', authorTime: 1700000000, summary: 'first', content: 'fn main()', previous: undefined, groupStart: true },
      { line: 2, sha: commits[0].sha, author: 'Alice', authorMail: 'a@b.c', authorTime: 1700000000, summary: 'first', content: '{}', previous: undefined, groupStart: false },
    ] }),
    conflict_get: () => ({ path: 'src/main.rs', eol: 'lf', hasMarkers: true, markerLines: [1, 3, 5], resolved: false, binary: false, tooLarge: false,
      ours: { content: 'ours\\n', bytes: 5, truncated: false },
      theirs: { content: 'theirs\\n', bytes: 7, truncated: false },
      working: { content: '<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> theirs\\n', bytes: 43, truncated: false } }),
    search_paths: () => ({ items: [{ path: 'src/main.rs' }], truncated: false, limit: 300 }),
    search_content: () => ({ items: [{ path: 'src/main.rs', line: 1, text: 'fn main()' }], truncated: false, limit: 300 }),
    search_commits: () => ({ commits: [commits[0]], generation: 1, depth: 5000, truncated: false, mode: 'message' }),
    operation_cancel: () => true,
    conflict_save: (args) => { (window.__p2Calls ??= []).push(['conflict_save', args]); return { data: { path: 'src/main.rs', eol: 'lf', hasMarkers: false, markerLines: [], resolved: true, binary: false, tooLarge: false, ours: { content: 'ours\\n', bytes: 5, truncated: false }, theirs: { content: 'theirs\\n', bytes: 7, truncated: false }, working: { content: 'ours\\n', bytes: 5, truncated: false } }, generation: 2, state: repo.state }; },
    commit_config: () => ({ name: 'Alice', email: 'alice@example.test', signing: false }),
    commit_create: (args) => {
      (window.__amendCalls ??= []).push(args.request)
      return {
        data: {
          sha: commits[8].sha,
          output: 'Amended HEAD',
          signed: false,
          config: { name: 'Alice', email: 'alice@example.test', signing: false },
        },
        generation: 2,
        state: repo.state,
      };
    },
    index_stage: (args) => { (window.__p1Calls ??= []).push(['stage', args]); return { data: { files: ['src/module-1.ts'], hunks: 1, patchBytes: 42 }, generation: 2, state: repo.state }; },
    index_unstage: (args) => { (window.__p1Calls ??= []).push(['unstage', args]); return { data: { files: [], hunks: 0, patchBytes: 0 }, generation: 2, state: repo.state }; },
    index_discard: (args) => { (window.__p1Calls ??= []).push(['discard', args]); return { data: { files: [], hunks: 0, patchBytes: 0 }, generation: 2, state: repo.state } },
    gitlab_status: () => ({
      connected: true,
      instance: { id: 'gl_demo', baseUrl: 'https://gitlab.example.test', displayName: 'GitLab' },
      user: { id: 1, username: 'alice', name: 'Alice', avatarUrl: undefined },
    }),
    gitlab_projects_page: () => ({
      items: [{
        id: 42,
        name: 'payment-platform',
        pathWithNamespace: 'team/payment-platform',
        webUrl: 'https://gitlab.example.test/team/payment-platform',
        sshUrlToRepo: 'git@gitlab.example.test:team/payment-platform.git',
        httpUrlToRepo: 'https://gitlab.example.test/team/payment-platform.git',
        defaultBranch: 'main',
        lastActivityAt: undefined,
        description: undefined,
      }],
      page: 1,
      perPage: 50,
      nextPage: undefined,
      total: 1,
      notModified: false,
      fromCache: false,
    }),
    gitlab_repo_link_get: () => null,
    gitlab_mr_page: () => ({ items: [], page: 1, perPage: 25, nextPage: undefined, notModified: false, fromCache: false }),
    github_status: () => ({
      connected: true,
      instance: { id: 'gh_demo', baseUrl: 'https://github.com', displayName: 'GitHub' },
      user: { id: 2, username: 'octocat', name: 'Octocat', avatarUrl: undefined },
    }),
    github_projects_page: () => ({
      items: [{
        id: 84,
        name: 'beebranch-demo',
        pathWithNamespace: 'team/beebranch-demo',
        webUrl: 'https://github.com/team/beebranch-demo',
        sshUrlToRepo: 'git@github.com:team/beebranch-demo.git',
        httpUrlToRepo: 'https://github.com/team/beebranch-demo.git',
        defaultBranch: 'main',
        lastActivityAt: undefined,
        description: undefined,
      }],
      page: 1, perPage: 50, nextPage: undefined, total: 1, notModified: false, fromCache: false,
    }),
    github_repo_link_get: () => null,
    github_pr_page: () => ({ items: [], page: 1, perPage: 25, nextPage: undefined, notModified: false, fromCache: false }),
    undo_status: () => ({
      undo: { id: 'undo_1', kind: 'commit', label: 'commit abc123', state: 'available',
        createdAt: 1700000000, position: 1, undoLabel: 'Annuler commit abc123.' },
      redo: null, failed: [], recent: [],
    }),
    undo_list: () => [],
    undo_failed: () => [],
    undo_acknowledge: () => true,
    undo_apply: (args) => {
      (window.__p3Calls ??= []).push(['undo_apply', args])
      return { record: { id: 'undo_1', kind: 'commit', label: 'commit abc123', state: 'consumed',
        createdAt: 1700000000, position: 1, redoLabel: 'Rétablir commit abc123.' },
        generation: 2, state: repo.state, message: 'Annulé : commit abc123.' }
    },
    redo_apply: (args) => {
      (window.__p3Calls ??= []).push(['redo_apply', args])
      return { record: { id: 'undo_1', kind: 'commit', label: 'commit abc123', state: 'available',
        createdAt: 1700000000, position: 1, undoLabel: 'Annuler commit abc123.' },
        generation: 3, state: repo.state, message: 'Rétabli : commit abc123.' }
    },
    branch_integration_preview: (args) => {
      (window.__p3Calls ??= []).push(['branch_integration_preview', args])
      return {
        source: args.request.source, target: args.request.target, mode: args.request.mode,
        sourceSha: commits[12].sha, targetSha: commits[0].sha,
        ahead: 3, behind: 1, fastForward: args.request.mode === 'merge' && args.request.target === 'main', currentBranch: 'main',
        requiresCheckout: args.request.target !== 'main', worktreeDirty: false,
        applicable: true,
      }
    },
    branch_integration_start: (args) => {
      (window.__p3Calls ??= []).push(['branch_integration_start', args])
      return { data: { preview: { source: args.request.source, target: args.request.target,
          mode: args.request.mode, sourceSha: commits[12].sha, targetSha: commits[0].sha,
          ahead: 3, behind: 1, fastForward: false, requiresCheckout: true, worktreeDirty: false,
          applicable: true }, checkedOutTarget: true, originalBranch: 'main',
          outcome: { state: repo.state, output: '', conflicted: false } },
        generation: 2, state: repo.state }
    },
    rebase_candidates: () => ({
      upstream: 'main',
      candidates: [commits[3], commits[2], commits[1]],
    }),
    history_rebase_interactive: (args) => {
      (window.__p3Calls ??= []).push(['history_rebase_interactive', args])
      return { data: { state: repo.state, output: '', conflicted: false }, generation: 2, state: repo.state }
    },
    workspace_list: () => ([{
      id: 'ws_demo', name: 'Produit', createdAt: 1700000000, updatedAt: 1700000000,
      repos: [
        { path: '/tmp/beebranch-demo', name: 'beebranch-demo', addedAt: 1700000000 },
        { path: '/tmp/beebranch-api', name: 'beebranch-api', addedAt: 1700000001 },
      ],
    }]),
    workspace_status: () => ([
      { path: '/tmp/beebranch-demo', name: 'beebranch-demo', available: true,
        repoId: 'repo_demo', state: repo.state },
      { path: '/tmp/beebranch-api', name: 'beebranch-api', available: false,
        error: 'dépôt déplacé' },
    ]),
    workspace_sync: (args) => {
      (window.__p3Calls ??= []).push(['workspace_sync', args])
      return [
        { path: '/tmp/beebranch-demo', name: 'beebranch-demo', repoId: 'repo_demo', ok: true,
          message: 'fetch ok', state: repo.state },
        { path: '/tmp/beebranch-api', name: 'beebranch-api', ok: false,
          message: 'dépôt déplacé', errorCode: 'repo.not_git' },
      ]
    },
    workspace_create: () => ({ id: 'ws_new', name: 'Nouveau', createdAt: 1, updatedAt: 1, repos: [] }),
    workspace_rename: () => ({ id: 'ws_demo', name: 'Renommé', createdAt: 1, updatedAt: 1, repos: [] }),
    workspace_delete: () => true,
    workspace_add_repo: () => ({ id: 'ws_demo', name: 'Produit', createdAt: 1, updatedAt: 1, repos: [] }),
    workspace_remove_repo: () => ({ id: 'ws_demo', name: 'Produit', createdAt: 1, updatedAt: 1, repos: [] }),
    update_status: () => ({
      currentVersion: '0.4.0',
      endpoint: 'https://github.com/Methamorphe/beebranch/releases/latest/download/latest.json',
      rollbackEndpoint: 'https://github.com/Methamorphe/beebranch/releases/latest/download/rollback.json',
      signatureRequired: true, platform: 'macos-aarch64',
    }),
    update_check: () => (window.__scenarioUpdateAvailable ? { currentVersion: '0.4.0', version: '0.4.1', publishedAt: '2026-10-28T10:00:00Z', notes: '## BeeBranch 0.4.1\\n\\n- **Graphe** plus lisible\\n- rendu \`Markdown\` des notes', downloadUrl: 'https://example.test/BeeBranch.app.tar.gz', rollback: false } : null),
    update_install: () => {
      (window.__p3Calls ??= []).push(['update_install', null])
      setTimeout(() => window.__emitTauriEvent?.('update://progress', { downloaded: 64, total: 256 }), 60)
      return new Promise((resolve) => setTimeout(() => resolve({ previousVersion: '0.4.0', installedVersion: '0.4.1', restarting: true }), 300))
    },
    update_rollback: () => ({ previousVersion: '0.4.1', installedVersion: '0.4.0', restarting: true }),
    diagnostics_export: () => '{}',
    'plugin:dialog|open': (args) => { (window.__pickerCalls ??= []).push(args.options); if (window.__pickerDeferred) return new Promise((resolve) => { window.__pickerResolve = resolve }); return window.__pickerSelection ?? null; },
    'plugin:event|listen': (args) => {
      const handlersByEvent = (window.__eventHandlers ??= new Map())
      const list = handlersByEvent.get(args.event) ?? []
      list.push(args.handler)
      handlersByEvent.set(args.event, list)
      return args.handler
    },
    'plugin:event|unlisten': (args) => {
      const handlersByEvent = window.__eventHandlers
      if (handlersByEvent) {
        const list = handlersByEvent.get(args.event) ?? []
        handlersByEvent.set(args.event, list.filter((id) => id !== args.eventId))
      }
      return null
    },
  };
  let callbackId = 1;
  const callbacks = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__emitTauriEvent = (event, payload) => {
    for (const id of [...(window.__eventHandlers?.get(event) ?? [])]) {
      callbacks.get(id)?.callback({ event, id, payload })
    }
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback, once) {
      const id = callbackId++;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    invoke(command, args) {
      const handler = handlers[command];
      if (!handler) return Promise.reject({ code: 'ipc.unavailable', message: 'mock: ' + command });
      try { return Promise.resolve(handler(args ?? {})); }
      catch (error) { return Promise.reject(error); }
    },
  };
})();
`
}

async function connect(port, state) {
  let target
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (state?.exit) {
      throw new Error(
        `Chrome exited (${JSON.stringify(state.exit)}) before exposing DevTools: ${state.stderr.trim().slice(-1500) || 'no stderr'}`,
      )
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
      if (target) break
    } catch {}
    await delay(100)
  }
  if (!target) {
    throw new Error(
      `Chrome DevTools target not found after 30s: ${state?.stderr.trim().slice(-1500) || 'no stderr'}`,
    )
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen
    socket.onerror = reject
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else done(message.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((done, reject) => {
      id += 1
      const requestId = id
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timed out: ' + method)) }, 15_000)
      pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); reject(error) } })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { send, close: () => socket.close() }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  return result.result.value
}

async function screenshot(client, name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
  const path = join(outDir, name)
  await writeFile(path, Buffer.from(data, 'base64'))
  return path
}

async function waitFor(client, expression, label, timeout = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(client, expression)) return
    await delay(100)
  }
  throw new Error(`timeout waiting for ${label}: ${await evaluate(client, "document.body.innerText.slice(0, 1800)")}`)
}

const count = 800
const commits = Array.from({ length: count }, (_, index) => ({
  sha: sha(index + 1),
  parents: index + 1 < count ? [sha(index + 2)] : [],
  author: { name: index % 3 === 0 ? 'Alice' : index % 3 === 1 ? 'Bob' : 'Chloé', email: 'a@b.c', timestamp: 1_700_000_000 + index * 60 },
  committer: { name: 'Alice', email: 'a@b.c', timestamp: 1_700_000_000 + index * 60 },
  refs: index === 0 ? ['HEAD -> main', 'origin/main', 'origin/HEAD', 'feature/group', 'origin/feature/deep', 'origin/collision', 'tag: main'] : index === 3 ? ['synced', 'origin/synced'] : index === 6 ? ['behind'] : index === 7 ? ['origin/behind'] : index === 8 ? ['other', 'origin/topic'] : index === 18 ? ['origin/hotfix'] : index === 12 ? ['feature'] : index === 5 ? ['tag: v0.1'] : [],
  subject: `Commit ${index + 1} — ${['fix graph lanes', 'add diff window', 'wire session watcher', 'document benchmarks'][index % 4]}`,
}))
// A deterministic two-lane history: a merge every six rows, with the side
// branch travelling on lane 1 until it joins lane 0 on the parent's row. The
// layout is what the Rust lane algorithm emits, so the graph proof covers
// forks and merges instead of a single straight line.
const rail = (lane, fromTop, toBottom) => ({ lane, fromTop, toBottom })
const rows = commits.map((commit, index) => {
  if (commit.parents.length === 0) {
    return { nodeLane: 0, laneCount: 1, rails: [rail(0, true, false)], arrivals: [], departures: [], overflow: false }
  }
  const phase = index % 6
  if (phase === 0) {
    // Merge: the second parent opens lane 1 below the row.
    return { nodeLane: 0, laneCount: 2, rails: [rail(0, false, true), rail(1, false, true)], arrivals: [], departures: [1], overflow: false }
  }
  if (phase === 4) {
    // The shared parent: lane 1 curves into lane 0 above the centerline.
    return { nodeLane: 0, laneCount: 2, rails: [rail(0, true, true), rail(1, true, false)], arrivals: [1], departures: [], overflow: false }
  }
  if (phase === 5) {
    return { nodeLane: 0, laneCount: 1, rails: [rail(0, true, true)], arrivals: [], departures: [], overflow: false }
  }
  // Side-branch commits: their line keeps lane 1 down to the shared parent.
  return { nodeLane: 1, laneCount: 2, rails: [rail(0, true, true), rail(1, true, true)], arrivals: [], departures: [], overflow: false }
})
const diffLines = Array.from({ length: 4000 }, (_, index) =>
  index === 3
    ? `    // ${'horizontal-scroll-probe '.repeat(40)}`
    : index % 7 === 0
      ? `// section ${index}`
      : index % 11 === 0
        ? `    let value_${index} = compute(${index});`
        : `    render_row(${index}, "windowed diff payload");`,
)

await mkdir(outDir, { recursive: true })
const server = await serve()
const port = server.address().port
const debugProbe = createServer()
await new Promise((ready) => debugProbe.listen(0, '127.0.0.1', ready))
const debugPort = debugProbe.address().port
await new Promise((closed) => debugProbe.close(closed))
const profile = join(outDir, 'chrome-profile')
const browserState = { stderr: '', exit: null }
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
browser.stderr.on('data', (chunk) => {
  browserState.stderr = `${browserState.stderr}${chunk}`.slice(-4000)
})
browser.on('exit', (code, signal) => {
  browserState.exit = { code, signal }
})

try {
  const client = await connect(debugPort, browserState)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  const injected = mockScript(commits, rows, diffLines)
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: injected })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await waitFor(client, `document.body.innerText.includes('Ouvrir un dépôt')`, 'home')
  const homeCreateAction = await evaluate(client, `[...document.querySelectorAll('button')].some((item) => item.textContent.includes('Créer un dépôt…'))`)
  if (!homeCreateAction) throw new Error('create repository action missing from the empty state')
  const cloneForm = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Cloner un dépôt'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!cloneForm) throw new Error('clone action missing from the empty state')
  await waitFor(client, `document.body.innerText.includes('Projets GitLab accessibles')`, 'clone project picker')
  await waitFor(client, `document.body.innerText.includes('team/payment-platform')`, 'GitLab project list')
  const projectPicked = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('team/payment-platform'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!projectPicked) throw new Error('project selection failed')
  await waitFor(client, `document.body.innerText.toLowerCase().includes('dépôt sélectionné')`, 'selected project summary')
  const selectedUrl = await evaluate(client, `document.body.innerText.includes('git@gitlab.example.test:team/payment-platform.git') || document.body.innerText.includes('https://gitlab.example.test/team/payment-platform.git')`)
  if (!selectedUrl) throw new Error('project URL was not filled')
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Annuler')
    if (button) button.click()
  })()`)
  const projectPicker = { projectPicked, selectedUrl }
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Annuler')
    if (button) button.click()
  })()`)
  await evaluate(client, `document.querySelectorAll('button').length`)
  const opened = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('beebranch-demo'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!opened) {
    throw new Error('recent repository button not found')
  }

  await waitFor(client, `document.querySelector('canvas') !== null`, 'graph canvas')
  await delay(500)
  const graphStats = await evaluate(client, `({
    stats: window.__beebranchGraphStats ?? null,
    firstPage: performance.getEntriesByName('graph.first-page').length,
    rows: document.querySelector('canvas').getAttribute('aria-label'),
  })`)
  // A filesystem change reported by the backend watcher must refresh the
  // cached repository state, so the local-modifications row appears without a
  // manual fetch.
  const beforeStateCalls = await evaluate(client, `(() => {
    window.__worktreeOverride = { staged: 2, unstaged: 1, untracked: 0, conflicted: 0 }
    window.__generationOverride = 2
    const before = (window.__stateCalls ?? []).length
    window.__emitTauriEvent('repo://changed', {
      repoId: 'repo_demo', generation: 2, areas: ['worktree', 'state'],
    })
    return before
  })()`)
  await waitFor(
    client,
    `document.body.innerText.includes('2 préparé(s) · 1 modifié(s) · 0 nouveau(x)')`,
    'worktree summary refresh without fetch',
  )
  const afterStateCalls = await evaluate(client, `(window.__stateCalls ?? []).length`)
  if (afterStateCalls <= beforeStateCalls) {
    throw new Error(
      'repo://changed on a worktree change must call repo_get_state: ' +
        JSON.stringify({ beforeStateCalls, afterStateCalls }),
    )
  }
  await evaluate(client, `(() => {
    window.__worktreeOverride = null
    window.__generationOverride = 3
    window.__emitTauriEvent('repo://changed', {
      repoId: 'repo_demo', generation: 3, areas: ['worktree', 'state'],
    })
  })()`)
  await waitFor(
    client,
    `document.body.innerText.includes('8 préparé(s) · 16 modifié(s) · 5 nouveau(x)')`,
    'worktree summary restored',
  )
  const repoChangeRefresh = { beforeStateCalls, afterStateCalls }
  await evaluate(client, `document.fonts.ready.then(() => true)`)
  const typography = await evaluate(client, `({
    body: getComputedStyle(document.body).fontFamily,
    size: getComputedStyle(document.body).fontSize,
    uiLoaded: document.fonts.check('13px "Open Sans"'),
    monoLoaded: document.fonts.check('12px "Geist Mono Variable"'),
  })`)
  if (!typography.body.includes('Open Sans') || !typography.uiLoaded || !typography.monoLoaded) {
    throw new Error('bundled fonts missing: ' + JSON.stringify(typography))
  }
  const contrast = await evaluate(client, `(() => {
    const parse = (value) => {
      const start = value.indexOf('(')
      const end = value.indexOf(')')
      if (start < 0 || end <= start) return null
      const parts = value.slice(start + 1, end).split(',').map((part) => Number.parseFloat(part))
      return [parts[0], parts[1], parts[2], parts[3] ?? 1]
    }
    const luminance = (rgb) => {
      const [r, g, b] = rgb.slice(0, 3).map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (fg, bg) => {
      const a = luminance(fg)
      const b = luminance(bg)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const sample = () => {
      const button = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Historique'))
      const aside = document.querySelector('aside')
      if (!button || !aside) return { missing: true, button: Boolean(button), aside: Boolean(aside) }
      return {
        color: getComputedStyle(button).color,
        background: getComputedStyle(aside).backgroundColor,
        ratio: ratio(parse(getComputedStyle(button).color), parse(getComputedStyle(aside).backgroundColor)),
      }
    }
    const freeze = document.createElement('style')
    freeze.textContent = '* { transition: none !important; }'
    document.head.append(freeze)
    document.documentElement.dataset.theme = 'dark'
    const dark = sample()
    document.documentElement.dataset.theme = 'light'
    const light = sample()
    document.documentElement.dataset.theme = 'dark'
    freeze.remove()
    return { dark, light }
  })()`)
  if (!contrast || contrast.dark.ratio < 7 || contrast.light.ratio < 7) {
    throw new Error('sidebar contrast below target: ' + JSON.stringify(contrast))
  }
  const graphPath = await screenshot(client, 'p0-graph.png')

  const initialColumns = await evaluate(client, `(() => {
    const columns = document.querySelector('canvas').parentElement.parentElement.firstElementChild
    return {
      author: columns.children[3].getBoundingClientRect().width,
      authorHeader: columns.children[3].textContent,
      date: columns.children[4].getBoundingClientRect().width,
      dateHeader: columns.children[4].textContent,
    }
  })()`)
  if (!(initialColumns.author >= 90 && initialColumns.authorHeader === 'Auteur' && initialColumns.date >= 120 && initialColumns.dateHeader === 'Date')) {
    throw new Error('graph author/date columns missing at full width: ' + JSON.stringify(initialColumns))
  }

  // Picking two commits in the graph must offer an A→B comparison that asks
  // the backend for a `range` diff and shows the comparison view.
  const openGraphOptions = async () => evaluate(client, `(() => {
    const trigger = document.querySelector('button[aria-label="Options d’affichage du graphe"]')
    if (!trigger) return false
    trigger.click()
    return true
  })()`)
  const toggleMultiSelect = async () => evaluate(client, `(() => {
    const label = [...document.querySelector('[popover]:popover-open').querySelectorAll('label')].find((item) => item.textContent.includes('Sélection multiple'))
    const box = label?.querySelector('input[type="checkbox"]')
    if (!box) return false
    box.click()
    return true
  })()`)
  if (!(await openGraphOptions())) throw new Error('graph display options missing')
  await waitFor(client, `document.querySelector('[popover]:popover-open') !== null`, 'graph display options')
  if (!(await toggleMultiSelect())) throw new Error('multi-select toggle missing')
  await evaluate(client, `document.querySelector('button[aria-label="Options d’affichage du graphe"]').click()`)
  await waitFor(client, `document.querySelector('[popover]:popover-open') === null`, 'graph display options closed')
  const uxChecks = {}
  const assertUI = (name, value) => {
    uxChecks[name] = Boolean(value)
    if (!value) throw new Error('UX regression: ' + name)
  }
  const pickCommitRow = async (index, shift = false, meta = false) => evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const box = canvas.getBoundingClientRect()
    const x = box.left + Math.max(120, box.width * 0.55)
    const y = box.top + ${index} * 30 + 15
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, shiftKey: ${shift}, metaKey: ${meta} }))
    }
    return true
  })()`)
  await pickCommitRow(0)
  await waitFor(client, `document.body.innerText.includes('1 commit(s) sélectionné(s)')`, 'first picked commit')
  assertUI('selection-has-no-order-bar', await evaluate(client, `!document.body.innerText.includes('Ordre :')`))
  await pickCommitRow(1)
  await waitFor(client, `document.body.innerText.includes('2 commit(s) sélectionné(s)')`, 'second picked commit')
  const compareClicked = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Comparer') && item.textContent.includes('→'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!compareClicked) throw new Error('compare action missing for two picked commits')
  // The comparison must not leave the history: the tree stays rendered and the
  // A→B panel docks in the inspector, like a git client's right-hand pane.
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') !== null`, 'comparison inspector')
  // The comparison gets the graph's height: the history fills its wrapper.
  assertUI('comparison-graph-fills-wrapper', await evaluate(client, `(() => {
    const wrap = document.querySelector('canvas').closest('div[class*=wrap]')
    const scroll = wrap.querySelector('div[class*=scroll]')
    return Math.abs(wrap.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom) < 1
  })()`))
  await waitFor(client, `(window.__diffCalls ?? []).some((call) => call.request?.target === 'range')`, 'range diff request')
  const compareFrame = await evaluate(client, `({
    heading: document.querySelector('main h1')?.textContent,
    graph: document.querySelector('canvas')?.closest('[hidden]') === null,
    files: document.querySelectorAll('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button').length,
    inlineDiff: document.querySelector('aside[aria-label="Comparaison"] [aria-label^="Diff de"]') !== null,
    preview: document.querySelector('[aria-label="Aperçu des modifications"]') !== null,
  })`)
  if (compareFrame.heading !== 'Historique' || !compareFrame.graph || compareFrame.files < 1 || compareFrame.inlineDiff || compareFrame.preview) {
    throw new Error('comparison must keep the history and leave its patch out of the inspector: ' + JSON.stringify(compareFrame))
  }
  const compareReport = await evaluate(client, `(() => {
    const call = [...window.__diffCalls].reverse().find((entry) => entry.request?.target === 'range')
    return {
      base: call?.request.base,
      target: call?.request.targetRef,
      expectedBase: ${JSON.stringify(sha(1))},
      expectedTarget: ${JSON.stringify(sha(2))},
      label: document.body.innerText.includes(${JSON.stringify(sha(1).slice(0, 8) + '…' + sha(2).slice(0, 8))}),
    }
  })()`)
  if (compareReport.base !== compareReport.expectedBase || compareReport.target !== compareReport.expectedTarget || !compareReport.label) {
    throw new Error('two-commit comparison mismatch: ' + JSON.stringify(compareReport))
  }
  // Picking a file opens its patch in the history region, where it has room to
  // be read; the file list stays docked in the inspector.
  const filePicked = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button')]
      .find((item) => item.title?.includes('src/pair.ts'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!filePicked) throw new Error('comparison file rows missing')
  await waitFor(client, `document.querySelector('[aria-label="Aperçu des modifications"]')?.innerText.includes('src/pair.ts') ?? false`, 'comparison patch in the history region')
  await waitFor(client, `performance.getEntriesByName('diff.first-paint').length > 0`, 'comparison diff render')
  const patchFrame = await evaluate(client, `(() => {
    const preview = document.querySelector('[aria-label="Aperçu des modifications"]')
    const box = preview?.getBoundingClientRect()
    const calls = (window.__diffCalls ?? []).filter((entry) => entry.request?.target === 'range' && entry.request.path === 'src/pair.ts')
    return {
      graphHidden: document.querySelector('canvas')?.closest('[hidden]') !== null,
      width: Math.round(box?.width ?? 0),
      path: calls.at(-1)?.request?.path ?? null,
      emphasis: preview?.querySelectorAll('[data-diff-emphasis="word"]').length ?? 0,
      listOpen: document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"]') !== null,
      current: document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] [aria-current="true"]')?.title ?? null,
    }
  })()`)
  if (!patchFrame.graphHidden || patchFrame.width < 600 || patchFrame.path !== 'src/pair.ts' || !patchFrame.listOpen) {
    throw new Error('comparison patch did not take the history region: ' + JSON.stringify(patchFrame))
  }
  if (!patchFrame.current?.includes('src/pair.ts')) {
    throw new Error('picked comparison file is not marked in the list: ' + JSON.stringify(patchFrame))
  }
  if (patchFrame.emphasis < 2) {
    throw new Error('paired lines are not emphasised word by word: ' + JSON.stringify(patchFrame))
  }
  await screenshot(client, 'p0-compare-patch.png')
  // Closing the patch restores the graph without dropping the comparison.
  await evaluate(client, `document.querySelector('[aria-label="Aperçu des modifications"] button[aria-label="Fermer l’aperçu"]').click()`)
  await waitFor(
    client,
    `document.querySelector('[aria-label="Aperçu des modifications"]') === null && document.querySelector('canvas')?.closest('[hidden]') === null && document.querySelector('aside[aria-label="Comparaison"]') !== null`,
    'graph restored, comparison kept',
  )
  await screenshot(client, 'p0-compare.png')
  await evaluate(client, `document.querySelector('aside[aria-label="Comparaison"] button[aria-label="Fermer la comparaison"]').click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') === null`, 'comparison closed')
  if (!(await evaluate(client, `document.querySelector('canvas') !== null`))) throw new Error('graph lost after closing the comparison')
  if (!(await openGraphOptions())) throw new Error('graph display options missing after comparison')
  await waitFor(client, `document.querySelector('[popover]:popover-open') !== null`, 'graph display options reopened')
  if (!(await toggleMultiSelect())) throw new Error('multi-select toggle missing after comparison')
  await evaluate(client, `document.querySelector('button[aria-label="Options d’affichage du graphe"]').click()`)
  await waitFor(client, `!document.body.innerText.includes('commit(s) sélectionné(s)')`, 'picks cleared')

  // Shift-clicking a commit after selecting another one must select every
  // commit in between and compare the range (anchor → clicked) in the graph
  // inspector, without touching the options menu.
  await pickCommitRow(0)
  await pickCommitRow(2, true)
  await waitFor(client, `document.body.innerText.includes('3 commit(s) sélectionné(s)')`, 'shift range selection')
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]')?.innerText.includes(${JSON.stringify(sha(1).slice(0, 8) + '…' + sha(3).slice(0, 8))}) ?? false`, 'shift comparison panel')
  await waitFor(client, `(window.__diffCalls ?? []).some((call) => call.request?.target === 'range' && call.request.base === ${JSON.stringify(sha(1))})`, 'shift range diff request')
  const shiftReport = await evaluate(client, `(() => {
    const calls = (window.__diffCalls ?? []).filter((entry) => entry.request?.target === 'range')
    const call = calls[calls.length - 1]
    const panel = document.querySelector('aside[aria-label="Comparaison"]')
    return {
      base: call?.request.base,
      target: call?.request.targetRef,
      expectedBase: ${JSON.stringify(sha(1))},
      expectedTarget: ${JSON.stringify(sha(3))},
      label: document.body.innerText.includes('…'),
      graph: document.querySelector('canvas') !== null,
      title: panel?.querySelector('header span')?.textContent?.trim(),
      caption: panel?.innerText.includes('Diff de 3 commits') ?? false,
      commits: panel?.querySelectorAll('[aria-label="Commits comparés"] li').length,
      newest: panel?.querySelector('[aria-label="Commits comparés"] li')?.textContent?.includes(${JSON.stringify(sha(1).slice(0, 8))}) ?? false,
      oldest: [...(panel?.querySelectorAll('[aria-label="Commits comparés"] li') ?? [])].pop()?.textContent?.includes(${JSON.stringify(sha(3).slice(0, 8))}) ?? false,
      treeDir: panel?.querySelector('[aria-label="Fichiers comparés"] button[aria-expanded]') !== null,
    }
  })()`)
  if (shiftReport.base !== shiftReport.expectedBase || shiftReport.target !== shiftReport.expectedTarget || !shiftReport.label) {
    throw new Error('shift-click comparison mismatch: ' + JSON.stringify(shiftReport))
  }
  if (!shiftReport.graph) throw new Error('shift-click comparison left the history view')
  if (shiftReport.title !== '3 commits sélectionnés' || !shiftReport.caption || shiftReport.commits !== 3) {
    throw new Error('comparison does not list the selected commits: ' + JSON.stringify(shiftReport))
  }
  if (!shiftReport.newest || !shiftReport.oldest) {
    throw new Error('compared commits are not listed newest first: ' + JSON.stringify(shiftReport))
  }
  if (!shiftReport.treeDir) throw new Error('comparison files are not grouped as a tree')
  // Path/Tree toggle and directory collapse must reorganise the same list.
  const pathView = await evaluate(client, `(() => {
    const group = document.querySelector('aside[aria-label="Comparaison"] [aria-label="Présentation des fichiers"]')
    const button = [...(group?.querySelectorAll('button') ?? [])].find((item) => item.textContent.trim() === 'Chemin')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!pathView) throw new Error('path/tree toggle missing')
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button[aria-expanded]') === null`, 'flat file list')
  const flatPaths = await evaluate(client, `[...document.querySelectorAll('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button')].map((item) => item.title)`)
  if (!flatPaths.some((title) => title.includes('src/main.rs'))) {
    throw new Error('flat file list lost the full path: ' + JSON.stringify(flatPaths))
  }
  await evaluate(client, `(() => {
    const group = document.querySelector('aside[aria-label="Comparaison"] [aria-label="Présentation des fichiers"]')
    const button = [...group.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Arborescence')
    if (button) button.click()
  })()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button[aria-expanded="true"]') !== null`, 'tree view restored')
  const collapsed = await evaluate(client, `(() => {
    const group = document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"]')
    const dir = group.querySelector('button[aria-expanded="true"]')
    const before = group.querySelectorAll('button').length
    dir.click()
    return { before }
  })()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button[aria-expanded="false"]') !== null`, 'directory collapsed')
  const afterCollapse = await evaluate(client, `document.querySelectorAll('aside[aria-label="Comparaison"] [aria-label="Fichiers comparés"] button').length`)
  if (!(afterCollapse < collapsed.before)) {
    throw new Error('collapsing a directory does not hide its files: ' + JSON.stringify({ ...collapsed, afterCollapse }))
  }
  await screenshot(client, 'p0-compare-range.png')
  await evaluate(client, `document.querySelector('aside[aria-label="Comparaison"] button[aria-label="Fermer la comparaison"]').click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') === null`, 'shift comparison closed')
  await waitFor(client, `document.querySelector('canvas') !== null && document.body.innerText.includes('3 commit(s) sélectionné(s)')`, 'shift range kept in graph')
  await evaluate(client, `(() => {
    const clear = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Vider')
    if (clear) clear.click()
  })()`)
  await waitFor(client, `!document.body.innerText.includes('commit(s) sélectionné(s)')`, 'shift picks cleared')

  // ⌘/Ctrl+click compares the anchor and the clicked commit only: the four
  // commits in between are neither picked nor listed in the comparison.
  await pickCommitRow(0)
  await waitFor(client, `document.body.innerText.includes('Voir le diff complet')`, 'endpoint anchor selected')
  await pickCommitRow(5, false, true)
  await waitFor(client, `document.body.innerText.includes('2 commit(s) sélectionné(s)')`, 'endpoint pair picked')
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') !== null`, 'endpoint comparison panel')
  await waitFor(
    client,
    `(window.__diffCalls ?? []).some((call) => call.request?.target === 'range' && call.request.base === ${JSON.stringify(sha(1))} && call.request.targetRef === ${JSON.stringify(sha(6))})`,
    'endpoint range diff request',
  )
  const endpointReport = await evaluate(client, `(() => {
    const panel = document.querySelector('aside[aria-label="Comparaison"]')
    const listed = [...(panel?.querySelectorAll('[aria-label="Commits comparés"] li') ?? [])]
      .map((item) => item.querySelector('[title]')?.getAttribute('title'))
    return {
      title: panel?.querySelector('header span')?.textContent?.trim(),
      commits: listed.length,
      listedNewest: listed[0] === ${JSON.stringify(sha(1))},
      listedOldest: listed[1] === ${JSON.stringify(sha(6))},
      skippedMiddle: listed.includes(${JSON.stringify(sha(3))}),
      picked: (document.body.innerText.match(/(\\d+) commit\\(s\\) sélectionné/g) ?? []).join(','),
      preview: document.querySelector('[aria-label="Aperçu des modifications"]') !== null,
    }
  })()`)
  if (endpointReport.title !== '2 commits sélectionnés' || endpointReport.commits !== 2) {
    throw new Error('endpoint comparison does not list exactly two commits: ' + JSON.stringify(endpointReport))
  }
  if (!endpointReport.listedNewest || !endpointReport.listedOldest || endpointReport.skippedMiddle) {
    throw new Error('endpoint comparison must list the two ends only: ' + JSON.stringify(endpointReport))
  }
  if (endpointReport.preview) {
    throw new Error('endpoint comparison must wait for a file click before opening a patch: ' + JSON.stringify(endpointReport))
  }
  await screenshot(client, 'p0-compare-endpoints.png')
  await evaluate(client, `document.querySelector('aside[aria-label="Comparaison"] button[aria-label="Fermer la comparaison"]').click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') === null`, 'endpoint comparison closed')
  await evaluate(client, `(() => {
    const clear = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Vider')
    if (clear) clear.click()
  })()`)
  await waitFor(client, `!document.body.innerText.includes('commit(s) sélectionné(s)')`, 'endpoint picks cleared')

  // Shift+arrow extends the same range from the keyboard.
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    return true
  })()`)
  await delay(80)
  await evaluate(client, `(() => {
    document.querySelector('canvas').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
    )
    return true
  })()`)
  await waitFor(client, `document.body.innerText.includes('2 commit(s) sélectionné(s)') && document.querySelector('aside[aria-label="Comparaison"]') !== null`, 'keyboard range selection')
  await evaluate(client, `document.querySelector('aside[aria-label="Comparaison"] button[aria-label="Fermer la comparaison"]').click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Comparaison"]') === null`, 'keyboard comparison closed')
  await evaluate(client, `(() => {
    const clear = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Vider')
    if (clear) clear.click()
  })()`)
  await waitFor(client, `!document.body.innerText.includes('commit(s) sélectionné(s)')`, 'keyboard picks cleared')

  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Historique'))
    if (button) button.click()
  })()`)
  await evaluate(client, `document.querySelector('button[aria-pressed="false"]')?.click()`)
  await waitFor(client, `document.querySelector('button[title="src/module-1.ts"]') !== null`, 'status rows')
  await screenshot(client, 'p0-status.png')

  // Status file lists: tree view groups rows by folder, collapses them, and
  // remembers the choice.
  await evaluate(client, `document.querySelector('button[aria-label="Options d’affichage des fichiers"]').click()`)
  await waitFor(client, `document.querySelector('[popover]:popover-open') !== null`, 'status display options')
  const treeToggled = await evaluate(client, `(() => {
    const label = [...document.querySelectorAll('[popover] label')].find((item) => item.textContent.includes('Afficher en arborescence'))
    const box = label?.querySelector('input[type="checkbox"]')
    if (!box) return false
    box.click()
    document.querySelector('[popover]')?.hidePopover()
    return true
  })()`)
  if (!treeToggled) throw new Error('tree toggle not found')
  await waitFor(client, `document.querySelector('section[aria-label="À préparer"] button[aria-expanded="true"]') !== null`, 'status tree rows')
  assertUI('status-tree-file-label', await evaluate(client, `document.querySelector('section[aria-label="Prêts à committer"] button[title="src/module-3.ts"]')?.textContent === 'module-3.ts'`))
  await screenshot(client, 'p0-status-tree.png')
  const folderCollapsed = await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('section[aria-label="À préparer"] button[aria-expanded="true"]')].find((item) => item.textContent.includes('src'))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!folderCollapsed) throw new Error('tree folder not found')
  await waitFor(client, `document.querySelector('section[aria-label="À préparer"] button[aria-expanded="false"]') !== null`, 'status folder collapsed')
  assertUI('status-tree-collapsed', await evaluate(client, `document.querySelector('section[aria-label="À préparer"] button[title="src/module-1.ts"]') === null`))
  assertUI('status-tree-preference', await evaluate(client, `(window.__preferenceSets ?? []).some((entry) => entry.input?.key === 'ui.status.view' && entry.input.value === 'tree')`))
  await evaluate(client, `[...document.querySelectorAll('section[aria-label="À préparer"] button[aria-expanded="false"]')].forEach((item) => item.click())`)
  await waitFor(client, `document.querySelector('section[aria-label="À préparer"] button[title="src/module-1.ts"]') !== null`, 'status tree restored')

  const clicked = await evaluate(client, `(() => {
    const button = document.querySelector('section[aria-label="Prêts à committer"] button[title="src/module-3.ts"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('diff button not found')
  await waitFor(client, `performance.getEntriesByName('diff.first-paint').length > 0`, 'diff render')
  await delay(300)
  const diffStats = await evaluate(client, `({
    firstPaint: performance.getEntriesByName('diff.first-paint').length,
    lines: /\d+ lignes/.test(document.body.innerText),
  })`)
  const diffPath = await screenshot(client, 'p0-diff.png')

  await evaluate(client, `(() => {
    const buttons = [...document.querySelectorAll('button')]
    const split = buttons.find((item) => item.textContent.trim() === 'Côte à côte')
    if (split) split.click()
  })()`)
  await delay(200)
  await screenshot(client, 'p0-diff-split.png')

  await evaluate(client, `(() => {
    const box = document.querySelector('input[aria-label="Sélectionner cette ligne"]')
    if (box) box.click()
  })()`)
  const stagedLine = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('la sélection'))
    if (!button) return false
    button.click()
    return true
  })()`)
  await delay(150)
  const p1Calls = await evaluate(client, `window.__p1Calls ?? []`)

  const views = {}
  for (const label of ['Commit', 'Synchronisation', 'Stashes', 'Deep search', 'External tools']) {
    const clickedView = await evaluate(client, `(() => {
      document.querySelectorAll('aside button[aria-expanded="false"]').forEach((item) => item.click())
      const button = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === ${JSON.stringify({"Commit": "Historique", "Stashes": "Stash", "Deep search": "Rechercher", "External tools": "Outils externes", "Resolve conflicts": "Conflits", "Interactive rebase": "Rebase interactif", "Submodules": "Sous-modules", "File history & blame": "Historique de fichier", "Profiles & settings": "Réglages"}[label] ?? label)}))
      if (!button) return false
      button.click()
      return true
    })()`)
    if (label === 'Commit') await evaluate(client, `document.querySelector('button[aria-pressed="false"]')?.click()`)
    await delay(120)
    views[label] = {
      clicked: clickedView,
      text: await evaluate(client, 'document.body.innerText.slice(0, 4000)'),
    }
  }
  await screenshot(client, 'p1-views.png')
  const markers = {
    Commit: ['Nouveau commit', 'Options du commit'],
    Synchronisation: ['Remote et branche', 'Progression'],
    Stashes: ['Créer un stash', 'Stashes'],
    'Deep search': ['Recherche approfondie'],
    'External tools': ['Ouvrir un outil', 'Détection'],
  }
  const viewChecks = Object.fromEntries(
    Object.entries(markers).map(([label, expected]) => [
      label,
      expected.every((needle) => (views[label]?.text ?? '').toLowerCase().includes(needle.toLowerCase())),
    ]),
  )
  if (Object.values(viewChecks).some((value) => !value)) {
    throw new Error('P1 view marker missing: ' + JSON.stringify(viewChecks))
  }

  const p2Views = {}
  for (const label of [
    'Resolve conflicts',
    'Interactive rebase',
    'Worktrees',
    'Tags',
    'Remotes',
    'Submodules',
    'Patches',
    'File history & blame',
    'Profiles & settings',
  ]) {
    const clickedView = await evaluate(client, `(() => {
      document.querySelectorAll('aside button[aria-expanded="false"]').forEach((item) => item.click())
      const button = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === ${JSON.stringify({"Commit": "Historique", "Stashes": "Stash", "Deep search": "Rechercher", "External tools": "Outils externes", "Resolve conflicts": "Conflits", "Interactive rebase": "Rebase interactif", "Submodules": "Sous-modules", "File history & blame": "Historique de fichier", "Profiles & settings": "Réglages"}[label] ?? label)}))
      if (!button) return false
      button.click()
      return true
    })()`)
    await delay(150)
    p2Views[label] = {
      clicked: clickedView,
      text: await evaluate(client, 'document.body.innerText.slice(0, 5000)'),
    }
  }
  const p2Markers = {
    'Resolve conflicts': ['src/main.rs', 'Actuel (ours)', 'theirs'],
    'Interactive rebase': ['Réorganiser les commits', 'Base du rebase'],
    Worktrees: ['Worktrees', 'hotfix', '/tmp/beebranch-demo'],
    Tags: ['Créer un tag', 'v0.1'],
    Remotes: ['Ajouter un remote', 'origin'],
    Submodules: ['Sous-modules', 'vendor/sdk'],
    Patches: ['Patches', 'Provenance'],
    'File history & blame': ['Historique de fichier', 'Blame'],
    'Profiles & settings': ['Apparence', 'Profils', 'Travail'],
  }
  const p2Checks = Object.fromEntries(
    Object.entries(p2Markers).map(([label, expected]) => [
      label,
      expected.every((needle) => (p2Views[label]?.text ?? '').toLowerCase().includes(needle.toLowerCase())),
    ]),
  )
  if (Object.values(p2Checks).some((value) => !value)) {
    throw new Error('P2 view marker missing: ' + JSON.stringify(p2Checks))
  }
  await evaluate(client, `(() => {
    const nav = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Conflits'))
    if (nav) nav.click()
  })()`)
  await delay(150)
  await evaluate(client, `(() => {
    const accept = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Accepter')
    if (accept) accept.click()
  })()`)
  await delay(100)
  const saved = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Marquer résolu'))
    if (!button) return false
    button.click()
    return true
  })()`)
  await delay(200)
  const p2Calls = await evaluate(client, 'window.__p2Calls ?? []')
  if (!saved || p2Calls[0]?.[0] !== 'conflict_save') {
    throw new Error('conflict resolution was not exercised')
  }
  await screenshot(client, 'p2-conflicts.png')
  await evaluate(client, `(() => {
    const nav = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Worktrees'))
    if (nav) nav.click()
  })()`)
  await delay(200)
  await screenshot(client, 'p2-worktrees.png')
  await evaluate(client, `(() => {
    const nav = [...document.querySelectorAll('aside button')].find((item) => !item.hasAttribute('aria-expanded') && [...item.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Tags'))
    if (nav) nav.click()
  })()`)
  await delay(200)
  await screenshot(client, 'p2-tags.png')

  const go = async (view) => {
    const target = view === 'status' ? 'graph' : view
    const found = await evaluate(client, `(() => {
      const button = document.querySelector('aside button[data-view="${target}"]')
      if (!button) return false
      const toggle = button.closest('section').querySelector('button[aria-expanded="false"]')
      if (toggle) toggle.click()
      button.click(); return true
    })()`)
    assertUI('navigate-' + view, found)
    await delay(150)
    if (view === 'graph' || view === 'status') {
      await evaluate(client, `(() => {
        document.querySelector('button[aria-label="Fermer le détail du commit"]')?.click()
        document.querySelector('button[aria-label="Fermer la préparation du commit"]')?.click()
      })()`)
      await delay(50)
      if (view === 'status') {
        await evaluate(client, `document.querySelector('button[aria-pressed="false"]')?.click()`)
        await delay(80)
      }
    }
  }
  // Review every secondary screen at desktop, tablet and narrow widths.
  // Native IPC is mocked; these checks exercise presentation and navigation.
  const layoutReports = []
  assertUI('history-first-navigation-item', await evaluate(client, `document.querySelector('aside button[data-view]')?.dataset.view === 'graph'`))
  for (const width of [1440, 1024, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    })
    for (const view of ['workspaces', 'stash', 'mrs', 'prs', 'search', 'rebase', 'fileHistory', 'worktrees', 'tags', 'remotes', 'submodules', 'patches', 'sync', 'profiles', 'gitlab', 'github', 'tools', 'recovery', 'conflicts']) {
      await go(view)
      const report = await evaluate(client, `(() => {
        const main = document.querySelector('main')
        return {
          overflow: main.scrollWidth > main.clientWidth + 1,
          documentOverflow: document.documentElement.scrollWidth > innerWidth,
          panelOverlaps: [...main.querySelectorAll('section')].some((a, index, sections) => sections.slice(index + 1).some((b) => {
            if (a.contains(b) || b.contains(a)) return false
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
            return ra.width > 0 && rb.width > 0 && Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 2 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 2
          })),
          heading: main.querySelector('h1')?.textContent,
          active: document.querySelector('aside [aria-current="page"]')?.dataset.view,
        }
      })()`)
      layoutReports.push({ width, view, ...report })
      await screenshot(client, 'screen-' + view + '-' + width + '.png')
      await evaluate(client, `(() => {
        const panes = [...document.querySelectorAll('main *')].filter((element) => {
          const style = getComputedStyle(element)
          return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        })
        for (const pane of panes) pane.scrollTop = pane.scrollHeight
      })()`)
      await delay(50)
      await screenshot(client, 'screen-' + view + '-' + width + '-bottom.png')
    }
  }
  await writeFile(join(outDir, 'screen-layouts.json'), JSON.stringify(layoutReports, null, 2))
  assertUI('secondary-panels-do-not-overlap', layoutReports.every((item) => !item.panelOverlaps))
  assertUI('secondary-screens-fit-viewport', layoutReports.every((item) => !item.overflow && !item.documentOverflow))
  assertUI('secondary-screens-show-active-navigation', layoutReports.every((item) => item.active === item.view && item.heading))
  await go('github')
  await waitFor(client, `document.querySelector('main').innerText.includes('Dépôts accessibles')`, 'GitHub repositories panel')
  await waitFor(client, `document.querySelector('main').innerText.includes('team/beebranch-demo')`, 'GitHub repository list')
  assertUI('github-connection-lists-repositories', await evaluate(client, `document.body.innerText.includes('octocat') && document.body.innerText.includes('github.com')`))
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await evaluate(client, `document.documentElement.dataset.theme = 'light'`)
  for (const view of ['workspaces', 'stash', 'mrs', 'prs', 'search', 'rebase', 'fileHistory', 'worktrees', 'tags', 'remotes', 'submodules', 'patches', 'sync', 'profiles', 'gitlab', 'github', 'tools', 'recovery', 'conflicts']) {
    await go(view)
    await screenshot(client, 'screen-' + view + '-light.png')
  }
  await evaluate(client, `document.documentElement.dataset.theme = 'dark'`)
  await go('graph')
  const key = async (value, modifiers = 0) => {
    const code = value === 'Tab' ? 9 : value === 'Escape' ? 27 : value === 'Enter' ? 13 : value === 'ArrowDown' ? 40 : 36
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, windowsVirtualKeyCode: code, modifiers })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, windowsVirtualKeyCode: code, modifiers })
    await delay(60)
  }
  const fill = async (selector, value) => evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // Exercise the lower settings section, including edit/cancel and failed saves.
  await go('profiles')
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    const fixture = { profiles: [{ id:'profile-1', name:'Travail', userName:'Alice', userEmail:'alice@example.test', defaultPull:'rebase', createdAt:1700000000 }], activeId:'profile-1' }
    window.__profileCalls = []
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'profiles_list') return fixture
      if (command === 'profile_delete') {
        fixture.profiles = fixture.profiles.filter((profile) => profile.id !== args.request.id)
        return fixture
      }
      if (command === 'profile_create' || command === 'profile_update') {
        window.__profileCalls.push([command, args])
        if (window.__profileSaveFail) throw { code:'profile.save_failed', message:'Enregistrement impossible. Réessayez.' }
        const input = command === 'profile_create' ? args.input : args.request.input
        if (command === 'profile_create') fixture.profiles.push({ ...input, id:'profile-new', createdAt:1700000001 })
        else fixture.profiles = fixture.profiles.map((profile) => profile.id === args.request.id ? { ...profile, ...input } : profile)
        return fixture
      }
      return original(command, args)
    }
    document.querySelector('form[aria-labelledby="profile-editor-title"]').scrollIntoView({ block:'end' })
  })()`)
  assertUI('profile-empty-form-disabled', await evaluate(client, `document.querySelector('form[aria-labelledby="profile-editor-title"] button[type="submit"]').disabled`))
  await fill('input[name="profileName"]', 'Personnel')
  await fill('input[name="gitName"]', 'Alice Personnel')
  await fill('input[name="gitEmail"]', 'alice.personal@example.test')
  await evaluate(client, `window.__profileSaveFail = true; document.querySelector('form[aria-labelledby="profile-editor-title"]').requestSubmit()`)
  await waitFor(client, `document.body.innerText.includes('Enregistrement impossible')`, 'profile save failure')
  assertUI('profile-failed-save-preserves-fields', await evaluate(client, `document.querySelector('input[name="profileName"]').value === 'Personnel' && !document.querySelector('form button[type="submit"]').disabled`))
  await evaluate(client, `window.__profileSaveFail = false; document.querySelector('form[aria-labelledby="profile-editor-title"]').requestSubmit()`)
  await waitFor(client, `document.body.innerText.includes('Profil créé.')`, 'profile create')
  assertUI('profile-create-correct-payload', await evaluate(client, `window.__profileCalls.some(([command, args]) => command === 'profile_create' && args.input.name === 'Personnel' && args.input.userEmail === 'alice.personal@example.test' && args.input.defaultPull === 'rebase')`))
  assertUI('profile-create-resets-form', await evaluate(client, `document.querySelector('input[name="profileName"]').value === ''`))
  for (const width of [1440, 1024, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false })
    await evaluate(client, `(() => {
      const card = document.querySelector('article[aria-label="Profil Personnel"]')
      ;[...card.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Modifier').click()
    })()`)
    await delay(100)
    const layout = await evaluate(client, `(() => {
      const form = document.querySelector('form[aria-labelledby="profile-editor-title"]')
      const fields = [...form.querySelectorAll('input,select')].map((field) => field.getBoundingClientRect())
      return { fieldsFit: fields.every((rect) => rect.width >= 120 && rect.left >= 0 && rect.right <= innerWidth), aligned: Math.abs(fields[1].height - fields[3].height) < 1, editValue: document.querySelector('input[name="profileName"]').value }
    })()`)
    assertUI('profile-edit-layout-' + width, layout.fieldsFit && layout.aligned && layout.editValue === 'Personnel')
    await screenshot(client, 'profile-edit-' + width + '.png')
  }
  await fill('input[name="profileName"]', 'Personnel modifié')
  await evaluate(client, `document.querySelector('form[aria-labelledby="profile-editor-title"]').requestSubmit()`)
  await waitFor(client, `document.body.innerText.includes('Profil mis à jour.')`, 'profile update')
  assertUI('profile-update-correct-target', await evaluate(client, `window.__profileCalls.some(([command, args]) => command === 'profile_update' && args.request.id === 'profile-new' && args.request.input.name === 'Personnel modifié')`))
  await evaluate(client, `(() => {
    const card = document.querySelector('article[aria-label="Profil Travail"]')
    ;[...card.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Modifier').click()
  })()`)
  await delay(50)
  await evaluate(client, `[...document.querySelectorAll('form[aria-labelledby="profile-editor-title"] button')].find((button) => button.textContent.trim() === 'Annuler').click()`)
  assertUI('profile-cancel-clears-edit', await evaluate(client, `document.querySelector('#profile-editor-title').textContent === 'Créer un profil' && document.querySelector('input[name="profileName"]').value === ''`))
  await evaluate(client, `[...document.querySelectorAll('form[aria-labelledby="profile-editor-title"] button')].find((button) => button.textContent.includes('Utiliser l’instance connectée')).click()`)
  assertUI('profile-select-connected-instance', await evaluate(client, `document.querySelector('input[name="gitlabInstance"]').value === 'gl_demo'`))
  await evaluate(client, `(() => {
    const card = document.querySelector('article[aria-label="Profil Personnel modifié"]')
    ;[...card.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Modifier').click()
  })()`)
  await delay(50)
  await evaluate(client, `document.querySelector('button[aria-label="Supprimer le profil Personnel modifié"]').click()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'delete edited profile confirmation')
  await evaluate(client, `[...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Supprimer').click()`)
  await waitFor(client, `document.body.innerText.includes('Profil supprimé.')`, 'delete edited profile')
  assertUI('profile-delete-exits-edit-mode', await evaluate(client, `document.querySelector('#profile-editor-title').textContent === 'Créer un profil' && document.querySelector('input[name="profileName"]').value === '' && !document.querySelector('article[aria-label="Profil Personnel modifié"]')`))
  await client.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false })

  await go('graph')
  await evaluate(client, `document.querySelectorAll('aside button[aria-expanded="true"]').forEach((button) => button.click())`)
  assertUI('unselected-dirty-history-has-no-panel', await evaluate(client, `!document.querySelector('[aria-label="Préparation du prochain commit"]') && document.querySelector('button[aria-pressed="false"]') !== null`))
  await screenshot(client, 'ux-unselected-history.png')
  await evaluate(client, `document.querySelector('button[aria-pressed="false"]').click()`)
  await delay(100)
  const graphComposer = await evaluate(client, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message de commit"]')
    const b = composer?.getBoundingClientRect()
    return { top:b?.top, bottom:b?.bottom, height:b?.height, viewport:innerHeight, children:[...document.querySelector('[aria-label="Préparation du prochain commit"]').children].map(e => ({ class:e.className, top:e.getBoundingClientRect().top, height:e.getBoundingClientRect().height })) }
  })()`)
  if (!(graphComposer.top > 0 && graphComposer.bottom < graphComposer.viewport)) console.log('composer layout', JSON.stringify(graphComposer))
  assertUI('composer-visible-next-to-graph', graphComposer.top > 0 && graphComposer.bottom < graphComposer.viewport)
  // The viewport canvas must stay pinned even before the next drawing frame.
  // This catches the scroll/transform race that editor repaints could expose.
  const graphWhileTyping = await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const scroll = canvas.parentElement
    scroll.scrollTop = 180
    const before = canvas.getBoundingClientRect()
    scroll.scrollTop = 240
    const after = canvas.getBoundingClientRect()
    return { before:before.top, after:after.top, scroll:scroll.scrollTop }
  })()`)
  assertUI('graph-pinned-before-scroll-redraw', graphWhileTyping.scroll === 240 && Math.abs(graphWhileTyping.before - graphWhileTyping.after) < 1)
  await delay(50)
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const scroll = canvas.parentElement
    const editor = document.querySelector('textarea[aria-label="Message de commit"]')
    window.__commitTypingSamples = []
    window.__sampleCommitTyping = true
    window.__typingCanvas = canvas
    const sample = () => {
      if (!window.__sampleCommitTyping) return
      const rect = canvas.getBoundingClientRect()
      window.__commitTypingSamples.push({ top:rect.top, left:rect.left, width:rect.width, height:rect.height, scroll:scroll.scrollTop, focus:document.activeElement === editor, sameCanvas:document.querySelector('canvas') === canvas })
      requestAnimationFrame(sample)
    }
    editor.focus()
    requestAnimationFrame(sample)
  })()`)
  for (const text of ['fix: ', 'stabiliser ', 'le graphe ', 'pendant la saisie']) {
    await client.send('Input.insertText', { text })
    await delay(30)
  }
  const typingFrames = await evaluate(client, `window.__sampleCommitTyping = false; window.__commitTypingSamples`)
  assertUI('commit-typing-keeps-graph-stable', typingFrames.length > 0 && typingFrames.every((sample) => sample.focus && sample.sameCanvas && sample.scroll === typingFrames[0].scroll && Math.abs(sample.top - typingFrames[0].top) < 1 && Math.abs(sample.left - typingFrames[0].left) < 1 && sample.width === typingFrames[0].width && sample.height === typingFrames[0].height))
  await screenshot(client, 'ux-commit-typing-stable.png')
  await fill('textarea[aria-label="Message de commit"]', '')
  await evaluate(client, `document.querySelector('canvas').parentElement.scrollTop = 0`)

  assertUI('no-dedicated-changes-tab', await evaluate(client, `!document.querySelector('aside button[data-view="status"]')`))
  const density = await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const columns = canvas.parentElement.parentElement.firstElementChild
    const file = document.querySelector('section[aria-label="À préparer"] button[title="src/module-1.ts"]')
    return { firstCommitTop: canvas.getBoundingClientRect().top, visibleCommits: Math.floor(canvas.clientHeight / 30), referencesWidth: columns.children[0].getBoundingClientRect().width, graphWidth: columns.children[1].getBoundingClientRect().width, messageWidth: columns.children[2].getBoundingClientRect().width, authorWidth: columns.children[3].getBoundingClientRect().width, authorHeader: columns.children[3].textContent, dateWidth: columns.children[4].getBoundingClientRect().width, dateHeader: columns.children[4].textContent, fileTextSize: Number.parseFloat(getComputedStyle(file).fontSize), fileRowHeight: file.parentElement.getBoundingClientRect().height }
  })()`)
  assertUI('density-at-least-20-commits', density.visibleCommits >= 20)
  assertUI('density-content-starts-above-220', density.firstCommitTop <= 220)
  assertUI('density-reference-column-bounded', density.referencesWidth <= 220 && density.graphWidth <= 64)
  assertUI('density-message-column-at-least-520', density.messageWidth >= 520)
  assertUI('graph-date-column-visible', density.dateWidth >= 120 && density.dateHeader === 'Date')
  assertUI('density-readable-files', density.fileTextSize >= 14 && density.fileRowHeight <= 30)

  const readColumns = () => evaluate(client, `(() => {
    const columns = document.querySelector('canvas').parentElement.parentElement.firstElementChild
    return {
      refs: columns.children[0].getBoundingClientRect().width,
      graph: columns.children[1].getBoundingClientRect().width,
      message: columns.children[2].getBoundingClientRect().width,
      author: columns.children[3].getBoundingClientRect().width,
      date: columns.children[4].getBoundingClientRect().width,
    }
  })()`)
  const dragSeparator = async (label, dx) => {
    const started = await evaluate(client, `(() => {
      const handle = [...document.querySelectorAll('[role="separator"]')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (!handle) return null
      const rect = handle.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + Math.min(12, rect.height / 2)
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 9, isPrimary: true }))
      return { x, y }
    })()`)
    if (!started) return false
    await delay(90)
    await evaluate(client, `window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${started.x + dx}, clientY: ${started.y}, pointerId: 9, isPrimary: true }))`)
    await delay(90)
    await evaluate(client, `window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${started.x + dx}, clientY: ${started.y}, pointerId: 9, isPrimary: true }))`)
    await delay(150)
    return true
  }

  const columnsBeforeResize = await readColumns()
  assertUI('graph-refs-resizer-available', await dragSeparator('Largeur de la colonne Références', 40))
  const columnsAfterRefs = await readColumns()
  assertUI('graph-refs-column-resizes', columnsAfterRefs.refs - columnsBeforeResize.refs >= 32)
  assertUI('graph-message-yields-width', columnsAfterRefs.message <= columnsBeforeResize.message - 32)

  assertUI('graph-date-resizer-available', await dragSeparator('Largeur de la colonne Date', -24))
  const columnsAfterDate = await readColumns()
  assertUI('graph-date-column-resizes', columnsAfterDate.date - columnsAfterRefs.date >= 18)

  const keyboardStart = await readColumns()
  const keyboardFocused = await evaluate(client, `(() => {
    const handle = [...document.querySelectorAll('[role="separator"]')].find((item) => item.getAttribute('aria-label') === 'Largeur de la colonne Références')
    if (!handle) return false
    handle.focus()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    return document.activeElement === handle
  })()`)
  assertUI('graph-column-keyboard-focus', keyboardFocused)
  await delay(120)
  const keyboardAfter = await readColumns()
  assertUI('graph-column-keyboard-resizes', keyboardAfter.refs - keyboardStart.refs >= 6)

  const resetDispatched = await evaluate(client, `(() => {
    const handle = [...document.querySelectorAll('[role="separator"]')].find((item) => item.getAttribute('aria-label') === 'Largeur de la colonne Date')
    if (!handle) return false
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  assertUI('graph-columns-reset-available', resetDispatched)
  await delay(150)
  const columnsReset = await readColumns()
  assertUI('graph-columns-reset', columnsReset.date <= 130 && columnsReset.refs <= 160)

  const panelBefore = await evaluate(client, `document.querySelector('[aria-label="Préparation du prochain commit"]').getBoundingClientRect().width`)
  assertUI('inspector-resizer-available', await dragSeparator('Redimensionner le panneau latéral', -40))
  const panelAfter = await evaluate(client, `document.querySelector('[aria-label="Préparation du prochain commit"]').getBoundingClientRect().width`)
  assertUI('inspector-resizes', panelAfter - panelBefore >= 30)

  const sidebarBefore = await evaluate(client, `document.querySelector('aside[aria-label="Navigation principale"]').getBoundingClientRect().width`)
  assertUI('sidebar-resizer-available', await dragSeparator('Redimensionner la navigation', 24))
  const sidebarAfter = await evaluate(client, `document.querySelector('aside[aria-label="Navigation principale"]').getBoundingClientRect().width`)
  assertUI('sidebar-resizes', sidebarAfter - sidebarBefore >= 16)
  await waitFor(client, `(window.__preferenceSets ?? []).some((entry) => entry.input?.key === 'ui.layout' && JSON.parse(entry.input.value).sidebar >= ${Math.round(sidebarAfter - 2)})`, 'layout preference persisted')
  await screenshot(client, 'ux-history.png')
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await delay(100)
    for (const corner of ['bottom-right', 'top-left']) {
      await evaluate(client, `(() => {
        const canvas = document.querySelector('canvas'); canvas.focus()
        const bounds = canvas.getBoundingClientRect()
        canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${corner === 'bottom-right' ? width - 3 : 3}, clientY: ${corner === 'bottom-right' ? height - 5 : 'bounds.top + 18'} }))
      })()`)
      await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'context menu')
      await delay(60)
      assertUI('menu-bounds-' + width + '-' + corner, await evaluate(client, `(() => { const b = document.querySelector('[role="menu"]').getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight })()`))
      assertUI('menu-focus-' + width + '-' + corner, await evaluate(client, `document.querySelector('[role="menu"]').contains(document.activeElement)`))
      if (corner === 'bottom-right') await screenshot(client, 'ux-context-menu-' + width + '.png')
      await key('ArrowDown')
      await key('Escape')
      assertUI('menu-dismiss-' + width + '-' + corner, await evaluate(client, `!document.querySelector('[role="menu"]') && document.activeElement.tagName === 'CANVAS'`))
    }
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(client, `document.querySelector('button[aria-label="Fermer le détail du commit"]')?.click()`)
  await evaluate(client, `document.querySelector('canvas').focus()`)
  await key('ArrowDown')
  await waitFor(client, `document.querySelector('aside[aria-label="Détail du commit"]') !== null`, 'commit inspector')
  assertUI('graph-keyboard-selection', await evaluate(client, `document.querySelector('aside[aria-label="Détail du commit"]').innerText.includes('fix graph lanes')`))
  await screenshot(client, 'ux-history-selected.png')
  const commitDiffOpened = await evaluate(client, `(() => {
    const panel = document.querySelector('aside[aria-label="Détail du commit"]')
    const button = [...panel.querySelectorAll('button')].find((item) => item.textContent.includes('Voir le diff complet'))
    if (!button) return false
    button.click()
    return true
  })()`)
  assertUI('commit-diff-opens', commitDiffOpened)
  await waitFor(client, `document.querySelector('main h1').textContent === 'Comparaison'`, 'commit diff view')
  await waitFor(client, `performance.getEntriesByName('diff.first-paint').length > 0`, 'commit diff render')
  await delay(250)
  const commitDiff = await evaluate(client, `(() => {
    const aside = document.querySelector('aside[aria-label="Fichiers modifiés"]')
    const asideRect = aside ? aside.getBoundingClientRect() : null
    const statsInside = asideRect ? [...aside.querySelectorAll('button span')].every((el) => {
      const text = el.textContent.trim()
      if (!text.startsWith('+') && !text.startsWith('−')) return true
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.right <= asideRect.right + 1 && rect.left >= asideRect.left - 1
    }) : false
    const scroll = [...document.querySelectorAll('main div')].find((el) => String(el.className).includes('scroll'))
    const code = [...document.querySelectorAll('main span')].find((el) => String(el.className).includes('code') && el.textContent.trim().length > 20)
    return {
      hasContext: document.body.textContent.includes('fix graph lanes') && document.body.textContent.includes('src/main.rs'),
      statsInside,
      horizontalScroll: Boolean(scroll && scroll.scrollWidth > scroll.clientWidth + 20),
      codeWhiteSpace: code ? getComputedStyle(code).whiteSpace : null,
      codeEllipsis: code ? getComputedStyle(code).textOverflow : null,
      text: document.body.innerText.slice(0, 400),
    }
  })()`)
  assertUI('commit-diff-context', commitDiff.hasContext)
  assertUI('commit-diff-file-stats-contained', commitDiff.statsInside)
  assertUI('commit-diff-code-scrolls', commitDiff.horizontalScroll && commitDiff.codeWhiteSpace === 'pre' && commitDiff.codeEllipsis !== 'ellipsis')
  await screenshot(client, 'ux-commit-diff.png')

  // Amending rewrites HEAD. The diff header exposes it once the repository is
  // clean, and the dialog reuses the regular amend path with the full message.
  await evaluate(client, `(() => {
    window.__operationOverride = null
    window.__conflictsOverride = { files: [] }
    window.__generationOverride = 4
    window.__emitTauriEvent('repo://changed', { repoId: 'repo_demo', generation: 4, areas: ['state'] })
  })()`)
  await waitFor(client, `!document.body.innerText.includes('Opération en cours')`, 'clean repository state')
  await waitFor(client, `document.querySelector('button[aria-label^="Amender le commit"]') !== null`, 'amendable commit header')
  const amendHeader = await evaluate(client, `(() => {
    const button = document.querySelector('button[aria-label^="Amender le commit"]')
    return { label: button?.getAttribute('aria-label'), title: button?.getAttribute('title') }
  })()`)
  assertUI('commit-diff-amend-affordance', amendHeader.label?.startsWith('Amender le commit') && amendHeader.title.includes('réécrit'))
  await evaluate(client, `document.querySelector('button[aria-label^="Amender le commit"]').click()`)
  await waitFor(client, `document.querySelector('[role="dialog"] h2')?.textContent?.startsWith('Amender')`, 'amend dialog')
  await waitFor(client, `document.querySelector('textarea[aria-label="Message du commit à amender"]')?.value.includes('Corps du commit')`, 'amend message prefilled')
  const amendDialog = await evaluate(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return {
      warning: dialog.innerText.includes('réécrit l’historique') && dialog.innerText.includes('force-with-lease'),
      staged: dialog.innerText.includes('8 fichiers préparés seront inclus'),
      branch: dialog.innerText.includes('branche main'),
    }
  })()`)
  assertUI('amend-warns-history-rewrite', amendDialog.warning)
  assertUI('amend-includes-staged-files', amendDialog.staged)
  assertUI('amend-names-current-branch', amendDialog.branch)
  await screenshot(client, 'ux-amend-dialog.png')
  await evaluate(client, `([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Annuler')).click()`)
  await waitFor(client, `document.querySelector('[role="dialog"]') === null`, 'amend dialog closed')

  // The same action is reachable from the commit context menu, and submitting
  // goes through commit_create with amend=true.
  await go('graph')
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const box = canvas.getBoundingClientRect()
    const x = box.left + Math.max(120, box.width * 0.55)
    const y = box.top + 15
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }))
    }
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
  })()`)
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'commit context menu')
  assertUI('commit-menu-amend-head', await evaluate(client, `[...document.querySelectorAll('[role="menu"] button')].some((b) => b.textContent.includes('Amender ce commit'))`))
  await evaluate(client, `([...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.includes('Amender ce commit'))).click()`)
  await waitFor(client, `document.querySelector('textarea[aria-label="Message du commit à amender"]') !== null`, 'amend dialog from context menu')
  await fill('textarea[aria-label="Message du commit à amender"]', 'fix graph lanes\n\nMessage corrigé depuis le menu.\n')
  assertUI('amend-submit-enables-on-new-message', await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Amender le commit'))
    return Boolean(button && !button.disabled)
  })()`))
  await evaluate(client, `([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Amender le commit'))).click()`)
  await waitFor(client, `(window.__amendCalls ?? []).length > 0`, 'amend commit call')
  const amendCall = await evaluate(client, `window.__amendCalls[0]`)
  assertUI('amend-calls-commit-create', amendCall.amend === true && amendCall.keepMessage === false && amendCall.message.includes('Message corrigé'))
  await waitFor(client, `document.querySelector('[role="dialog"]') === null`, 'amend dialog closed after submit')
  await waitFor(client, `document.body.innerText.includes('amendé')`, 'amend notice')
  await evaluate(client, `(() => {
    delete window.__operationOverride
    delete window.__conflictsOverride
    window.__generationOverride = 5
    window.__emitTauriEvent('repo://changed', { repoId: 'repo_demo', generation: 5, areas: ['state'] })
  })()`)
  await waitFor(client, `document.body.innerText.includes('Opération en cours')`, 'operation banner restored')

  await go('graph')
  await evaluate(client, `document.querySelector('canvas').focus()`)
  await key('ArrowDown')
  await waitFor(client, `document.querySelector('aside[aria-label="Détail du commit"]') !== null`, 'commit inspector after diff')
  await evaluate(client, `document.querySelector('button[aria-label="Fermer le détail du commit"]').click()`)
  assertUI('inspector-can-close', await evaluate(client, `!document.querySelector('aside[aria-label="Détail du commit"]')`))

  await go('status')
  await fill('textarea[aria-label="Message de commit"]', 'fix: conserver mon brouillon')
  await go('graph')
  await go('status')
  assertUI('draft-survives-navigation', await evaluate(client, `document.querySelector('textarea').value === 'fix: conserver mon brouillon'`))
  await evaluate(client, `document.querySelector('section[aria-label="À préparer"] button[title="notes/file-0.md"]').click()`)
  await waitFor(client, `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Rendu') && document.querySelector('[data-markdown-view]') === null`, 'markdown render toggle')
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Rendu'); button?.click() })()`)
  await waitFor(client, `Boolean(document.querySelector('[data-markdown-view] h1'))`, 'markdown rendered')
  assertUI('markdown-file-rendered', await evaluate(client, `(() => {
    const view = document.querySelector('[data-markdown-view]')
    return view.querySelector('h1')?.textContent === 'Notes du fichier'
      && view.querySelector('strong')?.textContent === 'important'
      && view.querySelector('table') !== null
      && view.querySelector('a')?.getAttribute('href') === 'https://example.test/doc'
      && view.textContent.includes('Image bloquée')
      && view.querySelector('script') === null
      && !window.__markdownInjected
  })()`))
  assertUI('markdown-file-reads-diff-revision', await evaluate(client, `(() => {
    const calls = window.__contentCalls ?? []
    return calls.length > 0 && calls.every((call) => call.request.revision === 'worktree')
  })()`))
  await screenshot(client, 'p0-markdown-rendered.png')
  await evaluate(client, `document.querySelector('button[aria-label="Fermer l’aperçu"]').click()`)
  await waitFor(client, `!document.querySelector('[data-markdown-view]')`, 'markdown preview closed')
  await evaluate(client, `document.querySelector('section[aria-label="À préparer"] button[title="src/module-1.ts"]').click()`)
  await waitFor(client, `document.querySelector('input[aria-label="Sélectionner cette ligne"]') !== null`, 'inline worktree diff')
  assertUI('diff-stays-in-changes', await evaluate(client, `document.querySelector('main h1').textContent === 'Historique' && document.querySelector('textarea') !== null`))
  assertUI('no-duplicate-file-sidebar', await evaluate(client, `!document.querySelector('aside[aria-label="Fichiers modifiés"]')`))
  await evaluate(client, `document.querySelector('button[aria-label="Préparer src/module-1.ts"]').click()`)
  await delay(100)
  const callsAfterStage = await evaluate(client, 'window.__p1Calls ?? []')
  assertUI('stage-single-file', callsAfterStage.some(([action, args]) => action === 'stage' && args.request.selections[0].path === 'src/module-1.ts'))
  await evaluate(client, `(() => {
    document.querySelector('input[aria-label="Sélectionner src/module-2.ts"]').click()
    document.querySelector('input[aria-label="Sélectionner src/module-4.ts"]').click()
  })()`)
  await waitFor(client, `document.querySelector('[aria-label="Fichiers sélectionnés"]')?.innerText.includes('2 sélectionnés')`, 'multi-file selection')
  assertUI('multi-file-selection-visible', await evaluate(client, `(() => {
    const bar = document.querySelector('[aria-label="Fichiers sélectionnés"]')
    return Boolean(bar)
      && document.querySelector('input[aria-label="Sélectionner src/module-2.ts"]').checked
      && document.querySelector('input[aria-label="Sélectionner src/module-4.ts"]').checked
      && [...bar.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Préparer' && !button.disabled)
  })()`))
  await screenshot(client, 'ux-file-multi-select.png')
  await evaluate(client, `([...document.querySelectorAll('[aria-label="Fichiers sélectionnés"] button')].find((button) => button.textContent.trim() === 'Préparer')).click()`)
  await waitFor(client, `(window.__p1Calls ?? []).some(([action, args]) => action === 'stage' && args.request.selections.length === 2)`, 'bulk stage call')
  assertUI('multi-file-stage-bulk', await evaluate(client, `(window.__p1Calls ?? []).some(([action, args]) => action === 'stage' && args.request.selections.map((selection) => selection.path).sort().join(',') === 'src/module-2.ts,src/module-4.ts')`))
  await waitFor(client, `document.querySelector('[aria-label="Fichiers sélectionnés"]') === null`, 'bulk selection cleared')

  await evaluate(client, `(() => {
    document.querySelector('input[aria-label="Sélectionner src/module-2.ts"]').click()
    document.querySelector('input[aria-label="Sélectionner src/module-4.ts"]').click()
  })()`)
  await waitFor(client, `document.querySelector('[aria-label="Fichiers sélectionnés"]')?.innerText.includes('2 sélectionnés')`, 'discard selection')
  await evaluate(client, `([...document.querySelectorAll('[aria-label="Fichiers sélectionnés"] button')].find((button) => button.textContent.trim() === 'Abandonner…')).click()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'bulk discard confirmation')
  assertUI('multi-file-discard-confirmation', await evaluate(client, `(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    return dialog.innerText.includes('2 fichiers')
      && dialog.innerText.includes('src/module-2.ts')
      && dialog.innerText.includes('src/module-4.ts')
      && dialog.innerText.includes('irréversible')
  })()`))
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Discard')).click()`)
  await waitFor(client, `(window.__p1Calls ?? []).some(([action, args]) => action === 'discard' && args.request.selections.length === 2)`, 'bulk discard call')
  assertUI('multi-file-discard-bulk', await evaluate(client, `(window.__p1Calls ?? []).some(([action, args]) => action === 'discard' && args.request.selections.map((selection) => selection.path).sort().join(',') === 'src/module-2.ts,src/module-4.ts')`))
  await waitFor(client, `document.querySelector('[role="alertdialog"]') === null`, 'bulk discard closed')
  await waitFor(client, `document.querySelector('[aria-label="Fichiers sélectionnés"]') === null`, 'discard selection cleared')

  const commitCallsBeforeShortcut = await evaluate(client, '(window.__amendCalls ?? []).length')
  await evaluate(client, `(() => {
    const editor = document.querySelector('textarea[aria-label="Message de commit"]')
    editor.focus()
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })()`)
  await waitFor(client, `(window.__amendCalls ?? []).length > ${commitCallsBeforeShortcut}`, 'keyboard commit call')
  const shortcutCommit = await evaluate(client, `window.__amendCalls.at(-1)`)
  assertUI('commit-keyboard-shortcut', shortcutCommit.amend === false && shortcutCommit.message.includes('fix: conserver mon brouillon'))
  await waitFor(client, `Boolean(document.querySelector('[class*="successActions"]'))`, 'commit success actions')
  assertUI('commit-success-actions', await evaluate(client, `(() => {
    const actions = document.querySelector('[class*="successActions"]')
    return [...actions.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Copier le SHA')
      && [...actions.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Annuler le commit')
  })()`))
  await evaluate(client, `([...document.querySelectorAll('[class*="successActions"] button')].find((button) => button.textContent.trim() === 'Annuler le commit')).click()`)
  await waitFor(client, `document.querySelector('[class*="successActions"]') === null`, 'commit undo closes feedback')
  await evaluate(client, `window.__amendCalls = []`)
  await evaluate(client, `document.querySelector('button[aria-label="Actions pour src/module-1.ts"]').click()`)
  await delay(80)
  assertUI('file-actions-open', await evaluate(client, `Boolean(document.querySelector('[popover]:popover-open'))`))
  await key('Escape')
  assertUI('file-actions-escape', await evaluate(client, `!document.querySelector('[popover]:popover-open')`))
  await screenshot(client, 'ux-changes.png')
  await evaluate(client, `(() => {
    window.__originalInvoke = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'diff_get' ? new Promise((resolve) => { window.__resolveDiff = () => window.__originalInvoke(command, args).then(resolve) }) : window.__originalInvoke(command, args)
    document.querySelector('section[aria-label="À préparer"] button[title="src/module-2.ts"]').click()
  })()`)
  await waitFor(client, `typeof window.__resolveDiff === 'function'`, 'pending diff')
  await evaluate(client, `document.querySelector('button[aria-label="Fermer l’aperçu"]').click()`)
  await delay(60)
  assertUI('closing-pending-diff-clears-loading', await evaluate(client, `document.querySelector('canvas').getClientRects().length > 0 && !document.body.innerText.includes('Chargement des modifications')`))
  await evaluate(client, `(() => { window.__resolveDiff(); window.__TAURI_INTERNALS__.invoke = window.__originalInvoke })()`)


  await evaluate(client, `(() => {
    const button = document.querySelector('button[aria-label="Rechercher une commande"]')
    button.focus(); button.click()
  })()`)
  await waitFor(client, `document.querySelector('[role="combobox"]') === document.activeElement`, 'palette focus')
  await key('Tab', 8)
  assertUI('palette-traps-focus', await evaluate(client, `document.querySelector('[aria-label="Palette de commandes"]').contains(document.activeElement)`))
  await screenshot(client, 'ux-palette.png')
  await key('Escape')
  assertUI('palette-restores-focus', await evaluate(client, `document.activeElement.getAttribute('aria-label') === 'Rechercher une commande' && !document.querySelector('[role="dialog"]')`))

  const openedBeforePicker = await evaluate(client, '(window.__repoOpenCalls ?? []).length')
  await evaluate(client, `document.querySelector('button[aria-label="Ouvrir un dépôt"]').click()`)
  await delay(100)
  assertUI('native-picker-folder-mode', await evaluate(client, `window.__pickerCalls.at(-1).directory === true && window.__pickerCalls.at(-1).multiple === false`))
  assertUI('native-picker-no-path-form', await evaluate(client, `!document.querySelector('input[aria-label="Chemin du dépôt"]') && !document.querySelector('[aria-labelledby="open-repo-title"]')`))
  assertUI('native-picker-cancel-keeps-repository', await evaluate(client, `(window.__repoOpenCalls ?? []).length === ${openedBeforePicker} && document.querySelector('canvas') !== null`))
  const pickerCallsBeforeDuplicate = await evaluate(client, 'window.__pickerCalls.length')
  await evaluate(client, `(() => { window.__pickerDeferred = true; const button = document.querySelector('button[aria-label="Ouvrir un dépôt"]'); button.click(); button.click() })()`)
  await waitFor(client, `typeof window.__pickerResolve === 'function'`, 'native folder picker pending')
  assertUI('native-picker-no-duplicate-dialogs', await evaluate(client, `window.__pickerCalls.length === ${pickerCallsBeforeDuplicate + 1}`))
  await evaluate(client, `(() => { window.__pickerDeferred = false; window.__pickerResolve(null); })()`)
  await delay(80)
  await evaluate(client, `(() => { window.__pickerSelection = '/tmp/beebranch-demo'; document.querySelector('button[aria-label="Ouvrir un dépôt"]').click() })()`)
  await waitFor(client, `(window.__repoOpenCalls ?? []).length === ${openedBeforePicker + 1}`, 'selected repository opening')
  assertUI('native-picker-opens-selected-directory', await evaluate(client, `window.__repoOpenCalls.at(-1) === '/tmp/beebranch-demo' && document.querySelector('canvas') !== null`))
  await evaluate(client, `(() => { window.__pickerSelection = '/tmp/not-a-repository'; window.__repoOpenFailure = true; document.querySelector('button[aria-label="Ouvrir un dépôt"]').click() })()`)
  await waitFor(client, `document.body.innerText.includes('Le dossier choisi ne contient pas de dépôt Git.')`, 'invalid Git folder feedback')
  assertUI('native-picker-invalid-repo-feedback', await evaluate(client, `document.querySelector('[role="alert"]') !== null && document.querySelector('canvas') !== null`))
  await evaluate(client, `(() => { window.__repoOpenFailure = false; window.__pickerSelection = null; document.querySelector('[role="alert"] button').click(); document.querySelector('canvas').focus() })()`)
  const pickerCallsBeforeShortcut = await evaluate(client, 'window.__pickerCalls.length')
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'o', code:'KeyO', windowsVirtualKeyCode:79, modifiers:4 })
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'o', code:'KeyO', windowsVirtualKeyCode:79, modifiers:0 })
  await delay(100)
  assertUI('native-picker-open-shortcut', await evaluate(client, `window.__pickerCalls.length === ${pickerCallsBeforeShortcut + 1}`))

  for (const [width, height] of [[1024, 768], [768, 900], [390, 844]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await delay(150)
    await screenshot(client, 'ux-changes-' + width + '.png')
    assertUI('changes-width-' + width, await evaluate(client, `document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').getBoundingClientRect().right <= innerWidth + 1`))
    assertUI('composer-reachable-' + width, await evaluate(client, `document.querySelector('textarea').getBoundingClientRect().width > 100`))
    await screenshot(client, 'ux-changes-' + width + '.png')
    await go('graph')
    assertUI('graph-width-' + width, await evaluate(client, `document.querySelector('canvas').getBoundingClientRect().width > 200 && document.documentElement.scrollWidth <= innerWidth`))
    await screenshot(client, 'ux-history-' + width + '.png')
    await go('status')
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await go('graph')
  await evaluate(client, `document.documentElement.dataset.theme = 'light'`)
  await delay(200)
  assertUI('canvas-repaints-light-theme', await evaluate(client, `(() => {
    const c = document.querySelector('canvas'); const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let darkTextPixels = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 31 && pixels[i + 1] === 39 && pixels[i + 2] === 51 && pixels[i + 3] > 200) darkTextPixels++
    return darkTextPixels > 50
  })()`))
  await screenshot(client, 'ux-history-light.png')
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(client, `document.querySelector('button[aria-label="Rechercher une commande"]').click()`)
  await delay(100)
  assertUI('reduced-motion-modal', await evaluate(client, `getComputedStyle(document.querySelector('[aria-label="Palette de commandes"]')).animationName === 'none'`))
  await key('Escape')
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await evaluate(client, `document.documentElement.dataset.theme = 'dark'`)
  await go('status')
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'repo_close_checked' ? Promise.resolve(null) : original(command, args)
    document.querySelector('button[aria-label="Fermer beebranch-demo"]').click()
  })()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]') !== null`, 'close confirmation')
  assertUI('confirm-initial-focus', await evaluate(client, `document.querySelector('[role="alertdialog"]').contains(document.activeElement)`))
  await key('Escape')
  assertUI('confirm-escape', await evaluate(client, `!document.querySelector('[role="alertdialog"]') && document.querySelector('textarea') !== null`))
  await evaluate(client, `document.querySelector('button[aria-label="Fermer beebranch-demo"]').click()`)
  await delay(80)
  await evaluate(client, `(() => { const dialog = document.querySelector('[role="alertdialog"]'); [...dialog.querySelectorAll('button')].at(-1).click() })()`)
  await waitFor(client, `Boolean(document.querySelector('[aria-label="Dépôts récents"]'))`, 'home after closing')
  await screenshot(client, 'ux-home.png')
  await evaluate(client, `(() => { const button = document.querySelector('button[aria-label="Rechercher une commande"]'); button.focus(); button.click() })()`)
  await fill('[role="combobox"]', 'Aller à Historique')
  await key('Enter')
  assertUI('unavailable-command-not-executed', await evaluate(client, `Boolean(document.querySelector('[aria-label="Palette de commandes"]')) && Boolean(document.querySelector('[aria-label="Dépôts récents"]'))`))
  await key('Escape')
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__scenarioDirty = false
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args)
      if (['repo_open', 'repo_refresh', 'repo_get_state'].includes(command) && !window.__scenarioDirty) return { ...result, state: { ...result.state, operation:null, conflicts:{ files:[] }, worktree:{ staged:0, unstaged:0, untracked:0, conflicted:0 } } }
      if (command === 'status_get' && !window.__scenarioDirty) return { ...result, data:{ ...result.data, entries:[], counts:{ staged:0, unstaged:0, untracked:0, conflicted:0 } } }
      return result
    }
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('beebranch-demo'))
    button.click()
  })()`)
  await waitFor(client, `document.querySelector('canvas') !== null`, 'clean repository graph')
  assertUI('clean-history-has-no-local-row-or-panel', await evaluate(client, `!document.querySelector('button[aria-pressed]') && !document.querySelector('[aria-label="Préparation du prochain commit"]')`))
  assertUI('clean-history-uses-full-width', await evaluate(client, `document.querySelector('canvas').getBoundingClientRect().width >= document.querySelector('main').getBoundingClientRect().width - 2`))
  await screenshot(client, 'ux-clean-history.png')
  await evaluate(client, `document.querySelector('canvas').focus()`)
  await key('ArrowDown')
  await waitFor(client, `document.querySelector('[aria-label="Détail du commit"]') !== null`, 'clean repository selection')
  await evaluate(client, `document.querySelector('button[aria-label="Fermer le détail du commit"]').click()`)
  assertUI('closing-commit-leaves-no-panel', await evaluate(client, `!document.querySelector('[aria-label="Détail du commit"]') && !document.querySelector('[aria-label="Préparation du prochain commit"]')`))
  await evaluate(client, `(() => { window.__scenarioDirty = true; [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Rafraîchir l')).click() })()`)
  await waitFor(client, `document.querySelector('button[aria-pressed="false"]') !== null`, 'new unselected local changes')
  assertUI('new-changes-do-not-open-panel', await evaluate(client, `!document.querySelector('[aria-label="Préparation du prochain commit"]')`))
  await evaluate(client, `document.querySelector('button[aria-pressed="false"]').click()`)
  await waitFor(client, `document.querySelector('[aria-label="Préparation du prochain commit"]') !== null`, 'selected local changes')
  await evaluate(client, `document.querySelector('button[title="src/module-1.ts"]').click()`)
  await waitFor(client, `document.querySelector('button[aria-label="Fermer l’aperçu"]') !== null`, 'local diff preview')
  await evaluate(client, `(() => { window.__scenarioDirty = false; [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Rafraîchir l')).click() })()`)
  await waitFor(client, `!document.querySelector('button[aria-pressed]') && !document.querySelector('[aria-label="Préparation du prochain commit"]')`, 'changes cleared')
  assertUI('last-change-removal-restores-graph', await evaluate(client, `document.querySelector('canvas').getClientRects().length > 0 && !document.querySelector('button[aria-label="Fermer l’aperçu"]')`))
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__toolbarCalls = []
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'sync_pull') {
        window.__toolbarCalls.push([command, args])
        return Promise.resolve({
          data: {
            kind: 'pull',
            output: 'Already up to date.',
            cancelled: false,
            headBefore: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            headAfter: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            behindUpstream: 0,
          },
          generation: 1,
        })
      }
      if (['sync_fetch', 'sync_pull', 'sync_push', 'tool_open', 'branch_checkout', 'branch_checkout_at', 'branch_create', 'branch_upstream', 'branch_rename', 'branch_delete', 'history_merge'].includes(command)) {
        window.__toolbarCalls.push([command, args]); return Promise.resolve({ data:null, generation:1 })
      }
      return original(command, args)
    }
  })()`)
  assertUI('toolbar-no-empty-stash-pop', await evaluate(client, `[...document.querySelectorAll('[aria-label="Actions Git"] button')].find(b => b.textContent.trim() === 'Pop').disabled`))
  for (const label of ['Fetch', 'Pull', 'Push', 'Terminal']) {
    await evaluate(client, `(() => { const button = [...document.querySelectorAll('[aria-label="Actions Git"] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); button.click() })()`)
    await delay(150)
  }
  const toolbarCalls = await evaluate(client, 'window.__toolbarCalls')
  assertUI('toolbar-git-actions-connected', ['sync_fetch', 'sync_pull', 'sync_push', 'tool_open'].every(command => toolbarCalls.some(([name]) => name === command)))
  // A pull that integrates nothing must not read like a completed integration.
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('[aria-label="Actions Git"] button')].find(b => b.textContent.trim() === 'Pull'); button.click() })()`)
  await waitFor(client, `document.querySelector('[aria-label="Actions du dépôt"] [role="status"]')?.textContent.includes('déjà à jour') === true`, 'pull outcome notice')
  await screenshot(client, 'toolbar-pull-outcome.png')
  assertUI('toolbar-terminal-repo-context', toolbarCalls.some(([name, args]) => name === 'tool_open' && args.input.repoId === 'repo_demo' && args.input.kind === 'terminal'))
  await evaluate(client, `document.querySelector('button[aria-label="Choisir une branche"]').click()`)
  await waitFor(client, `document.querySelector('[popover]:popover-open') !== null`, 'branch selector')
  assertUI('toolbar-branch-selector', await evaluate(client, `document.querySelector('[popover]:popover-open').innerText.includes('feature')`))
  await evaluate(client, `(() => { const button = [...document.querySelector('[popover]:popover-open').querySelectorAll('button')].find(b => b.textContent.trim() === 'feature'); button.click() })()`)
  await delay(100)
  assertUI('toolbar-branch-checkout-connected', await evaluate(client, `window.__toolbarCalls.some(([name, args]) => name === 'branch_checkout' && args.request.name === 'feature')`))
  await evaluate(client, `document.querySelector('button[aria-label="Choisir un dépôt"]').click()`)
  await waitFor(client, `document.querySelector('[popover]:popover-open') !== null`, 'repo selector')
  assertUI('toolbar-repo-selector', await evaluate(client, `document.querySelector('[popover]:popover-open').innerText.includes('beebranch-demo') && document.querySelector('[popover]:popover-open').innerText.includes('Ouvrir un autre dépôt')`))
  await key('Escape')
  const moveToBadge = async (index = 0) => {
    await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')); })()`)
    await delay(60)
    const point = await evaluate(client, `(() => { const b = document.querySelector('canvas').getBoundingClientRect(); return { x:b.left + 20, y:b.top + ${index} * 30 + 15 } })()`)
    await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:point.x, y:point.y })
    await delay(120)
    return point
  }
  const hoverRef = async (index = 0) => {
    const point = await moveToBadge(index)
    await waitFor(client, `document.querySelector('[aria-label="Branches et tags de ce commit"]') !== null`, 'branch list hover')
    return point
  }
  const directDoubleClick = async (point) => {
    for (const clickCount of [1, 2]) {
      await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount, x:point.x, y:point.y })
      await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount, x:point.x, y:point.y })
    }
    await delay(120)
  }
  const firstPoint = await hoverRef()
  assertUI('graph-hover-shows-all-refs', await evaluate(client, `(() => { const p = document.querySelector('[aria-label="Branches et tags de ce commit"]'); return ['main', 'origin/main', 'feature/group', 'origin/feature/deep', 'origin/collision'].every(name => p.textContent.includes(name)) && p.querySelectorAll('button').length === 6 })()`))
  assertUI('graph-remote-head-symref-hidden', await evaluate(client, `(() => { const p = document.querySelector('[aria-label="Branches et tags de ce commit"]'); return !p.textContent.includes('origin/HEAD') && !p.querySelector('[data-ref="origin/HEAD"]') })()`))
  assertUI('graph-hover-list-compact', await evaluate(client, `(() => { const r = document.querySelector('[aria-label="Branches et tags de ce commit"]').getBoundingClientRect(); return r.width <= 260 && r.height < 220 })()`))
  const beforeRefCalls = await evaluate(client, 'window.__toolbarCalls.length')
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, x:firstPoint.x, y:firstPoint.y })
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, x:firstPoint.x, y:firstPoint.y })
  await delay(80)
  assertUI('graph-single-ref-click-does-not-checkout', await evaluate(client, `window.__toolbarCalls.length === ${beforeRefCalls} && !document.querySelector('[aria-label="Détail du commit"]')`))
  const popupPoint = await evaluate(client, `(() => { const b = document.querySelector('[aria-label="Branches et tags de ce commit"]').getBoundingClientRect(); return { x:b.left+80, y:b.top+50 } })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:popupPoint.x, y:popupPoint.y })
  await delay(250)
  assertUI('graph-hover-list-remains-interactive', await evaluate(client, `Boolean(document.querySelector('[aria-label="Branches et tags de ce commit"]'))`))
  await screenshot(client, 'ux-branch-hover.png')
  await evaluate(client, `document.querySelector('[data-ref="feature/group"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  await delay(120)
  assertUI('graph-hidden-local-double-click-checkout', await evaluate(client, `window.__toolbarCalls.slice(${beforeRefCalls}).some(([command, args]) => command === 'branch_checkout' && args.request.name === 'feature/group')`))
  const featurePoint = await moveToBadge(12)
  assertUI('graph-single-ref-has-no-menu', await evaluate(client, `!document.querySelector('[aria-label="Branches et tags de ce commit"]')`))
  assertUI('graph-single-ref-tooltip-names-kind', await evaluate(client, `document.querySelector('canvas').title === 'feature · locale'`))
  const beforeDirect = await evaluate(client, 'window.__toolbarCalls.length')
  await directDoubleClick(featurePoint)
  assertUI('graph-visible-branch-double-click-checkout', await evaluate(client, `window.__toolbarCalls.slice(${beforeDirect}).filter(([command, args]) => command === 'branch_checkout' && args.request.name === 'feature').length === 1`))
  // Double-clicking a remote branch whose tracked local branch lags behind
  // must move that local branch onto the remote commit before checking it out.
  const behindPoint = await moveToBadge(7)
  assertUI('graph-remote-desync-tooltip', await evaluate(client, `document.querySelector('canvas').title === 'origin/behind · distante'`))
  const beforeDesync = await evaluate(client, 'window.__toolbarCalls.length')
  await directDoubleClick(behindPoint)
  assertUI('graph-remote-desync-resets-local', await evaluate(client, `(() => {
    const calls = window.__toolbarCalls.slice(${beforeDesync})
    return calls.some(([command, args]) => command === 'branch_checkout_at' && args.request.name === 'behind' && args.request.start === 'refs/remotes/origin/behind')
      && !calls.some(([command]) => command === 'branch_checkout')
  })()`))
  // A commit can carry several refs: the badge under the cursor, not the
  // first decoration of the row, decides which branch is checked out.
  await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')); })()`)
  await delay(60)
  const topicPoint = await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const bounds = canvas.getBoundingClientRect()
    const family = getComputedStyle(canvas).getPropertyValue('--sans').trim()
    const context = document.createElement('canvas').getContext('2d')
    context.font = '600 12px ' + family
    const firstWidth = context.measureText('other').width + 12 + 16
    return { x: bounds.left + 12 + firstWidth + 4 + 8, y: bounds.top + 8 * 30 + 15 }
  })()`)
  const beforeTopic = await evaluate(client, 'window.__toolbarCalls.length')
  await directDoubleClick(topicPoint)
  assertUI('graph-remote-badge-below-first-ref-checkout', await evaluate(client, `(() => {
    const calls = window.__toolbarCalls.slice(${beforeTopic})
    return calls.some(([command, args]) => command === 'branch_create' && args.request.name === 'topic' && args.request.start === 'refs/remotes/origin/topic' && args.request.checkout === true)
      && !calls.some(([command, args]) => command === 'branch_checkout' && args.request.name === 'other')
  })()`))
  await hoverRef()
  const beforeRemote = await evaluate(client, 'window.__toolbarCalls.length')
  await evaluate(client, `document.querySelector('[data-ref="origin/feature/deep"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  await delay(120)
  assertUI('graph-remote-creates-correct-local-branch', await evaluate(client, `window.__toolbarCalls.slice(${beforeRemote}).some(([command, args]) => command === 'branch_create' && args.request.name === 'feature/deep' && args.request.start === 'refs/remotes/origin/feature/deep' && args.request.checkout === true)`))
  assertUI('graph-remote-preserves-upstream', await evaluate(client, `window.__toolbarCalls.slice(${beforeRemote}).some(([command, args]) => command === 'branch_upstream' && args.request.branch === 'feature/deep' && args.request.upstream === 'origin/feature/deep')`))
  await hoverRef()
  const beforeTag = await evaluate(client, 'window.__toolbarCalls.length')
  await evaluate(client, `document.querySelector('[data-ref="tag: main"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  assertUI('graph-tag-cannot-checkout-same-named-branch', await evaluate(client, `window.__toolbarCalls.length === ${beforeTag} && document.querySelector('[data-ref="tag: main"]').disabled`))
  await evaluate(client, `document.querySelector('[data-ref="origin/collision"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  await delay(100)
  assertUI('graph-remote-collision-is-not-overwritten', await evaluate(client, `window.__toolbarCalls.length === ${beforeTag} && document.body.innerText.includes('existe déjà')`))
  await hoverRef()
  await evaluate(client, `document.querySelector('canvas').parentElement.dispatchEvent(new Event('scroll'))`)
  assertUI('graph-hover-closes-on-scroll', await evaluate(client, `!document.querySelector('[aria-label="Branches et tags de ce commit"]')`))
  // A branch and its own remote mirror share a commit: no menu to disambiguate.
  await moveToBadge(3)
  assertUI('graph-upstream-mirror-has-no-menu', await evaluate(client, `!document.querySelector('[aria-label="Branches et tags de ce commit"]')`))
  assertUI('graph-upstream-mirror-shows-name-and-kind', await evaluate(client, `document.querySelector('canvas').title === 'synced · locale'`))
  await screenshot(client, 'ux-branch-synced.png')
  // Any other multi-ref commit keeps the menu, and its rows carry the ref kind.
  await hoverRef()
  const refKinds = await evaluate(client, `(() => { const p = document.querySelector('[aria-label="Branches et tags de ce commit"]'); return { local: Boolean(p.querySelector('[data-kind="local"]')), remote: Boolean(p.querySelector('[data-kind="remote"]')), tag: Boolean(p.querySelector('[data-kind="tag"]')) } })()`)
  assertUI('graph-menu-distinguishes-local-remote-tag', refKinds.local && refKinds.remote && refKinds.tag)
  assertUI('graph-upstream-mirror-keeps-branch-row', await evaluate(client, `Boolean(document.querySelector('[data-ref="origin/main"]'))`))
  // Right-clicking a local branch offers a push and upstream wiring.
  const openBranchRefMenu = async (point) => {
    await evaluate(client, `(() => { document.querySelector('canvas').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:${point.x}, clientY:${point.y} })) })()`)
    await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'branch context menu')
  }
  const menuButton = (needle) => `[...document.querySelector('[role="menu"]').querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(needle)}))`
  const featureMenu = await moveToBadge(12)
  await openBranchRefMenu(featureMenu)
  assertUI('branch-menu-offers-push', await evaluate(client, `Boolean(${menuButton('Pousser vers origin/feature')})`))
  assertUI('branch-menu-offers-upstream', await evaluate(client, `Boolean(${menuButton('Définir l')})`))
  await evaluate(client, `${menuButton('Pousser vers origin/feature')}.click()`)
  await delay(120)
  assertUI('branch-menu-push-connected', await evaluate(client, `window.__toolbarCalls.some(([command, args]) => command === 'sync_push' && args.request.remote === 'origin' && args.request.branch === 'feature' && args.request.setUpstream !== true)`))
  await openBranchRefMenu(featureMenu)
  await evaluate(client, `${menuButton('Définir l')}.click()`)
  await delay(60)
  assertUI('branch-menu-lists-remote-branches', await evaluate(client, `Boolean(${menuButton('origin/main')}) && !document.querySelector('[role="menu"]').innerText.includes('origin/HEAD')`))
  await evaluate(client, `${menuButton('origin/main')}.click()`)
  await delay(120)
  assertUI('branch-menu-upstream-connected', await evaluate(client, `window.__toolbarCalls.some(([command, args]) => command === 'branch_upstream' && args.request.branch === 'feature' && args.request.upstream === 'origin/main')`))
  await screenshot(client, 'ux-branch-menu.png')
  // Badge glyphs are canvas pixels: compare the ink signature of a local
  // branch, a tag and a remote-only branch, and require readable ink in each.
  await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')); })()`)
  await delay(120)
  const glyphs = await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const context = canvas.getContext('2d')
    const scale = canvas.width / canvas.getBoundingClientRect().width
    const ink = (row) => {
      const x = Math.round(13 * scale)
      const y = Math.round((row * 30 + 10) * scale)
      const width = Math.round(11 * scale)
      const height = Math.round(10 * scale)
      const data = context.getImageData(x, y, width, height).data
      const background = [data[0], data[1], data[2]]
      let count = 0, hash = 7
      for (let index = 0; index < data.length; index += 4) {
        const delta = Math.abs(data[index] - background[0]) + Math.abs(data[index + 1] - background[1]) + Math.abs(data[index + 2] - background[2])
        if (delta > 40) { count += 1; hash = (hash * 33 + index) % 1000003 }
      }
      return { count, hash }
    }
    return { local: ink(0), tag: ink(5), remote: ink(18) }
  })()`)
  assertUI('graph-badge-icons-have-ink', glyphs.local.count >= 6 && glyphs.tag.count >= 6 && glyphs.remote.count >= 6)
  assertUI('graph-badge-icons-differ-by-kind', new Set([glyphs.local.hash, glyphs.tag.hash, glyphs.remote.hash]).size === 3)
  await moveToBadge(18)
  assertUI('graph-remote-only-badge-tooltip', await evaluate(client, `document.querySelector('canvas').title === 'origin/hotfix · distante' && !document.querySelector('[aria-label="Branches et tags de ce commit"]')`))
  for (const width of [900, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false })
    await delay(80)
    await evaluate(client, `(() => { const buttons = [...document.querySelector('[aria-label="Actions du dépôt"]').querySelectorAll('button')]; buttons.find(b => !b.disabled && b.getClientRects().length > 0).focus() })()`)
    for (let step = 0; step < 32; step++) {
      if (await evaluate(client, `document.activeElement.getAttribute('aria-label') === 'Rechercher une commande'`)) break
      await key('Tab')
    }
    assertUI('toolbar-keyboard-search-' + width, await evaluate(client, `(() => { const b = document.activeElement.getBoundingClientRect(); return document.activeElement.getAttribute('aria-label') === 'Rechercher une commande' && b.left >= 0 && b.right <= innerWidth + 1 })()`))
    await screenshot(client, 'ux-topbar-' + width + '.png')
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false })
  await delay(80)
  await screenshot(client, 'ux-topbar.png')
  const plusAlignment = await evaluate(client, `(() => {
    const plus = document.querySelector('button[aria-label="Ajouter un dépôt"] svg').getBoundingClientRect()
    const tab = document.querySelector('header [aria-current="page"] svg').getBoundingClientRect()
    return Math.abs((plus.top + plus.height / 2) - (tab.top + tab.height / 2))
  })()`)
  assertUI('add-repo-plus-centered-on-tabs', plusAlignment <= 1)
  const tabsBeforeLauncher = await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"]').querySelectorAll('button[title]').length`)
  await evaluate(client, `document.querySelector('button[aria-label="Ajouter un dépôt"]').click()`)
  await waitFor(client, `document.querySelector('main').innerText.includes('Reprendre le travail')`, 'repository launcher')
  assertUI('add-repo-launcher-tab-active', await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher] button[aria-current="page"]') !== null`))
  assertUI('add-repo-launcher-recent-open-create-clone', await evaluate(client, `(() => { const text = document.querySelector('main').innerText; return text.includes('beebranch-demo') && text.includes('Ouvrir un dépôt local…') && text.includes('Créer un dépôt…') && text.includes('Cloner un dépôt…') })()`))
  assertUI('add-repo-launcher-preserves-tabs', await evaluate(client, `document.querySelectorAll('[aria-label="Dépôts ouverts"] > div:not([data-launcher]) button[title]').length === ${tabsBeforeLauncher} && document.querySelector('header').innerText.includes('beebranch-demo') && document.querySelector('canvas') === null`))
  await screenshot(client, 'ux-repo-launcher.png')
  // A new tab lands ready to search: the recent field is focused, filtering
  // matches names and paths, and an empty result is announced.
  assertUI('launcher-recent-search-focused', await evaluate(client, `document.activeElement?.getAttribute('aria-label') === 'Rechercher un dépôt récent'`))
  const typeRecent = (value) => evaluate(client, `(() => {
    const field = document.querySelector('input[aria-label="Rechercher un dépôt récent"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(field, ${JSON.stringify(value)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await typeRecent('zzz-introuvable')
  await delay(80)
  assertUI('launcher-recent-search-empty-state', await evaluate(client, `document.querySelector('main').innerText.includes('Aucun dépôt récent ne correspond')`))
  await typeRecent('beebranch')
  await delay(80)
  assertUI('launcher-recent-search-filters', await evaluate(client, `(() => { const text = document.querySelector('main').innerText; return text.includes('1 sur 1 dépôt') && text.includes('beebranch-demo') })()`))
  await typeRecent('')
  await delay(80)
  const beforePlusPicker = await evaluate(client, 'window.__pickerCalls.length')
  await evaluate(client, `window.__pickerSelection = null`)
  await evaluate(client, `(() => { const b = [...document.querySelectorAll('main button')].find((item) => item.textContent.includes('Ouvrir un dépôt local…')); b.click() })()`)
  await delay(100)
  assertUI('add-repo-local-opens-native-picker', await evaluate(client, `window.__pickerCalls.length === ${beforePlusPicker + 1}`))
  await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher] button[aria-current="page"]').focus()`)
  await key('Escape')
  await waitFor(client, `document.querySelector('canvas') !== null`, 'graph after closing the launcher')
  assertUI('add-repo-launcher-escape-closes', await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher]') === null && document.activeElement.getAttribute('aria-label') === 'Ajouter un dépôt'`))
  await evaluate(client, `document.querySelector('button[aria-label="Ajouter un dépôt"]').click()`)
  await waitFor(client, `document.querySelector('main').innerText.includes('Reprendre le travail')`, 'repository launcher reopened')
  await evaluate(client, `(() => { const b = document.querySelector('button[aria-label="Fermer l’écran d’ouverture de dépôt"]'); b.focus(); b.click() })()`)
  await waitFor(client, `document.querySelector('canvas') !== null`, 'graph after closing the launcher tab')
  assertUI('add-repo-launcher-close-returns-focus', await evaluate(client, `document.activeElement.getAttribute('aria-label') === 'Ajouter un dépôt'`))
  const openCloneFromLauncher = async () => {
    await evaluate(client, `document.querySelector('button[aria-label="Ajouter un dépôt"]').click()`)
    await waitFor(client, `document.querySelector('main').innerText.includes('Reprendre le travail')`, 'repository launcher')
    await evaluate(client, `(() => { const b = [...document.querySelectorAll('main button')].find((item) => item.textContent.includes('Cloner un dépôt…')); b.click() })()`)
    await waitFor(client, `document.body.innerText.includes('Projets GitLab accessibles')`, 'clone form')
    await waitFor(client, `document.body.innerText.includes('team/payment-platform')`, 'clone projects')
  }
  const tabsBeforeClone = await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"]').querySelectorAll('button[title]').length`)
  await openCloneFromLauncher()
  assertUI('add-repo-clone-preserves-current-repo', await evaluate(client, `document.querySelectorAll('[aria-label="Dépôts ouverts"] > div:not([data-launcher]) button[title]').length === ${tabsBeforeClone} && document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher]') !== null`))
  await screenshot(client, 'ux-clone-launcher.png')
  await key('Escape')
  await waitFor(client, `document.querySelector('canvas') !== null`, 'graph after leaving the clone form')
  await evaluate(client, `document.querySelector('button[aria-label="Ajouter un dépôt"]').click()`)
  await waitFor(client, `document.querySelector('main').innerText.includes('Reprendre le travail')`, 'launcher reopened after the clone form')
  await waitFor(client, `document.querySelector('#clone-destination') === null`, 'clone form closed')
  assertUI('add-repo-clone-cancel-restores-launcher', await evaluate(client, `document.querySelector('#clone-destination') === null`))
  await openCloneFromLauncher()
  await evaluate(client, `(() => { const d = document.querySelector('main'); [...d.querySelectorAll('button')].find(b => b.textContent.includes('team/payment-platform')).click(); window.__cloneFailure = true; })()`)
  await delay(60)
  const pickerCallsBeforeClone = await evaluate(client, 'window.__pickerCalls.length')
  await evaluate(client, `window.__pickerSelection = '/tmp/choisi'`)
  await evaluate(client, `(() => { const d = document.querySelector('main'); [...d.querySelectorAll('button')].find(b => b.textContent.includes('Parcourir')).click() })()`)
  await waitFor(client, `document.querySelector('#clone-destination')?.value === '/tmp/choisi/payment-platform'`, 'clone destination from folder picker')
  assertUI('clone-folder-picker-uses-native-directory-dialog', await evaluate(client, `(() => { const call = window.__pickerCalls.at(-1); return window.__pickerCalls.length === ${pickerCallsBeforeClone + 1} && call.directory === true && call.multiple === false })()`))
  await fill('#clone-destination', '/tmp/payment-platform')
  await evaluate(client, `window.__pickerSelection = null`)
  await evaluate(client, `document.querySelector('main form button[type="submit"]').click()`)
  await waitFor(client, `document.querySelector('main').innerText.includes('Le clonage a échoué.')`, 'clone error feedback')
  assertUI('add-repo-clone-error-retains-launcher', await evaluate(client, `Boolean(document.querySelector('main [role="alert"]')) && document.querySelector('main').innerText.includes('Reprendre le travail')`))
  await evaluate(client, `window.__cloneFailure = false`)
  await evaluate(client, `document.querySelector('main form button[type="submit"]').click()`)
  await waitFor(client, `document.querySelector('header').innerText.includes('cloned-demo') && document.querySelector('canvas') !== null`, 'cloned repository tab')
  assertUI('add-repo-clone-opens-new-tab', await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"]').querySelectorAll('button[title]').length === ${tabsBeforeClone + 1} && document.querySelector('header').innerText.includes('beebranch-demo') && document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher] button[aria-current="page"]') === null`))
  assertUI('add-repo-clone-request', await evaluate(client, `window.__cloneCalls.at(-1).destination === '/tmp/payment-platform' && window.__cloneCalls.at(-1).url.includes('team/payment-platform.git')`))
  const tabsBeforeInit = await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"]').querySelectorAll('button[title]').length`)
  const openInitFromLauncher = async () => {
    await evaluate(client, `document.querySelector('button[aria-label="Ajouter un dépôt"]').click()`)
    await waitFor(client, `document.querySelector('main').innerText.includes('Reprendre le travail')`, 'repository launcher')
    await evaluate(client, `(() => { const b = [...document.querySelectorAll('main button')].find((item) => item.textContent.includes('Créer un dépôt…')); b.click() })()`)
    await waitFor(client, `document.querySelector('[aria-labelledby="init-repo-title"]') !== null`, 'init dialog')
  }
  await openInitFromLauncher()
  assertUI('add-repo-init-focus-trapped', await evaluate(client, `document.querySelector('[aria-labelledby="init-repo-title"]').contains(document.activeElement)`))
  await waitFor(client, `document.querySelector('input[aria-label="Dossier parent"]')?.value === '/tmp'`, 'init default parent')
  await screenshot(client, 'ux-init-dialog.png')
  await fill('input[aria-label="Nom du dépôt"]', 'bad/name')
  await waitFor(client, `document.querySelector('input[aria-label="Nom du dépôt"]')?.getAttribute('aria-invalid') === 'true'`, 'init invalid name state')
  assertUI('add-repo-init-invalid-name', await evaluate(client, `(() => { const submit = document.querySelector('[aria-labelledby="init-repo-title"] button[type="submit"]'); return submit.disabled && !document.body.innerText.includes('/tmp/bad/name') })()`))
  const pickerCallsBeforeInit = await evaluate(client, 'window.__pickerCalls.length')
  await evaluate(client, `window.__pickerSelection = '/tmp/choisi'`)
  await evaluate(client, `(() => { const d = document.querySelector('[aria-labelledby="init-repo-title"]'); [...d.querySelectorAll('button')].find(b => b.textContent.includes('Parcourir')).click() })()`)
  await waitFor(client, `document.querySelector('input[aria-label="Dossier parent"]')?.value === '/tmp/choisi'`, 'init parent from folder picker')
  assertUI('add-repo-init-folder-picker', await evaluate(client, `(() => { const call = window.__pickerCalls.at(-1); return window.__pickerCalls.length === ${pickerCallsBeforeInit + 1} && call.directory === true && call.multiple === false && call.title === 'Choisir le dossier parent' })()`))
  await fill('input[aria-label="Nom du dépôt"]', 'nouveau-projet')
  await fill('input[aria-label="Branche initiale"]', 'main')
  assertUI('add-repo-init-preview', await evaluate(client, `document.querySelector('[aria-labelledby="init-repo-title"]').innerText.includes('/tmp/choisi/nouveau-projet')`))
  await evaluate(client, `window.__initFailure = true`)
  await evaluate(client, `document.querySelector('[aria-labelledby="init-repo-title"] button[type="submit"]').click()`)
  await waitFor(client, `document.querySelector('[aria-labelledby="init-repo-title"]').innerText.includes('La création du dépôt a échoué.')`, 'init error feedback')
  assertUI('add-repo-init-error-retains-dialog', await evaluate(client, `Boolean(document.querySelector('[aria-labelledby="init-repo-title"] [role="alert"]'))`))
  await evaluate(client, `window.__initFailure = false`)
  await evaluate(client, `document.querySelector('[aria-labelledby="init-repo-title"] button[type="submit"]').click()`)
  await waitFor(client, `!document.querySelector('[aria-labelledby="init-repo-title"]') && document.querySelector('header').innerText.includes('nouveau-projet') && document.querySelector('canvas') !== null`, 'initialised repository tab')
  assertUI('add-repo-init-opens-new-tab', await evaluate(client, `document.querySelector('[aria-label="Dépôts ouverts"]').querySelectorAll('button[title]').length === ${tabsBeforeInit + 1} && document.querySelector('[aria-label="Dépôts ouverts"] [data-launcher] button[aria-current="page"]') === null`))
  assertUI('add-repo-init-request', await evaluate(client, `window.__initCalls.at(-1).destination === '/tmp/choisi/nouveau-projet' && window.__initCalls.at(-1).initialBranch === 'main'`))
  await evaluate(client, `window.__pickerSelection = null`)
  // --- P3: undo, drag and drop, workspaces, design system, accessibility ---
  await go('graph')
  const undoClicked = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('[aria-label="Actions Git"] button')].find((item) => item.textContent.trim() === 'Undo')
    if (!button || button.disabled) return false
    button.click(); return true
  })()`)
  assertUI('undo-button-connected', undoClicked)
  await waitFor(client, `(window.__p3Calls ?? []).some(([name]) => name === 'undo_apply')`, 'undo call')
  assertUI('undo-notice', await evaluate(client, `document.body.innerText.includes('Annulé : commit abc123')`))

  await evaluate(client, `(() => {
    window.__scenarioDirty = true
    document.querySelector('[aria-label="Dépôts ouverts"] button[title="/tmp/beebranch-demo"]')?.click()
  })()`)
  await waitFor(client, `(() => {
    const counts = [...document.querySelectorAll('footer[aria-label="État du dépôt"] button')].find((button) => button.title === 'Ouvrir les modifications')
    return Boolean(counts && !counts.textContent.startsWith('0 préparé'))
  })()`, 'dirty status bar counts')

  const statusBranchTrigger = await evaluate(client, `(() => {
    const trigger = document.querySelector('footer[aria-label="État du dépôt"] button[aria-label^="Choisir une branche"]')
    if (!trigger) return false
    trigger.click(); return true
  })()`)
  assertUI('statusbar-branch-trigger', statusBranchTrigger)
  await waitFor(client, `Boolean(document.querySelector('[popover]:popover-open'))`, 'status branch menu')
  await waitFor(client, `document.querySelector('[popover]:popover-open')?.innerText.includes('main')`, 'status branch list')
  assertUI('statusbar-branch-list', await evaluate(client, `[...document.querySelectorAll('[popover]:popover-open button')].some((button) => button.textContent.includes('main'))`))
  await key('Escape')
  assertUI('statusbar-branch-menu-escape', await evaluate(client, `!document.querySelector('[popover]:popover-open')`))

  const statusJournal = await evaluate(client, `(() => {
    const trigger = document.querySelector('footer[aria-label="État du dépôt"] button[aria-label="Journal des opérations"]')
    if (!trigger) return false
    trigger.click(); return true
  })()`)
  assertUI('statusbar-journal-trigger', statusJournal)
  await waitFor(client, `document.querySelector('[popover]:popover-open')?.innerText.includes('Aucune opération récente.')`, 'operation journal menu')
  assertUI('statusbar-journal-empty', await evaluate(client, `document.querySelector('[popover]:popover-open').innerText.includes('Aucune opération récente.')`))
  await key('Escape')
  await waitFor(client, `!document.querySelector('[popover]:popover-open')`, 'operation journal closed')

  const statusCounts = await evaluate(client, `(() => {
    const button = document.querySelector('footer[aria-label="État du dépôt"] button[title="Ouvrir les modifications"]')
    if (!button) return false
    button.click(); return true
  })()`)
  assertUI('statusbar-counts-trigger', statusCounts)
  await waitFor(client, `Boolean(document.querySelector('[aria-label="Préparation du prochain commit"]'))`, 'status counts opens worktree')

  await client.send('Emulation.setDeviceMetricsOverride', { width:1024, height:768, deviceScaleFactor:1, mobile:false })
  await waitFor(client, `Boolean(document.querySelector('[aria-label="Préparation du prochain commit"]'))`, 'worktree panel at drawer width')
  const drawer = await evaluate(client, `(() => {
    const aside = document.querySelector('[aria-label="Préparation du prochain commit"]')
    const dock = aside?.parentElement
    return { position: dock ? getComputedStyle(dock).position : null, width: dock?.getBoundingClientRect().width, canvasHeight: document.querySelector('canvas')?.getBoundingClientRect().height }
  })()`)
  assertUI('inspector-drawer-overlay', drawer.position === 'absolute' && drawer.width > 300 && drawer.width < 500)
  assertUI('inspector-drawer-keeps-graph-height', drawer.canvasHeight > 400)
  await screenshot(client, 'ux-inspector-drawer-1024.png')
  await key('Escape')
  await waitFor(client, `!document.querySelector('[aria-label="Préparation du prochain commit"]')`, 'inspector drawer escape')
  await client.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false })

  assertUI('no-branches-nav-tab', await evaluate(client, `!document.querySelector('aside button[data-view="branches"]')`))

  const branchPlus = await evaluate(client, `(() => {
    const button = document.querySelector('button[aria-label="Créer une branche"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  assertUI('graph-branch-create-affordance', branchPlus)
  await waitFor(client, `document.querySelector('input[aria-label="Nom de la nouvelle branche"]') !== null`, 'inline branch input')
  await evaluate(client, `(() => {
    const input = document.querySelector('input[aria-label="Nom de la nouvelle branche"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'feature/inline')
    input.dispatchEvent(new Event('input', { bubbles:true }))
  })()`)
  await evaluate(client, `document.querySelector('input[aria-label="Nom de la nouvelle branche"]').closest('form').requestSubmit()`)
  await delay(150)
  const headSha = '0'.repeat(39) + '1'
  assertUI('graph-inline-branch-create', await evaluate(client, `(window.__toolbarCalls ?? []).some(([name, args]) => name === 'branch_create' && args.request.name === 'feature/inline' && args.request.start === ${JSON.stringify(headSha)} && args.request.checkout === true)`))
  assertUI('graph-inline-branch-editor-closes', await evaluate(client, `!document.querySelector('input[aria-label="Nom de la nouvelle branche"]')`))

  const openRefMenu = async (index) => {
    await evaluate(client, `(() => {
      const canvas = document.querySelector('canvas')
      const bounds = canvas.getBoundingClientRect()
      canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, clientX: bounds.left + 20, clientY: bounds.top + ${index} * 30 + 15 }))
    })()`)
    await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'ref context menu')
  }
  await openRefMenu(0)
  assertUI('graph-ref-menu-actions', await evaluate(client, `(() => {
    const menu = document.querySelector('[role="menu"]')
    return menu.textContent.includes('Basculer sur main') && menu.textContent.includes('Comparer à HEAD') && !menu.textContent.includes('Supprimer')
  })()`))
  await key('Escape')
  assertUI('graph-ref-menu-dismiss', await evaluate(client, `!document.querySelector('[role="menu"]')`))

  await openRefMenu(12)
  const refActions = await evaluate(client, `(() => {
    const menu = document.querySelector('[role="menu"]')
    return {
      rename: menu.textContent.includes('Renommer'),
      remove: menu.textContent.includes('Supprimer'),
      merge: menu.textContent.includes('Fusionner main dans feature'),
    }
  })()`)
  assertUI('graph-ref-menu-branch-management', refActions.rename && refActions.remove && refActions.merge)
  await evaluate(client, `(() => { [...document.querySelector('[role="menu"]').querySelectorAll('button')].find((b) => b.textContent.includes('Renommer')).click() })()`)
  await waitFor(client, `document.querySelector('input[aria-label="Nouveau nom de branche"]') !== null`, 'rename input')
  await evaluate(client, `(() => {
    const input = document.querySelector('input[aria-label="Nouveau nom de branche"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'feature/renamed')
    input.dispatchEvent(new Event('input', { bubbles:true }))
  })()`)
  await evaluate(client, `(() => { [...document.querySelector('[role="menu"]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Renommer').click() })()`)
  await delay(120)
  assertUI('graph-ref-rename-connected', await evaluate(client, `(window.__toolbarCalls ?? []).some(([name, args]) => name === 'branch_rename' && args.request.old === 'feature' && args.request.new === 'feature/renamed')`))

  await openRefMenu(12)
  await evaluate(client, `(() => { [...document.querySelector('[role="menu"]').querySelectorAll('button')].find((b) => b.textContent.includes('Supprimer')).click() })()`)
  await waitFor(client, `document.querySelector('[aria-labelledby="confirm-title"]') !== null`, 'delete confirmation')
  assertUI('graph-ref-delete-requires-typed-name', await evaluate(client, `(() => { const dialog = document.querySelector('[aria-labelledby="confirm-title"]'); const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Supprimer'); return Boolean(dialog) && confirm.disabled })()`))
  await evaluate(client, `(() => {
    const input = document.querySelector('[aria-labelledby="confirm-title"] input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'feature')
    input.dispatchEvent(new Event('input', { bubbles:true }))
  })()`)
  await evaluate(client, `(() => { const dialog = document.querySelector('[aria-labelledby="confirm-title"]'); [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Supprimer').click() })()`)
  await delay(120)
  assertUI('graph-ref-delete-connected', await evaluate(client, `(window.__toolbarCalls ?? []).some(([name, args]) => name === 'branch_delete' && args.request.name === 'feature' && args.request.confirmation.typed === 'feature')`))
  await screenshot(client, 'p3-graph-branches.png')

  // Right-click parity: every action of the reference and commit menus. The
  // commands are captured so a menu entry that renders but does nothing fails.
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__menuCalls = []
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text) => { window.__copied.push(text); return Promise.resolve() },
    } })
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'history_reset' || command === 'history_cherry_pick' || command === 'history_revert' || command === 'tag_create' || command === 'worktree_add' || command === 'branch_delete' || command === 'branch_delete_remote') {
        window.__menuCalls.push([command, args])
        if (command === 'tag_create') return { data: { name: args.request.name, targetOid: args.request.target }, generation: 2 }
        if (command === 'worktree_add') return { data: { entries: [], truncated: false }, generation: 2 }
        return { data: null, generation: 2 }
      }
      if (command === 'patch_create') {
        window.__menuCalls.push([command, args])
        return { source: 'commit ' + args.request.source.sha, text: 'diff --git a/x b/x', files: ['x'], bytes: 18, truncated: false, binary: false }
      }
      if (command === 'patch_save') { window.__menuCalls.push([command, args]); return args.request.path }
      if (command === 'plugin:dialog|save') { (window.__saveCalls ??= []).push(args.options); return '/tmp/beebranch-demo.patch' }
      return original(command, args)
    }
  })()`)
  await openRefMenu(12)
  const branchCoverage = await evaluate(client, `document.querySelector('[role="menu"]').innerText`)
  assertUI('branch-menu-covers-right-click-actions', [
    'Pousser vers origin/feature',
    'Avancer feature sur main',
    'Fusionner main dans feature',
    'Rebaser main sur feature',
    'Créer un worktree à partir d’ici…',
    'Cherry-picker ce commit',
    'Réinitialiser main sur ce commit',
    'Revenir sur ce commit (revert)',
    'Copier le nom de la branche',
    'Copier le lien de la branche',
    'Copier le lien du commit',
    'Créer un patch depuis ce commit…',
    'Copier le patch pour partage',
    'Épingler à gauche du graphe',
    'Solo',
    'Créer un tag ici…',
    'Créer un tag annoté ici…',
    'Ouvrir une merge request',
  ].every((label) => branchCoverage.includes(label)))
  await screenshot(client, 'ux-branch-menu-actions.png')

  await evaluate(client, `${menuButton('Réinitialiser main sur ce commit')}.click()`)
  await delay(60)
  assertUI('branch-menu-reset-reversible-only', await evaluate(client, `(() => {
    const text = document.querySelector('[role="menu"]').innerText
    return text.includes('Douce — garde l’index') && text.includes('Mixte — vide l’index') && !text.includes('Dure')
  })()`))
  await evaluate(client, `${menuButton('Douce — garde l’index')}.click()`)
  await delay(120)
  assertUI('branch-menu-reset-connected', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'history_reset' && args.request.mode === 'soft' && args.request.revision === '${commits[12].sha}')`))

  for (const label of ['Copier le nom de la branche', 'Copier le lien de la branche', 'Copier le lien du commit']) {
    await openRefMenu(12)
    await evaluate(client, `${menuButton(label)}.click()`)
    await delay(80)
  }
  assertUI('branch-menu-copy-actions', await evaluate(client, `window.__copied.includes('feature')
    && window.__copied.includes('https://gitlab.example.test/team/beebranch-demo/-/tree/feature')
    && window.__copied.includes('https://gitlab.example.test/team/beebranch-demo/-/commit/${commits[12].sha}')`))

  await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')) })()`)
  await delay(80)
  const graphSignature = () => evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0
    for (let index = 0; index < data.length; index += 89) hash = (hash * 33 + data[index]) >>> 0
    return hash
  })()`)
  const unpinnedSignature = await graphSignature()
  await openRefMenu(8)
  await evaluate(client, `${menuButton('Épingler à gauche du graphe')}.click()`)
  await delay(200)
  assertUI('branch-menu-pin-persisted', await evaluate(client, `(window.__preferenceSets ?? []).some((entry) => entry.input?.key === 'ui.graph.pins' && entry.input.value.includes('refs/heads/other'))`))
  await openRefMenu(8)
  assertUI('branch-menu-pin-label-toggles', await evaluate(client, `${menuButton('Désépingler du bord gauche')} !== undefined`))
  await key('Escape')
  await delay(200)
  const pinnedSignature = await graphSignature()
  assertUI('branch-menu-pin-moves-lane', pinnedSignature !== unpinnedSignature)
  await openRefMenu(8)
  await evaluate(client, `${menuButton('Désépingler du bord gauche')}.click()`)
  await delay(200)
  assertUI('branch-menu-unpin-restores-lanes', (await graphSignature()) === unpinnedSignature)

  await openRefMenu(12)
  await evaluate(client, `${menuButton('Solo')}.click()`)
  await delay(60)
  await evaluate(client, `${menuButton('Isoler feature')}.click()`)
  await delay(150)
  assertUI('branch-menu-solo-filters-graph', await evaluate(client, `document.querySelector('select[aria-label="Filtrer le graphe par branche"]').value === 'feature'`))
  await evaluate(client, `(() => {
    const select = document.querySelector('select[aria-label="Filtrer le graphe par branche"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, '__all__')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await delay(120)

  const openCommitMenu = async () => {
    await evaluate(client, `(() => {
      const canvas = document.querySelector('canvas')
      canvas.parentElement.scrollTop = 0
      canvas.parentElement.dispatchEvent(new Event('scroll'))
      const bounds = canvas.getBoundingClientRect()
      canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bounds.left + Math.max(120, bounds.width * 0.55), clientY: bounds.top + 15 }))
    })()`)
    await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'commit context menu')
  }
  await openCommitMenu()
  const commitCoverage = await evaluate(client, `document.querySelector('[role="menu"]').innerText`)
  assertUI('commit-menu-covers-right-click-actions', [
    'Checkout',
    'Créer un worktree ici…',
    'Créer une branche ici…',
    'Cherry-picker ce commit',
    'Réinitialiser main sur ce commit',
    'Revenir sur ce commit (revert)',
    'Copier le SHA',
    'Copier le lien du commit',
    'Créer un patch depuis ce commit…',
    'Copier le patch pour partage',
    'Créer un tag ici…',
    'Créer un tag annoté ici…',
    'Ouvrir une merge request',
  ].every((label) => commitCoverage.includes(label)))
  await screenshot(client, 'ux-commit-menu-actions.png')
  await evaluate(client, `${menuButton('Checkout')}.click()`)
  await delay(60)
  assertUI('commit-menu-checkout-targets', await evaluate(client, `(() => {
    const text = document.querySelector('[role="menu"]').innerText
    return text.includes('HEAD détachée sur ce commit') && text.includes('Basculer sur main')
  })()`))
  await key('Escape')
  await delay(80)

  await openCommitMenu()
  await evaluate(client, `${menuButton('Copier le SHA')}.click()`)
  await delay(80)
  assertUI('commit-menu-copies-sha', await evaluate(client, `window.__copied.includes('${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Copier le lien du commit')}.click()`)
  await delay(80)
  assertUI('commit-menu-copies-link', await evaluate(client, `window.__copied.includes('https://gitlab.example.test/team/beebranch-demo/-/commit/${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Créer un patch depuis ce commit')}.click()`)
  await delay(150)
  assertUI('commit-menu-exports-patch', await evaluate(client, `(window.__saveCalls ?? []).length === 1 && window.__menuCalls.some(([name, args]) => name === 'patch_save' && args.request.path === '/tmp/beebranch-demo.patch')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Copier le patch pour partage')}.click()`)
  await delay(120)
  assertUI('commit-menu-copies-patch', await evaluate(client, `window.__copied.includes('diff --git a/x b/x')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Créer un tag annoté ici…')}.click()`)
  await waitFor(client, `document.querySelector('[role="dialog"]') !== null`, 'annotated tag dialog')
  await fill('input[aria-label="Nom du tag"]', 'v9.9.9')
  await fill('textarea[aria-label="Message du tag annoté"]', 'notes de version')
  await evaluate(client, `([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Créer le tag')).click()`)
  await delay(150)
  assertUI('commit-menu-creates-annotated-tag', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'tag_create' && args.request.name === 'v9.9.9' && args.request.message === 'notes de version' && args.request.target === '${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Créer un worktree ici…')}.click()`)
  await waitFor(client, `document.querySelector('input[aria-label="Dossier du worktree"]') !== null`, 'worktree dialog')
  await fill('input[aria-label="Dossier du worktree"]', '/tmp/beebranch-worktree')
  await evaluate(client, `([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Créer le worktree')).click()`)
  await delay(150)
  assertUI('commit-menu-creates-worktree', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'worktree_add' && args.request.path === '/tmp/beebranch-worktree' && args.request.reference === '${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Cherry-picker ce commit')}.click()`)
  await delay(120)
  assertUI('commit-menu-cherry-pick', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'history_cherry_pick' && args.request.shas[0] === '${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Réinitialiser main sur ce commit')}.click()`)
  await delay(60)
  await evaluate(client, `${menuButton('Mixte — vide l’index')}.click()`)
  await delay(120)
  assertUI('commit-menu-reset-mixed', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'history_reset' && args.request.mode === 'mixed' && args.request.revision === '${commits[0].sha}')`))

  await openCommitMenu()
  await evaluate(client, `${menuButton('Revenir sur ce commit (revert)')}.click()`)
  await delay(120)
  assertUI('commit-menu-revert', await evaluate(client, `window.__menuCalls.some(([name, args]) => name === 'history_revert' && args.request.shas[0] === '${commits[0].sha}')`))

  // Drag a branch reference onto another one: menu, preview, confirmation.
  await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')); })()`)
  await delay(80)
  const dragPoints = await evaluate(client, `(() => {
    const bounds = document.querySelector('canvas').getBoundingClientRect()
    return { source: { x: bounds.left + 20, y: bounds.top + 12 * 30 + 15 }, target: { x: bounds.left + 20, y: bounds.top + 15 } }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, buttons:1, x: dragPoints.source.x, y: dragPoints.source.y })
  for (const ratio of [0.25, 0.5, 0.75, 1]) {
    await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', button:'left', buttons:1, x: dragPoints.source.x + (dragPoints.target.x - dragPoints.source.x) * ratio, y: dragPoints.source.y + (dragPoints.target.y - dragPoints.source.y) * ratio })
    await delay(45)
  }
  const dragGhost = await evaluate(client, `(() => { const ghost = document.querySelector('[class*=dragGhost]'); return ghost ? ghost.innerText : null })()`)
  assertUI('graph-drag-ghost', dragGhost !== null && dragGhost.includes('feature') && dragGhost.includes('main'))
  await screenshot(client, 'p3-graph-drag.png')
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, buttons:0, x: dragPoints.target.x, y: dragPoints.target.y })
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'drop menu')
  const dropMenu = await evaluate(client, `(() => { const menu = document.querySelector('[role="menu"]'); return { text: menu.innerText, hasMerge: menu.innerText.includes('Fusionner feature dans main'), hasRebase: menu.innerText.includes('Rebaser feature sur main'), hasCompare: menu.innerText.includes('Comparer feature et main') } })()`)
  assertUI('graph-drop-menu', dropMenu.hasMerge && dropMenu.hasRebase && dropMenu.hasCompare)
  assertUI('graph-drop-fast-forward', dropMenu.text.includes('Avancer main sur feature'))
  await screenshot(client, 'p3-graph-drop-menu.png')
  await evaluate(client, `(() => { [...document.querySelector('[role="menu"]').querySelectorAll('button')].find((b) => b.textContent.includes('Fusionner feature dans main')).click() })()`)
  await waitFor(client, `document.querySelector('[aria-labelledby="confirm-title"]') !== null`, 'integration confirmation')
  const integrationDialog = await evaluate(client, `(() => {
    const dialog = document.querySelector('[aria-labelledby="confirm-title"]')
    return { text: dialog.innerText, preview: (window.__p3Calls ?? []).filter(([name]) => name === 'branch_integration_preview').map(([, args]) => args.request) }
  })()`)
  assertUI('graph-integration-preview', integrationDialog.text.includes('3 commit(s) de feature') && integrationDialog.text.includes('1 commit(s) de retard') && integrationDialog.text.includes('sans mutation avant confirmation') && integrationDialog.preview.some((request) => request.mode === 'merge' && request.source === 'feature' && request.target === 'main'))
  await evaluate(client, `(() => { const dialog = document.querySelector('[aria-labelledby="confirm-title"]'); [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Fusionner').click() })()`)
  await waitFor(client, `(window.__p3Calls ?? []).some(([name]) => name === 'branch_integration_start')`, 'integration start')
  assertUI('graph-integration-start', await evaluate(client, `(() => {
    const call = (window.__p3Calls ?? []).find(([name]) => name === 'branch_integration_start')
    return call[1].request.mode === 'merge' && call[1].request.source === 'feature' && call[1].request.target === 'main' && call[1].request.confirmation.acknowledged === true
  })()`))
  assertUI('graph-integration-notice', await evaluate(client, `document.body.innerText.includes('Fusion de feature appliqué')`))
  await screenshot(client, 'p3-graph-drop.png')

  // Escape cancels an in-flight drag without opening a menu.
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, buttons:1, x: dragPoints.source.x, y: dragPoints.source.y })
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', button:'left', buttons:1, x: dragPoints.target.x, y: dragPoints.target.y })
  await delay(80)
  await key('Escape')
  assertUI('graph-drag-cancels', await evaluate(client, `!document.querySelector('[class*=dragGhost]')`))
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, buttons:0, x: dragPoints.target.x, y: dragPoints.target.y })
  await delay(120)
  assertUI('graph-drag-cancel-no-menu', await evaluate(client, `!document.querySelector('[role="menu"]')`))

  // A fetch refresh must not blank the graph or the commit inspector while
  // the new page is loading (stale-while-revalidate).
  await evaluate(client, `document.querySelector('canvas').focus()`)
  await key('ArrowDown')
  await waitFor(client, `document.querySelector('aside[aria-label="Détail du commit"]')?.innerText.includes('fix graph lanes')`, 'inspector before refresh')
  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__graphPageCalls = 0
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'repo_refresh') {
        const result = await original(command, args)
        return { ...result, repo: { ...result.repo, repoId: args.repoId }, generation: 9 }
      }
      if (command === 'graph_page') {
        window.__graphPageCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 400))
        return original(command, args)
      }
      if (command === 'commit_get') {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return original(command, args)
      }
      return original(command, args)
    }
  })()`)
  const graphLabelBefore = await evaluate(client, `document.querySelector('canvas').getAttribute('aria-label')`)
  await evaluate(client, `(() => { [...document.querySelectorAll('[aria-label="Actions Git"] button')].find((b) => b.textContent.trim() === 'Fetch').click() })()`)
  await delay(140)
  const duringReload = await evaluate(client, `(() => {
    const aside = document.querySelector('aside[aria-label="Détail du commit"]')
    return {
      label: document.querySelector('canvas')?.getAttribute('aria-label') ?? null,
      empty: document.body.innerText.includes('Historique vide'),
      panelLoading: aside ? aside.innerText.includes('Chargement du commit') : null,
      panelText: aside ? aside.innerText.includes('fix graph lanes') : null,
      refreshing: window.__graphPageCalls > 0,
    }
  })()`)
  assertUI('fetch-reload-keeps-graph', duringReload.refreshing && duringReload.label === graphLabelBefore && !duringReload.empty)
  assertUI('fetch-reload-keeps-inspector', duringReload.panelText === true && duringReload.panelLoading === false)
  await waitFor(client, `window.__graphPageCalls > 0`, 'graph refresh requested')
  await delay(450)
  assertUI('fetch-reload-stable-after', await evaluate(client, `(() => {
    const aside = document.querySelector('aside[aria-label="Détail du commit"]')
    return document.querySelector('canvas').getAttribute('aria-label') === ${JSON.stringify(graphLabelBefore)} && !document.body.innerText.includes('Historique vide') && Boolean(aside) && aside.innerText.includes('fix graph lanes')
  })()`))
  await evaluate(client, `document.querySelector('button[aria-label="Fermer le détail du commit"]')?.click()`)

  await go('rebase')
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Charger le plan'); button?.click() })()`)
  await waitFor(client, `document.querySelectorAll('main [draggable="true"]').length >= 3`, 'rebase plan')
  const beforeDragCalls = await evaluate(client, `((window.__p3Calls ?? []).filter(([name]) => name === 'history_rebase_interactive')).length`)
  const rebaseRows = await evaluate(client, `[...document.querySelectorAll('main [draggable="true"]')].map((row) => row.getAttribute('aria-label'))`)
  await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('main [draggable="true"]')]
    const transfer = new DataTransfer()
    rows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
    rows[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }))
    rows[2].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
    rows[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
  })()`)
  await delay(80)
  const afterRebaseRows = await evaluate(client, `[...document.querySelectorAll('main [draggable="true"]')].map((row) => row.getAttribute('aria-label'))`)
  assertUI('rebase-drag-reorders-preview', afterRebaseRows[2] === rebaseRows[0] && afterRebaseRows[0] === rebaseRows[1])
  assertUI('rebase-drag-no-mutation-before-start', await evaluate(client, `((window.__p3Calls ?? []).filter(([name]) => name === 'history_rebase_interactive')).length === ${beforeDragCalls}`))

  await go('workspaces')
  await waitFor(client, `document.body.innerText.includes('Produit') && document.body.innerText.includes('État par dépôt')`, 'workspaces')
  assertUI('workspaces-per-repo-status', await evaluate(client, `document.body.innerText.includes('beebranch-api') && document.body.innerText.includes('dépôt déplacé')`))
  assertUI('workspaces-bounded', await evaluate(client, `document.body.innerText.includes('/20 dépôts')`))
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Fetch tous les dépôts'); button?.click() })()`)
  await waitFor(client, `(window.__p3Calls ?? []).some(([name]) => name === 'workspace_sync')`, 'workspace fetch')
  assertUI('workspaces-isolated-failure-result', await evaluate(client, `document.body.innerText.includes('1 échec') && document.body.innerText.includes('repo.not_git')`))
  await screenshot(client, 'p3-workspaces.png')

  const a11yAudit = async (label) => {
    const report = await evaluate(client, `(() => {
      const name = (element) => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? '').trim()
      const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')]
      const unlabeled = controls.filter((element) => {
        if (element.getAttribute('aria-hidden') === 'true') return false
        if (element.tagName === 'INPUT' && element.type === 'hidden') return false
        if (['input', 'select', 'textarea'].includes(element.tagName.toLowerCase())) {
          return !name(element) && !element.closest('label')
        }
        return !name(element)
      }).map((element) => element.outerHTML.slice(0, 140))
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
      const landmarks = ['header', 'main', 'nav', 'footer'].filter((tag) => !document.querySelector(tag))
      const headings = [...document.querySelectorAll('h1, h2, h3')].filter((heading) => !heading.textContent.trim()).length
      return { unlabeled: unlabeled.slice(0, 8), duplicates, landmarks, emptyHeadings: headings }
    })()`)
    assertUI('a11y-' + label, report.unlabeled.length === 0 && report.duplicates.length === 0 && report.landmarks.length === 0 && report.emptyHeadings === 0)
    return report
  }
  await a11yAudit('workspaces')
  await go('graph')
  await a11yAudit('graph')
  await go('profiles')
  await waitFor(client, `document.body.innerText.includes('Mises à jour signées')`, 'updates settings')
  assertUI('update-settings-signature-and-no-telemetry', await evaluate(client, `document.body.innerText.includes('Manifeste signé vérifié avant installation') && document.body.innerText.includes('Aucune télémétrie') && document.body.innerText.includes('0.4.0')`))
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Vérifier les mises à jour')); button?.click() })()`)
  await waitFor(client, `document.body.innerText.includes('BeeBranch est à jour')`, 'update check')
  await a11yAudit('profiles')
  await screenshot(client, 'p3-updates.png')
  // A release published after startup must surface both in the header and as a
  // notification, and the header action installs it without a settings detour.
  await evaluate(client, `window.__scenarioUpdateAvailable = true; window.dispatchEvent(new Event('focus'))`)
  await waitFor(client, `Boolean(document.querySelector('[data-update]')) && Boolean(document.querySelector('[data-update-notice]'))`, 'header update badge and notice')
  assertUI('header-update-badge-version', await evaluate(client, `document.querySelector('[data-update]').dataset.update === '0.4.1' && document.querySelector('[data-update]').getAttribute('aria-label').includes('0.4.1')`))
  assertUI('header-update-notice-content', await evaluate(client, `(() => {
    const notice = document.querySelector('[data-update-notice]')
    return notice.dataset.updateNotice === '0.4.1'
      && notice.innerText.includes('Mise à jour 0.4.1 disponible')
      && [...notice.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Installer')
  })()`))
  await go('graph')
  assertUI('header-update-badge-survives-navigation', await evaluate(client, `Boolean(document.querySelector('[data-update]'))`))
  assertUI('header-update-notice-survives-navigation', await evaluate(client, `Boolean(document.querySelector('[data-update-notice]'))`))
  await a11yAudit('update-notice')
  assertUI('header-update-notice-in-viewport', await evaluate(client, `(() => {
    const rect = document.querySelector('[data-update-notice]').getBoundingClientRect()
    return rect.width > 0 && rect.top >= 43 && rect.right <= innerWidth && rect.left >= 0
  })()`))
  await screenshot(client, 'p3-update-notice.png')

  const installsBefore = await evaluate(client, `((window.__p3Calls ?? []).filter(([name]) => name === 'update_install')).length`)
  await evaluate(client, `document.querySelector('[data-update]').click()`)
  await waitFor(client, `(document.querySelector('[data-update-notice]')?.innerText ?? '').includes('Téléchargement 25 %')`, 'update download progress')
  await waitFor(client, `((window.__p3Calls ?? []).filter(([name]) => name === 'update_install')).length === ${installsBefore + 1}`, 'install from header')
  await waitFor(client, `document.body.innerText.includes('installée. Redémarrage…')`, 'header install completed')
  assertUI('header-installs-without-settings', await evaluate(client, `!document.body.innerText.includes('Mises à jour signées') && !document.querySelector('[data-update]') && !document.querySelector('[data-update-notice]')`))
  await screenshot(client, 'p3-update-installed.png')

  // The next check offers the release again; the notification can be postponed
  // while the header button keeps offering the install.
  await evaluate(client, `window.dispatchEvent(new Event('focus'))`)
  await waitFor(client, `Boolean(document.querySelector('[data-update]')) && Boolean(document.querySelector('[data-update-notice]'))`, 'update offered again')
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('[data-update-notice] button')].find((b) => b.textContent.trim() === 'Plus tard'); button?.click() })()`)
  assertUI('header-update-notice-dismissible', await evaluate(client, `!document.querySelector('[data-update-notice]') && Boolean(document.querySelector('[data-update]'))`))
  await evaluate(client, `window.dispatchEvent(new Event('focus'))`)
  await delay(120)
  assertUI('header-update-notice-stays-dismissed', await evaluate(client, `!document.querySelector('[data-update-notice]') && Boolean(document.querySelector('[data-update]'))`))

  // The settings page keeps its explicit confirm-then-install flow.
  await go('profiles')
  await waitFor(client, `document.body.innerText.includes('Mises à jour signées')`, 'updates settings')
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('Vérifier les mises à jour')); button?.click() })()`)
  await waitFor(client, `document.body.innerText.includes('Mise à jour 0.4.1 disponible')`, 'update offered')
  assertUI('release-notes-rendered', await evaluate(client, `(() => {
    const notes = [...document.querySelectorAll('[data-markdown="rendered"]')].find((node) => node.textContent.includes('Graphe'))
    return Boolean(notes)
      && notes.querySelector('h2')?.textContent.includes('BeeBranch 0.4.1')
      && notes.querySelector('strong')?.textContent === 'Graphe'
      && notes.querySelector('code')?.textContent === 'Markdown'
      && !notes.textContent.includes('**')
  })()`))
  await screenshot(client, 'p3-release-notes.png')
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Installer'); button?.click() })()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'install confirmation')
  assertUI('install-confirmation-mentions-auto-restart', await evaluate(client, `document.querySelector('[role="alertdialog"]').innerText.includes('redémarre automatiquement')`))
  await evaluate(client, `(() => { const button = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Télécharger et installer')); button.click() })()`)
  await waitFor(client, `[...document.querySelectorAll('main button')].some((b) => b.disabled && b.textContent.includes('Redémarrage…'))`, 'restart notice')
  assertUI('install-restarts-without-user-action', await evaluate(client, `document.body.innerText.includes('installée. Redémarrage…')`))
  await evaluate(client, `window.__scenarioUpdateAvailable = false`)

  const contrastAudit = await evaluate(client, `(() => {
    const parse = (value) => {
      const trimmed = value.trim()
      if (trimmed.startsWith('#')) {
        const hex = trimmed.slice(1)
        if (hex.length === 6) {
          return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16), 1]
        }
        if (hex.length === 8) {
          return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16), parseInt(hex.slice(6,8),16)/255]
        }
      }
      const start = value.indexOf('('); const end = value.indexOf(')')
      if (start < 0) return [0,0,0,1]
      const parts = value.slice(start + 1, end).split(',').map(Number)
      return [parts[0], parts[1], parts[2], parts[3] ?? 1]
    }
    const luminance = (rgb) => {
      const [r, g, b] = rgb.slice(0, 3).map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => {
      const one = luminance(a); const two = luminance(b)
      return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
    }
    const styles = getComputedStyle(document.documentElement)
    const token = (name) => parse(styles.getPropertyValue(name))
    const report = {}
    for (const theme of ['dark', 'light']) {
      document.documentElement.dataset.theme = theme
      const colors = getComputedStyle(document.documentElement)
      const value = (name) => parse(colors.getPropertyValue(name))
      const pairs = {
        textOnBg: ratio(value('--text'), value('--bg')),
        mutedOnSurface: ratio(value('--muted'), value('--surface')),
        accentContrast: ratio(value('--accent-contrast'), value('--accent')),
        laneMin: Math.min(...[1,2,3,4,5,6].map((index) => ratio(value('--lane-' + index), value('--bg')))),
      }
      report[theme] = pairs
    }
    document.documentElement.dataset.theme = 'dark'
    return report
  })()`)
  assertUI('contrast-tokens', contrastAudit.dark.textOnBg >= 7 && contrastAudit.dark.mutedOnSurface >= 4.5 && contrastAudit.dark.accentContrast >= 7 && contrastAudit.dark.laneMin >= 3 && contrastAudit.light.textOnBg >= 7 && contrastAudit.light.mutedOnSurface >= 4.5 && contrastAudit.light.accentContrast >= 7 && contrastAudit.light.laneMin >= 3)

  await evaluate(client, `document.documentElement.dataset.density = 'compact'`)
  const compact = await evaluate(client, `(() => { const style = getComputedStyle(document.documentElement); return { text: style.getPropertyValue('--text-size').trim(), row: style.getPropertyValue('--row-height').trim(), body: getComputedStyle(document.body).fontSize } })()`)
  assertUI('density-compact-tokens', compact.text === '13px' && compact.row === '26px' && compact.body === '13px')
  await screenshot(client, 'p3-density-compact.png')
  await evaluate(client, `document.documentElement.dataset.density = 'comfortable'`)
  assertUI('density-restored', await evaluate(client, `getComputedStyle(document.body).fontSize === '15px'`))

  await evaluate(client, `document.querySelector('.skip-link')?.focus()`)
  assertUI('skip-link', await evaluate(client, `document.activeElement.classList.contains('skip-link') && document.activeElement.getAttribute('href') === '#main-content'`))
  await evaluate(client, `document.querySelector('main').focus()`)
  assertUI('skip-link-target', await evaluate(client, `document.activeElement.id === 'main-content'`))
  await screenshot(client, 'p3-light.png')

  await writeFile(join(outDir, 'ux-checks.json'), JSON.stringify(uxChecks, null, 2))

  console.log(JSON.stringify({
    ok: true,
    ux: uxChecks,
    density,
    p2: p2Checks,
    typography,
    contrast,
    clone: projectPicker,
    graph: graphStats,
    repoChangeRefresh,
    diff: diffStats,
    p1: { stagedLine, calls: p1Calls.slice(0, 2), viewChecks },
    screenshots: [graphPath, diffPath],
  }, null, 2))
  client.close()
} finally {
  browser.kill('SIGTERM')
  server.close()
}
