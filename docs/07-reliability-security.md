# 07 — Reliability and security

## 1. Reliability invariants

1. **No silent destructive operations.** Every action that can delete work is confirmed with its exact consequences.
2. **The repository's actual status is always displayed.** Merge, rebase, cherry-pick, conflict, detached, lock: visible before any action.
3. **No manual writes to `.git`.** Only through Git.
4. **No automatic lock deletion.** An `index.lock` is reported, never deleted without explicit action and verification.
5. **No silent loss of untracked files.** The application never deletes untracked files; discard only affects tracked content and is explicitly irreversible.
6. **Every partial operation is visible and recoverable.** No silent rollback.
7. **The user's Git configuration is respected** (hooks, LFS, signatures, autocrlf, pull.rebase, credential helpers).
8. **A feature is not complete unless its actual behavior has been verified.**

## 2. Preflight and confirmations

### Sensitive action matrix

| Action | Preflight | Confirmation | Reversible |
|---|---|---|---|
| Discard file/hunk | file unchanged since display | yes, with diff | **no** |
| Reset --hard | worktree status, untracked | yes, explicit text | **no** |
| Branch deletion | merged? current? upstream? | yes; strong if not merged | yes (ref/SHA) |
| Force push | upstream, expected remote SHA | yes, branch name must be typed | **no** (separate action) |
| Worktree deletion | uncommitted changes | yes | yes (Git refuses if dirty) |
| Stash drop | selected stash | yes | **no** |
| Tag deletion | remote? | yes | yes (object) |
| Merge/rebase abort | resolutions in progress | yes, loss of resolutions | **no** |
| Remote removal | associated refs | yes | yes (URL/refspec) |
| Closing a tab with an operation in progress | active operation | yes | — |

### Rules

- Preflight runs **immediately before** the command, not when displayed.
- Confirmations describe the actual effect: number of files, branches, commits, affected remote.
- No “Don't ask again” for destructive actions.
- Irreversible actions are announced as such; no application backup is created.
- Actions reversible through Git (commit, stage) do not require confirmation.
- A `--force` is never added implicitly to make a command succeed.

## 3. Concurrency and external changes

- A single mutation queue per repository.
- Reads are blocked during a destructive mutation.
- Before each mutation: fingerprint verification (HEAD, index, status, affected refs).
- If another Git process is active: `index.lock`/`HEAD.lock` → `repo.busy`, with an explanation.
- The watcher detects external changes and invalidates affected caches.
- A stale read response is ignored using the generation.
- No application lock replaces Git locks; no lock file is created in `.git`.

### Critical race

Preflight does not guarantee the absence of a race with an external process. The final guarantee comes from Git (locks, refusal to overwrite). The corresponding errors are mapped and displayed; the status is revalidated.

## 4. Crash recovery

- SQLite journal: `operation_id`, type, status (`queued`, `running`, `done`, `failed`, `cancelled`, `interrupted`), timestamps, steps.
- At startup:
  1. `running` operations become `interrupted`;
  2. the repository's status is recalculated;
  3. residual locks are **reported**, not deleted;
  4. a recovery panel offers safe actions (`abort`, `continue`, check the remote).
- Uncommitted work is never restored automatically.
- No application backup is retained; recovery relies on the repository's actual status and the Git reflog.

## 5. Error experience

- Message in French, one action-oriented sentence.
- Technical cause available in the details.
- Concrete remediation (equivalent Git command, setting, link).
- Stable code for the UI and tests.
- Network errors never block the local tab.
- Hook output is displayed, not summarized as “failed”.

## 6. Threat model

| Asset | Threat | Measure |
|---|---|---|
| GitLab token | leak through logs, URL, frontend, crash report | OS keychain in release, 0600 file in development build, redaction, never in the URL |
| Working tree | loss through discard/reset/clean | explicit confirmation, preflight, no untracked file deletion |
| Repository | corruption through direct writes | Git only |
| Local configuration | command execution through `.git/config` or filters | warning on opening, transparency |
| GitLab content | XSS through Markdown/HTML | sanitized Markdown rendering, raw HTML prohibited, remote images blocked by default |
| Dependencies | compromise | pinned versions, audit, minimal surface |
| Network | MITM | verified TLS, explicit CA |
| Binary | malicious update | signing, verification |

### Executable repository configuration

A repository may contain local configuration (`filter.*.clean/smudge`, `core.fsmonitor`, `core.sshCommand`, `credential.helper`) that launches commands during Git operations. On opening:

- detect local keys that define an external command;
- display a warning listing the keys and values;
- do not execute an opening command;
- let the user continue or open read-only;
- never modify configuration without explicit action.

Hooks are not versioned, but may exist locally. Their output is always displayed.

### Remote content

- Markdown rendered as React elements: no raw HTML tags are injected.
- Remote images blocked by default (prevents IP tracking); explicit activation per instance or MR.
- Links opened in the system browser, `https` schemes only.
- No script execution in the webview.

## 7. Secrets

- PAT and secrets in the OS keychain for release builds.
- Development builds: `secrets-dev.json` (0600) in the data directory.
  macOS keys the OS keychain ACL to the binary's signature; each
  recompilation of an unsigned binary invalidates “Always Allow” and
  triggers a password prompt on every launch. A one-shot migration
  reads the existing token (at most one final authorization), copies it
  to the file, then never reads the OS keychain again. The development file
  must never be used in release.
- Backend API only; the frontend receives a “connected” boolean, never the token.
- Centralized redaction: `PRIVATE-TOKEN`, `Authorization`, `user:pass@`, `access_token`, `private_token` parameters.
- Git errors may contain URLs with credentials: redaction before display/logging.
- Crash reports and diagnostic exports are filtered.
- Token rotation/deletion: explicit action in settings.

## 8. Command execution

- Allowlist of subcommands and options.
- No `sh -c`, `cmd /c`, `powershell`.
- No interpolation of messages, branch names, or paths into a command string.
- Paths are passed as `OsString` and after `--` where applicable.
- Options from the frontend are validated by type (enum), not as free-form strings.
- Commands run in the worktree directory, never in an arbitrary `cwd`.
- Environment variables that allow configuration injection are filtered.

## 9. TLS and network

- TLS verification enabled by default.
- Importable internal CA (PEM), stored locally, associated with the instance.
- No “ignore TLS” setting in the MVP.
- Explicit proxy or standard variables, documented.
- Network timeouts and backoff; no retries for non-idempotent mutations.

## 10. Webview

- Restrictive CSP: `default-src 'self'`; no remote scripts; no `unsafe-eval`.
- No remote content loaded into the webview other than explicitly allowed images.
- Tauri command isolation through minimal capabilities.
- Unused APIs (fs, shell, http) disabled on the frontend.
- External links through a scheme allowlist.

## 11. Dependencies and build chain

- Pinned versions (`Cargo.lock`, frontend lockfile).
- Regular audits (`cargo audit`, npm audit).
- Minimized number of direct dependencies; justify every addition.
- Reproducible build as far as possible.
- Signed binaries and macOS/Windows notarization.

## 12. Reliability and security tests

| Test | Expected |
|---|---|
| Process kill during fetch | status reported, repository recoverable, no lock deleted automatically |
| Kill during commit | status recalculated, no file lost |
| Irreversible action | no undo offered, explicit confirmation, no copy created |
| Disk full | actionable error, no partial file left by the application |
| Permission denied | actionable error, no infinite retries |
| `index.lock` present | `repo.busy`, no deletion |
| Failing hook | output displayed, commit not created |
| Missing signature | explicit error, no workaround |
| Expired token | auth event, cached views |
| Self-signed TLS not imported | TLS error, no bypass |
| Malicious Markdown | no script executed, no raw HTML |
| Repository with local filter | warning, no implicit execution |
| Force push | typed confirmation, previous SHA recorded |
| Diagnostic export | no token, no URL with credentials |
| Platforms | same tests on Windows/macOS/Linux |

Security tests check artifacts (logs, exports, SQLite database), not just the UI.

## P3 — Undo, distribution, and no telemetry

- **Undo**: SQLite `undo_records` journal, HEAD/index/status/refs/
  file fingerprints, preconditions checked before every mutation. Each step is
  journaled before execution; a crash marks `restoreInterrupted` and does not
  replay anything. No worktree copy is created.
- **Updates**: minisign-signed artifacts. The Tauri plugin verifies the
  signature before installation; a missing or invalid signature returns
  `update.signature_invalid`. The `latest.json` manifest is never executed.
  Rollback uses `rollback.json`, also signed, with confirmation.
- **Packaging**: macOS signed/notarized (hardened runtime + entitlements),
  Windows signed (Authenticode, timestamp), Linux `.deb`/`.rpm`/AppImage. Release
  CI verifies each platform's signature before publication.
- **No telemetry**: `scripts/audit-no-telemetry.mjs` audit of the
  sources; only GitLab connections (configured by the user), Git
  (remotes), and the signed update manifest are possible. No sending
  without user action.
