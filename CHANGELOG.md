# Changelog

## [1.0.1] — 2026-10-30

### Corrigé

- **Authentification HTTPS (#8)** : fetch, pull, push et la lecture du SHA distant
  réutilisent les identifiants GitLab/GitHub connectés lorsque les helpers Git
  existants n’en fournissent pas. Les tokens PAT et OAuth restent limités à leur
  hôte et port HTTPS, dans des fichiers temporaires privés supprimés après
  l’opération.

## [Unreleased]

### Added

- **Squash a selection**: the graph selection bar combines a contiguous range
  into one commit, with the combined messages editable before confirmation.
  Merge commits, gaps and non-descendant ranges are refused with an explicit
  reason; the operation is undoable.
- **Tag lifecycle**: annotate an existing lightweight tag, fast-forward a tag to
  a descendant commit (annotation preserved), and filter tags by name or
  message.
- **Worktrees**: repair moved worktree metadata, remove a worktree together
  with its branch, prune with an expiry and a report of the removed entries,
  and filter the list by path or branch.
- **Submodules**: optional automatic update after a successful fetch or pull,
  recursive option honoured by single-entry actions, explicit `--force` on add
  (never implied), and nested entries indented.
- **Synchronization**: fetch every remote in one action with per-remote
  results, configurable automatic fetch interval, persisted pull strategy, and
  outcome details (tip before/after, remaining distance to upstream).
- **Activity log**: a new panel lists every action the interface issues, with
  its duration and outcome, scoped to the current repository or to the
  application. It is in-memory, bounded to 2000 entries, filterable and
  clearable, and never stores arguments.
- **Commit hooks**: a *Skip hooks* option disables every hook for one commit
  without persisting the choice, and a `git.hooksPath` preference overrides the
  hooks directory for the commit without touching the repository configuration.
- **File preferences**: the read encoding (UTF-8, UTF-16 LE, Windows-1252 or
  automatic detection) is configurable and applied when opening a file; writing
  never re-encodes. Settings expose the hooks path next to it.
- **Shortcuts**: a stored map with duplicate bindings no longer falls back
  silently — the conflicting actions return to their default and the settings
  panel lists them.
- **File history**: a base revision selector, an author colour that is stable
  across reloads, a *View diff* action at the chosen revision, and a per-file
  history entry in the commit panel.
- **Search**: live results after a short debounce (a newer query cancels the
  previous one), and saved searches per repository, creatable, applicable and
  removable from the panel.
- **Diff viewer**: word wrap (persisted; disabled above 600 lines because the
  virtualised renderer needs fixed row heights, with the reason in the tooltip),
  a mini-map showing the viewport and jumping on click, and previous/next file
  navigation.
- **Reference visibility**: hide or show a branch, tag or remote branch from the
  graph; the checked-out branch always stays visible. The isolated filter and
  the hidden references are stored per repository and restored on restart.
  Hiding never touches the repository.
- **Commit signing**: the settings choose to inherit, always or never sign, with
  an optional signing key and format (OpenPGP, SSH, X.509) applied to the
  commits created in the application only. The commit panel shows Git's
  verification code (`G`, `B`, `U`, `N`, …) instead of guessing.
- **In-app file editing**: a file opened from a working-tree diff can be edited
  and written back, saved alone or saved and staged in one action. The write is
  atomic, keeps the configured encoding (UTF-8, UTF-16 LE, Windows-1252 — an
  unrepresentable character is refused rather than mangled), and carries the
  SHA-256 of the bytes the editor started from so a file modified outside the
  application is refused instead of overwritten. Markdown files get a preview
  toggle; binary and truncated files are read-only.
- **Workspaces**: pick the repositories a batch acts on, choose the pull
  strategy applied to the batch, open the selection in the configured editor,
  export the workspace as a `.code-workspace` document, and import one — invalid
  folders are reported, never guessed. Cloning a missing repository stays manual:
  a workspace stores paths, not remotes.

### Changed

- Development and contributions on `dev`, with local validation and checks on
  PRs to `dev`/`main`. Development pushes no longer start CI.
- Publication after a successful CI run of a push to `main`, at the validated
  commit, only for a version without an existing tag; manual re-run kept from
  `main` for a tag of that branch.
- Pull strategy `pull.rebase=merges` is honoured as `--rebase=merges` instead
  of falling back to a merge.

### Fixed

- Interactive rebase: the replacement messages are written inside the Git
  directory and kept until the operation ends, so a paused rebase (conflict,
  `edit` stop) resumes instead of failing on a deleted message file. An `edit`
  stop can now be amended from the rebase panel and finished with Continue.
- Synchronization: Pull and Push emit their operation identifier like Fetch, so
  the cancel button is usable; the branch field now states that Pull integrates
  the chosen remote branch into the current branch and Push publishes the
  current branch under that remote name.
- Worktrees: a detached worktree can no longer be created together with a new
  branch (Git refuses the combination); the form disables the field and the
  backend rejects it with an explicit error.
- Patches: `git apply --3way` implies `--index`, so the confirmation, the
  report and the notice now state that the change is staged.
- Remote URLs: `ssh://git@host/repo` and `https://user@host/repo` are accepted;
  a password configured outside the application is masked before display.
- Tags: the tag can be deleted from a chosen remote without deleting it
  locally; an unknown field on the local deletion is rejected instead of
  silently ignored.
- Submodules: open a submodule as its own repository, and remove it
  (deinit, index, `.gitmodules`, working tree) with a typed confirmation.
- Workspaces: a late status response from a previously selected workspace can
  no longer replace the current one.
- Stash: a `pop` that conflicts reports the conflicts and states that the stash
  was kept.
- Search: path and content results expose their next page like commits.
- File history: the diff view opens the history of the visible file.
- GitLab: inline review comments accept the payload the interface sends
  (`camelCase`); `rebase_merge` is no longer offered since GitLab applies it
  through a separate asynchronous call.
- GitHub: a pull request found outside the cached repositories opens in its own
  repository; CI badges use the loaded checks; discussions and jobs expose
  their next page.
- Clone into an existing parent directory (for example `Dev`): automatic
  creation of the subdirectory named after the repository, with the path
  preview updated according to the project or URL. The other repositories in
  the parent stay untouched; an already populated target subdirectory is still
  refused by Git.

## [1.0.0] — 2026-10-29

### Added

- **Internationalized interface (French / English)**: all interface text goes
  through a typed catalogue (`src/i18n/`) — no visible string hard-coded in
  components. The language follows the system on first launch (English outside
  French-speaking systems), is set in Settings → General and persists under
  `ui.language` without restart. Dates and numbers use the active language
  format. Backend error messages are translated by their stable code, and the
  undo/redo labels stored in the database are translated through their
  templates. The splash and the `lang` attribute follow the same language.
- **Workspace selector**: the active workspace stays visible in the tab bar and
  a selector (dropdown or `⌘⇧W`, also present in the command palette) opens the
  repositories of the chosen workspace at once, in the recorded order. An
  already open repository is reused instead of duplicated; tabs specific to
  other workspaces are closed, while a tab with a running Git operation or
  conflicts stays open. The last active repository of the workspace regains
  focus on return, otherwise the first. The active workspace and the last
  repository are persisted (`ui.activeWorkspace`, `ui.workspaceLastRepo`).
- **Public repository under AGPL-3.0**: `LICENSE`, license metadata in
  `Cargo.toml` and `package.json`, public `README`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, Dependabot and
  dependency review.
- **Releases in the main repository**: the `publish` job creates the release in
  `github.repository` with the Actions `GITHUB_TOKEN`; no more mirror
  repository, no more `RELEASE_REPO_TOKEN`. The compiled endpoint and the local
  build fallback point to the same `releases/latest/download/latest.json` URL.
- **GitLab / GitHub onboarding without a new token**: connecting queries
  `git credential fill` for the instance host and reuses the macOS keychain,
  the Windows Credential Manager or `gh auth git-credential`. A "Use my Git
  credentials" button connects an instance without a Personal Access Token; the
  secret stays managed by Git (never copied into the application keychain,
  SQLite or logs). The request is bounded to 5 s, with no terminal prompt or
  GCM window. The form also offers the token creation page with the required
  scopes pre-filled.
- **GitHub sign-in via OAuth device flow**: "Sign in with GitHub" shows a code
  to enter in the browser (`repo read:user` scopes) and only exchanges the
  `device_code` on the backend. The `gho_` token is validated then stored in
  the keychain. The public client ID of the BeeBranch OAuth App (Device Flow
  enabled) is embedded; `BEEBRANCH_GITHUB_CLIENT_ID` points to another app
  (fork, local test). Limited to `github.com`: GHES requires its own OAuth App.
- **GitLab.com sign-in via OAuth device flow**: "Sign in with GitLab.com" shows
  a code to enter in the browser (`api`, `read_user`, `read_repository` scopes)
  and never returns the `device_code` to the frontend. Tokens are stored
  together in the keychain and the access token (2 h) is renewed in the
  background via the refresh token, with rotation; a session expired for good
  emits `gitlab://auth-expired` and returns to the sign-in screen. Enabled via
  `BEEBRANCH_GITLAB_CLIENT_ID` (public Application ID). Limited to gitlab.com:
  a self-hosted instance requires its own OAuth application.

### Changed

- **Sanitization before publication**: removal of the private key archive
  `src-tauri/keys.zip`, anonymization of the self-hosted GitLab instance and of
  local paths in the review evidence.
- **Secondary screens aligned with history**: Merge requests, Pull requests,
  Search, Interactive rebase, File history, Worktrees, Tags, Remotes,
  Submodules, Patches and Synchronization switch to the same visual language
  as the graph. Each screen becomes a full-width surface with a toolbar, dense
  rows separated by a hairline and a tinted selection with an accent bar;
  floating cards and duplicated titles disappear in favor of the view bar.
  Action stacks become intent/control rows, statuses always pair a label with
  their pill, and errors stay displayed instead of scrolling away.
- **Review creation dialog**: creating a merge request or a pull request leaves
  the thread for a dedicated dialog (source, target, title, description, draft,
  merge options), which frees space for the detail.
- **Confirmed destructive actions**: interactive rebase, worktree prune and
  worktree locking require an explicit confirmation; the lock reason is entered
  in the dialog instead of a global field.
- **Search**: filters grouped in a dedicated bar, displayed scope, dense
  results (SHA, paths, lines) and persistent pagination.
- **Synchronization**: progress becomes a full-height side panel with a
  scrolling console and cancellation in the same place.

### Fixed

- **Stashes in the graph**: each stash is now inserted at its date in the
  history instead of being stacked at the top; a stash from last month no
  longer appears above this week's commits. The context menu of a stash row
  offers Apply, Apply and drop and Delete (irreversible confirmation), and the
  stash detail also lists the untracked files, stored in Git's `untracked`
  snapshot.
- **Explicit fast-forward on merge**: merging a branch whose target is an
  ancestor of the source now advances the target to the last source commit,
  without a merge commit. The dialog offers "Fast-forward" or "Merge commit
  (`--no-ff`)", with fast-forward selected when possible; otherwise the reason
  is displayed (the target has N commit(s) missing from the source) and the
  merge commit stays available. The engine passes `--ff`, `--ff-only` or
  `--no-ff` explicitly: `merge.ff=false` in the Git configuration no longer
  turns a requested fast-forward into a merge commit, and `--ff-only` refuses
  before any checkout when the target has diverged
  (`git.merge_not_fast_forward`, alternatives announced).
- **Middle click on the "Open a repository" tab**: the tab now closes on middle
  click, like repository tabs. The launcher was rendered separately and did not
  listen for `auxclick`; it now shares the same gesture and will also block the
  middle-button autoscroll.

## [0.7.2] — 2026-10-29

### Added

- **Custom wallpaper**: Preferences → General accepts an image or an animated
  GIF (png, jpg, gif, webp, avif, bmp, 32 MB maximum) via the native picker.
  The file is never exposed to the webview: the backend reads it and inlines it
  as a `data:` URL, only the path is persisted. Fit (cover, contain, tile), dim
  and blur settings; panels become semi-transparent for as long as the image
  stays readable. The GIF is animated by the webview, with no decoding code.
- **Custom splash screen**: Preferences → General offers a background for the
  launch window, with the same formats, limit and settings (fit, dim, blur) as
  the wallpaper. The splash window reads the `ui.splash` preference over IPC and
  receives the image as a `data:` URL; it stays hidden until the mode is
  resolved, so the default logo never flashes before a custom image. An
  unreadable file at launch silently falls back to the logo, and the selection
  is validated on save.

### Fixed

- **Unusable repository on Windows**: "The repository is not open. Open the
  repository before reading its status." appeared as soon as a repository was
  opened. The session registry was indexed by the path returned by
  `fs::canonicalize` (`\\?\C:\Dev\repo`) while the identifier returned to the
  interface came from `git rev-parse --show-toplevel` (`C:/Dev/repo`): the two
  hashes differed, so state, status, refs and graph never found their session
  again. The registry is now indexed by the session identifier, and
  `RepoId::from_path` normalizes the verbatim prefix, the separator and the
  drive letter case — POSIX paths stay unchanged, so already persisted
  macOS/Linux identifiers are preserved.

## [0.7.1] — 2026-10-29

### Added

- **Repository opening tab**: ⌘/Ctrl + T (and the `+` button) opens the home tab
  with the recent repositories search field focused and a reset query; the
  filter covers the name and the path, the list shows "N of M repositories",
  Enter opens the first result and no match is reported. The shortcut appears
  in Preferences → Shortcuts and in the palette.

### Fixed

- **Fetch, pull and push reported as successful while Git was failing**: the
  engine did not check the exit code of synchronization commands, so a refused
  pull (diverged branch, impossible fast-forward, refused credentials, untracked
  file in the way) displayed "Pull complete." with no error and no change. The
  exit status is now checked and the failure surfaces with the Git output and a
  remediation (`git.pull_not_fast_forward`, `git.pull_strategy_missing`,
  `git.dirty_worktree`, `git.untracked_collision`, `auth.*`…).
- **Visible pull result**: the toolbar states what the pull actually did
  (`Pull: already up to date.`, `Pull: abc1234 → def5678.`, or
  `Incomplete pull: N commits still behind.`) instead of the same
  "Pull complete." in all cases. This message is cleared when switching tabs:
  it no longer describes another repository.
- **Pull strategy respected**: `branch.<name>.rebase` is read before
  `pull.rebase`, then `pull.ff`, as Git does; previously only `pull.rebase` was
  consulted and `--no-rebase` was imposed, which forced a merge on users
  configured for rebase or `pull.ff=only`.

## [0.7.0] — 2026-10-29

### Added

- **Splash screen**: a small frameless window (460 × 280) plays the BeeBranch
  logo animation at launch, then gives way to the main window as soon as the
  interface has performed its first render — the main window stays hidden
  during the animation, with no empty-window flash. The splash screen is styled
  from its first frame, displayed for at least 2.4 s (reduced animation if
  `prefers-reduced-motion`), and an 8 s safety timeout guarantees the main
  window opens even if the frontend does not respond.
- **GitHub integration**: connection to github.com or GitHub Enterprise Server
  via a Personal Access Token (stored in the `beebranch.github` keychain),
  repository listing and search, repository ↔ GitHub project matching, pull
  requests (my PRs, to review, assigned, project), creation, reviews and
  approvals, review comments, CI checks and Actions job logs. The graph badges
  and the clone picker support GitHub in addition to GitLab, without ever
  mixing the two providers (`gh_` instance identifiers, separate session and
  keychain). Limitations accepted from the REST API: thread resolution,
  auto-merge and branch deletion on merge stay in the GitHub interface.
- **Repository opening screen**: the `+` button of the tabs opens an "Open a
  repository" tab that reuses the home screen as in GitKraken — recent
  repositories, opening a local folder, creating a repository and cloning. The
  clone form is displayed in that tab (the separate clone dialog disappears);
  Escape or the cross close the tab and focus returns to the `+` button.
- **Browser-style repository tabs**: middle click closes the tab, drag and drop
  reorders repositories (insertion indicator, Escape cancels) and the order is
  kept from one session to the next via `ui.openRepos`.
- **Multiple file selection**: checkboxes in "To stage" and "Ready to commit",
  range with Shift+click, grouped Stage / Unstage / Discard actions, and a
  detailed confirmation before a multiple discard.
- **Changed files tree**: "To stage", "Ready to commit" and "Conflicts" group
  by collapsible directory, with single-child directories compacted (`a/b/c`)
  and the file count of each directory. The view option is remembered
  (`ui.status.view`); ignored files remain a flat list.
- **Interactive status bar**: branch, counters, conflicts, running operation
  and GitLab status are clickable; the Operations menu shows the recent journal
  and allows undoing the last operation.
- **Commit from the keyboard**: ⌘/Ctrl + Enter creates the commit from the
  message; the success return allows copying the SHA or undoing the commit.
- **Drawer inspector**: below 1120 px, the commit detail, the comparison and
  the commit preparation are displayed as an overlay without compressing or
  stacking the graph. Escape closes the drawer.
- **Stashes in the graph**: each stash is a node at the top of the history,
  drawn as in GitKraken (rounded dotted square medallion with a chest) and
  labeled with the entered message; its `index` and `untracked` snapshots no
  longer pollute the tree.
- **Full right-click menu on the graph**: the menu of a commit and that of a
  branch cover checkout (list expanded in the menu), worktree, cherry-pick,
  soft or mixed reset, revert, copying the SHA and web links, creating or
  copying a patch, lightweight and annotated tags, fast-forward pull, push,
  upstream, fast-forward / merge / rebase between branches, local, remote or
  both deletions, copying the branch name, pinning to the left, solo and
  opening a merge request. The reset only exposes reversible modes (`--hard`
  stays refused).
- **Pin to the left**: a pinned branch keeps its lane in the first graph column
  from its tip, and the choice is kept per repository (`ui.graph.pins`).
  **Solo** isolates a branch in the graph filter without touching the
  repository.
- **Worktree, tags and patch from the graph**: two dedicated dialogs create a
  worktree at the clicked reference or a tag (annotated with its message) on
  the targeted commit. A commit patch can be saved via the native dialog or
  copied for sharing — no network send.

### Changed

- **Bounded interface zoom**: ⌘/Ctrl + `+` or `-` adjusts the zoom in 10% steps
  between 50% and 200%, ⌘/Ctrl + `0` resets it. The wheel and pinch no longer
  change the zoom, even with ⌘/Ctrl.
- **Graph rounding direction**: a branch that joins its parent keeps its column
  up to the parent line and curves above the median, instead of leaving its
  column on the starting commit line. Only a secondary parent opens a column
  under the commit. The drawing takes the direction of GitKraken junctions.
- **Progressive toolbar**: Fetch, Pull and Push keep their labels; secondary
  actions switch to icons then into the Actions menu. The "Search" button
  becomes "Commands" to distinguish it from Git search.
- **Feedback**: short flash on staging, operation-change animation and
  discreet appearance of commit success.

## [0.6.4] — 2026-10-28

### Added

- **Local repository creation**: "Create a local repository…" initializes a
  Git repository in a new or existing unversioned folder, with optional initial
  branch and path preview. Present files stay untracked; an existing repository
  (worktree or bare) is refused. The repository opens immediately in a new tab.
- **Interface zoom**: ⌘/Ctrl + `+` or `-` adjusts the native zoom in 20% steps,
  ⌘/Ctrl + `0` resets it. Ctrl + wheel also works on macOS and Linux; the
  shortcuts are recalled in the settings.

## [0.6.3] — 2026-10-28

### Added

- **Amend from the graph or the diff**: the context menu of a HEAD commit and
  its name in the diff offer "Amend this commit…". The dialog reuses the
  message (editable), includes staged files, signals the history rewrite and
  goes through the existing amend flow (hooks, signature, undo). The action
  only appears for HEAD and outside a Git operation.
- **Rendered Markdown files**: in the diff of a `.md` file, the "Rendered"
  button displays the formatted document (headings, lists, tables, code)
  instead of the patch. The content is read at the diff revision — working
  copy, index, commit or end of a comparison — and the return to "Diff" is
  immediate. Raw HTML is ignored, images stay blocked and only `https` links
  open in the system browser.

### Changed

- **A→B comparison: the graph footer fades out**: during a comparison, the
  status row under the commits disappears to leave the full useful height to
  the inspector and the patch, then returns when the comparison closes.

### Fixed

- **Release notes rendered as Markdown**: the signed manifest carries the notes
  from `docs/releases/*.md`, but the settings displayed them as-is. They are now
  rendered: headings, lists, bold and code, without ever injecting raw HTML.
- **Double-click on a remote branch of a shared commit**: double-clicking in
  the graph activated the first reference decorating the line instead of the
  targeted badge, so sometimes another local branch at its current commit. The
  badge under the cursor is now resolved; a lagging local tracking branch is
  still placed back on the remote commit before checkout.
- **A clicked file in a commit opens its own diff**: the path was correctly
  passed by the commit detail, but the diff command ignored it for the `commit`
  target and returned the whole commit patch, whose view always displayed the
  first file. The path now filters the output, root commit without parent
  included.

## [0.6.2] — 2026-10-28

### Added

- **Comparison of two commits only (⌘/Ctrl+click)**: after clicking a commit,
  ⌘+click (Ctrl+click on Windows/Linux) on another opens the A → B diff between
  those two trees, even if commits lie between them. The comparison lists only
  the two endpoints and the selection contains only them, which also applies to
  Cherry-pick and Revert; Shift+click keeps the range selection.

### Changed

- **Compact branch list on hover**: the header (SHA) and the footer disappear,
  the type label leaves each row and only the icon and the name remain, on
  24 px rows and a width adjusted to the longest name (260 px maximum). The
  type and the double-click remain available in the tooltip and the accessible
  label of each row.

### Fixed

- **A→B comparison diff finally readable**: the patch is no longer rendered
  under the file list, in the narrow inspector where the header, the commits
  and the list left it only a few pixels. The list now fills the inspector
  height and scrolls.
- **Clicking a compared file opens its diff in the central region**, in place
  of the graph, with the file path and its close button; a second click on the
  same row, the × button or a click on a commit brings the graph back. The
  comparison and its list stay displayed on the right.
- **`origin/HEAD` no longer decorates commits**: this symbolic reference
  designates the remote default branch, already displayed on the same commit;
  Git nevertheless includes it in its decorations. The badges and the hover
  list now hide it, which removes a misleading "remote" row.

## [0.6.1] — 2026-10-28

### Added

- **Commit range selection**: after a click, Shift+click on another commit
  selects all commits between the two, from the anchor toward the click;
  Shift+↑/↓ extends the range from the keyboard. The selection is ordered from
  oldest to newest, which is the application order of Cherry-pick and Revert,
  and the A→B diff opens on the range.

### Changed

- **Comparison panel readable as in GitKraken**: the header announces the
  number of selected commits and "Diff of N commits", then lists each compared
  commit (subject, date, author, SHA) from newest to oldest. Files go from a
  flat list to a collapsible tree, single-child directories compacted
  (`src/app/components`), with a Path / Tree toggle; the open file keeps its
  path and its statistics above the diff. In Unified mode, changed words are
  now underlined as in Side by side.
- **"Compare" on the whole selection**: beyond two checked commits, the button
  compares the selection from oldest to newest instead of requiring exactly
  two commits; the order list compacts to `N commits · sha…sha` so it no longer
  displays one chip per commit.

## [0.6.0] — 2026-10-28

### Added

- **Update installed from the header**: a notification offers the signed
  version as soon as it is published, with the real download progress and a
  possible postponement; the update icon in the top bar launches the signed
  package directly then the restart. The Profiles page keeps its explicit flow
  with confirmation.
- **A→B comparison in the history**: Shift+click on a second commit (or
  "Compare A→B" in multiple selection) opens the diff in the inspector, to the
  right of the graph, without leaving the History view. A↔B inversion and
  full-screen opening remain available.
- **Date and time in the history**: the Date column displays the local commit
  time in addition to the day (`Oct 28, 2026 14:32`). Default width raised to
  128 px and floor to 112 px so the timestamp fits on one line; still
  resizable and resettable.

### Changed

- **Graph at GitKraken level**: constant 22 px spacing and a column widened
  with the history (up to 420 px) instead of squeezing eighteen lanes into
  150 px. Parent edges leave the dot horizontally and join their lane through
  a 7 px rounded elbow, instead of an S curve crossing the whole row. Each lane
  carries its endpoints (`rails`): it opens on the commit that creates it and
  stops on the one it reaches. 11 px commit dots, saturated eight-lane palette
  (contrast ≥ 4.9:1 on the dark background as well as the light one) and
  drawing bounded to the graph column.
- **Commit tooltip**: hovering no longer opens a popup when the subject fits in
  the column; it only appears if the subject is truncated at render time, after
  each resize.

### Fixed

- **Merge reduced to a fast-forward**: "Merge" advanced the target without
  creating a merge commit as soon as a fast-forward was possible, so the graph
  did not show that the branch had joined the other. "Merge" now passes
  `--no-ff` and produces a real merge commit; the "Fast-forward" entry stays
  available for an explicit fast-forward. The confirmation preview announces
  which of the two will happen.
- **Double-click on a desynchronized remote branch**: if a local branch already
  tracks that reference, its tip is placed back on the remote commit before
  checkout, then the branch is activated — including when it is already the
  current branch. The operation remains undoable (previous tip and active
  branch restored). A checkout that would overwrite local changes is refused
  by Git.
- **Update progress**: the plugin reports the size of each received fragment,
  not the total; fragments are now accumulated to display an exact percentage.

## [0.5.1] — 2026-10-28

### Added

- **Compare two commits with Shift+click**: after selecting a commit,
  Shift+click on a second one directly opens the A → B diff in the Comparison
  view, without going through "Multiple selection". The first selected commit
  (or the last checked) serves as the base; the pair stays selected in the
  graph.

### Changed

- **History graph redrawn**: branch colors stay confined to the graph column.
  The tinted bands that colored the whole row disappear; selection is marked by
  a slight surface relief and the accent marker on the left of the row. Lanes
  are drawn with a single continuous stroke, without stacked transparency:
  forks no longer form darker patches where a curve covered a lane. Parent
  curves are smoothed, commit dots are drawn after all edges (no lane covers
  them any more) and the light grey halo around each dot is replaced by a ring
  in the background color, which cleanly interrupts the lane.

### Fixed

- **Current branch label (HEAD) unreadable in the graph**: the text and the
  icon were painted in the accent yellow on an accent yellow background
  (contrast ≈ 1.2:1). They now use `--accent-contrast`, like all accent-filled
  controls in the application (contrast ≈ 10:1).

### Distribution

- **Signed and notarized macOS build**: `Developer ID Application` signature
  with hardened runtime, Apple notarization and stapling of the app and the
  DMG. Gatekeeper no longer requires a workaround on first launch.
- CI notarization uses an App Store Connect API key
  (`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8`) instead of an
  app-specific password.
- The signing identity changes compared with previous versions: macOS may ask
  again for keychain and chosen folder access on first launch.

### Internal

- The headless visual proof (`scripts/ui-smoke.mjs`) renders a two-lane history
  with a merge every six rows: forks, curves and dots are covered by the
  captures, no longer a single straight row.

## [0.5.0] — 2026-10-28

### Added

- **Resizable interface**: drag the separators to adjust the navigation
  (180–420 px), the References column, the graph width, the Author and Date
  columns, as well as the commit detail or preparation panel (300–760 px).
  Columns reset by double-clicking a separator or via "Reset columns"; all
  widths are remembered and re-clamped to the window size. ←/→ arrow keys on a
  separator.
- **Comparison between two commits in the history**: select a commit then
  Shift+click on a second one: the diff opens immediately in the Comparison
  view. With "Multiple selection" enabled, check two commits then click
  "Compare A → B". The diff direction follows the selection order (first
  commit → second commit), without mutating the repository.
- **Date column in the history**: the commit date (committer, not the author)
  is always displayed to the right of the author. The former "Date" display
  option disappears.
- **GitLab connection inherited from Git**: at startup, HTTPS credentials
  already configured for Git are detected read-only
  (`url.<base>.insteadOf` and `store` helper files, including
  `~/.git-credentials`). An existing `glpat-` is therefore enough to list
  projects and clone without re-entering a token; the secret stays in memory,
  is neither copied into the keychain nor logged. A GitHub credential is never
  confused with GitLab, and a configured instance is never switched to another
  host.
- **Native folder picker for cloning**: the destination field offers
  "Browse…" (the OS folder picker) and appends the repository name to the
  chosen folder; manual entry remains possible.

### Changed

- **Merge possible with pending changes**: dragging one branch onto another
  now merges even with uncommitted modifications. Tracked changes are stashed
  automatically (`BeeBranch auto-stash …`), the merge runs, then the stash is
  reapplied immediately. If the merge or the reapplication conflicts, the stash
  is kept and its picker is displayed; undo reapplies the stash instead of
  losing the modifications. Rebase stays refused on a dirty worktree.
- **Graph and branches as close as possible to GitKraken**: each commit is a
  band tinted with its branch color, references become pills colored by type
  (local branch, remote, tag, HEAD), several references are displayed side by
  side with a `+N` for the rest, nodes have a ring that detaches them from the
  lanes (accent halo for HEAD) and the branch column adapts to label length
  without crushing the message.

### Fixed

- **Local changes visible without fetch**: the file watcher now invalidates the
  repository state, not only the working copy, for every file write and every
  index modification. The "Local changes" summary (staged/modified/new) and the
  status bar therefore refresh as soon as a file is modified or an external
  `git add` is run, without manual refresh.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D
  warnings`, `cargo test --workspace`: 367 tests green.
- `npm run build`, `npm run lint`, `npm run ui:smoke`: resizable and remembered
  columns, Date column, multiple selection and A → B comparison, summary
  refresh after a `repo://changed` of type worktree, graph and diff captures.
- `npm run audit:telemetry`: no telemetry reference.
- `./target/debug/beebranch --version` answers `BeeBranch 0.5.0`.

## [0.4.4] — 2026-10-28

### Verified

- Second control release, with no functional change: confirms on a real machine
  the update icon in the header (it did not appear in 0.4.3, which was already
  the latest published version), the automatic restart after installation and
  the persistence of keychain authorization from one version to the next.

## [0.4.3] — 2026-10-28

### Verified

- Control release with no functional change: validates on a real machine the
  update icon in the header, the automatic restart after installation, the
  persistence of keychain authorization beyond an update, and the signed
  rollback to 0.4.2.

## [0.4.2] — 2026-10-28

### Added

- **Update in the header**: a download icon appears in the top bar as soon as a
  version is published (accent dot, accessible label). The click opens
  Settings → Updates. Silent check at startup, on focus return and every six
  hours.
- **Automatic restart after installation**: the application relaunches itself
  on the new version; the button shows "Restarting…" during the switch. Same
  for rollback.

### Changed

- **macOS signing**: bundle signed with the team's Apple Distribution identity,
  hence stable from one build to the next. Keychain authorizations are
  remembered: no more keychain password request on each launch. The package
  remains unnotarized.

## [0.4.1] — 2026-10-28

### Changed

- **Graph references**: a local branch and its remote mirror placed on the same
  commit (`main`, `origin/main`) count as a single reference — no more `+1` or
  hover menu, the name and type remaining in the tooltip. Badge and menu
  distinguish local, remote and tag by an icon (fork, cloud, label). A branch
  ahead or behind stays displayed on both commits concerned, each with its
  badge.

## [Unreleased] — action bar, branches in the graph, commit detail

### Changed

- **History / commit input**: canvas kept in the viewport by sticky
  positioning, without deferred translation after scrolling. Avoids shifted
  transient images during repaints of the commit panel. Regression checked
  before the next redraw and during input.

- **Settings / Profiles**: saved profiles presented separately, identity and
  preferences grouped in a two-column form, aligned controls and actions at the
  bottom of the form. Editing with direct access to the form, cancellation and
  field preservation on failure. Captures after scrolling and
  creation/editing checks at three widths.

- **Navigation and secondary screens**: History placed first in the navigation
  and the palette. Contextual headers, panels, forms, selections and tabs
  harmonized with History. Persistent labels for Stash, Synchronization, Tools
  and workspace creation; stash actions in French, guided empty states and
  adaptation to narrow windows.
- **UI verification**: captures of the 17 secondary screens at 1440, 1024 and
  390 px, horizontal overflow and active navigation checks.

- **Repository action bar**: 46 px, icon + label actions on a single row, compact
  repository/branch selectors. Labels switch to icons below 1060 px; no
  horizontal scrollbar at 960 px.
- **GitLab connection**: the page stacks the connection and the projects (two
  columns) then the merge requests full width. Cards are no longer crushed at
  34 px and the MR creation form breathes.
- **Commit detail**: sha / references / subject / metadata header, message body
  without repeating the subject, files with status badge, directory truncated
  before the name, aligned additions/deletions and commit total.
- **Branch drag and drop**: dropping a reference onto another local branch
  opens a menu (fast-forward when possible, merge, rebase, compare). A preview
  (commits ahead/behind, fast-forward, branch checkout, modified worktree)
  precedes any mutation; Escape or a repository outside the target cancels.
  Halo on the target and drag label during the operation.
- **Comparison / code**: commit header (sha, subject, author, date), file bar
  (status, path, +/−, hunk count), file list that no longer overflows, syntax
  highlighting (Dart included), old and new line numbers in unified mode,
  separate "Old / New" columns in side by side, changed words highlighted,
  sticky hunk headers, horizontal scrolling instead of an ellipsis, mode labels
  in French and a clean footer.

### Removed

- **"Branches" view**: removed from the navigation, the shortcut and the
  palette. Creation happens in the tree (`+` button of the Branches / tags
  column, context menu of a commit, ⌘B) and branch actions (checkout, rename,
  delete local/remote, merge into current, compare to HEAD) are in the context
  menu of a reference.

### Fixed

- **Update endpoint**: the signed manifest URL is now a single source
  (`BEEBRANCH_UPDATE_ENDPOINT`, injected by CI) used by display, verification,
  download and rollback; previously only the display followed the variable and
  the request came from `tauri.conf.json`. A non-HTTPS endpoint outside
  loopback is refused (`update.invalid_endpoint`). Manifests are hosted on
  GitHub Releases.
- **Fetch without flicker**: a repository refresh keeps the commit page and the
  inspector on screen during reloading (stale-while-revalidate) instead of
  emptying the graph and displaying "Loading commit…". Switching repository,
  filter or branch still empties the previous page.
- Unified diff context rows display their content again (they were empty) and
  carry both line numbers.
- No more fleeting scrollbars when clicking a tab: the press return no longer
  uses `transform`, focus is a `box-shadow` ring and banners only scroll on one
  axis.

## [0.4.0] — 2026-10-27

### Added — P3

- **Explicit undo / redo**: complete Git matrix (commit, amend, checkout,
  branches, tags, remotes, stash create, worktrees, merge/rebase/cherry-pick/
  revert finished or in progress via typed abort, soft/mixed reset).
  Fingerprints of HEAD/index/status/refs/affected files, preconditions, no
  application backups, bounded redo, SQLite journal of the steps, recovery
  panel with command and SHA, interrupted restoration not retried at startup.
  Irreversible actions (discard, reset --hard, stash drop/apply/pop, fetch,
  push, submodule update) are never offered.
- **Drag & drop**: branch onto branch (merge/rebase) with preview (commits,
  fast-forward, worktree, concurrent extraction), mandatory confirmation,
  cancellation without mutation, visible conflicts; reordering of the rebase
  plan commits by drag and drop.
- **Design system**: spacing/typography/depth/motion tokens, compact or
  comfortable density, light/dark/system themes, dialog and button primitives,
  short animations disabled by `prefers-reduced-motion`.
- **Large repositories**: `git log` streamed by the graph, `index:sha` cursor;
  deep pages no longer walk the prefix. `linear-1m` PERF-03: 38.6 s → 18 ms
  for 10 pages (local measurement).
- **Workspaces**: local groups bounded to 20 repositories, multi-repository
  fetch/pull (4 workers), per-repository result, isolated failure, sessions
  closed after the action, explicit pull confirmation.
- **Accessibility**: skip link, visible focus, focus trap/restore in all
  dialogs, roles and labels, error announcements, verified contrasts (text
  ≥ 7:1, muted ≥ 4.5:1, lanes ≥ 3:1) in both themes, automated audit of the
  main views.
- **Distribution**: Windows/macOS/Linux packaging, macOS signing/notarization,
  Windows signing, signed update artifacts, `latest.json` manifest, signed
  rollback via `rollback.json`, release notes, anti-telemetry audit. A missing
  or invalid signature is refused.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`.
- `npm run build`, `npm run lint`, `npm run ui:smoke`: 113 UX checks including
  undo, drag & drop, preview without mutation, workspaces, density, contrasts,
  a11y audit, signed updates.
- `node scripts/audit-no-telemetry.mjs`: no telemetry reference.
- PERF-03 benchmark before/after on `linear-100k` and `linear-1m`.

### Known limitations

- Rollback and installation on a clean machine are exercised by the release CI
  matrix; the development environment cannot sign or install a production
  bundle.
- The log stream keeps one `git log` process per active session; it is
  cancelled when the session closes.

# Changelog

## [0.3.0] — 2026-10-27

### Added — P2

- **Interactive rebase**: plan generated by the application (pick/reword/
  squash/fixup/edit/drop), reordering, custom messages via
  `GIT_SEQUENCE_EDITOR` + `commit --amend -F`, visible conflicts,
  continue/skip/abort, strict validation of the plan against
  `rev-list upstream..HEAD`.
- **3-panel conflicts**: base/ours/theirs + editable result, acceptance of one
  version, combination, raw editing, marker detection, explicit refusal of
  binaries and files > 8 MiB, atomic write preserving CRLF/LF, marking resolved
  in the index.
- **Cherry-pick / revert**: ordered selection, range, conflicts,
  continue/skip/abort, refusal of a concurrent operation or dirty worktree.
- **Worktrees**: list with status per worktree, creation, opening in a tab,
  lock/unlock, prune, confirmed deletion (path entry if dirty).
- **File history and blame**: rename tracking, limits (500 commits /
  2,000 lines), navigation to the commit.
- **Deep search**: message, author, SHA, path, bounded and cancellable content
  (`git grep` 20 s), date/author/path filters, displayed scope.
- **Command palette and shortcuts**: fuzzy search, unavailable actions
  explained, configurable shortcuts without silent duplicates, help.
- **Advanced GitLab**: inline discussions anchored on `diff_refs` (creation,
  reply, resolution), approvals with feature detection, merge by SHA
  (405/406/409 explained), bounded jobs and logs.
- **Submodules**: statuses, add, bounded recursive init/update, sync, explicit
  pointer.
- **Tags and remotes**: annotated tags (message/tagger), explicit deletion and
  push, remote management, refusal of URLs containing a password, prune.
- **Profiles**: Git identity, preferences, GitLab instance per profile, tokens
  isolated in the keychain, application of the identity to the repository.
- **Patches**: creation from worktree/index/commit/range, visible provenance,
  verified application without alteration in case of conflict, binaries
  refused, explicit export.
- **Secrets**: development builds store the GitLab token in a 0600 file
  (`secrets-dev.json`) instead of the macOS keychain, whose ACL is invalidated
  on every unsigned recompilation ("Always allow" asked again on every launch).
  A one-shot migration copies the existing token then no longer reads the
  keychain. Release builds keep the keychain.
- **Cloning**: home screen without marketing copy, choice of a local repository
  or clone of a GitLab project accessible to the user (search, SSH/HTTPS URL
  filled automatically), optional branch/depth/submodules, validated absolute
  destination, no overwriting of an existing folder.
  HTTPS uses the GitLab token via a temporary `GIT_ASKPASS` helper (0600),
  never in the URL/argv; SSH errors (known_hosts, publickey) and HTTPS are
  explained separately.
- **Design**: complete redesign of the shell and screens after the reference
  mockup (palette, density, panels, command palette, themes).
  **Bundled Geist / Geist Mono typography**, 13 px base, secondary text
  contrast raised to ≥ 7:1 in both themes (verified by the smoke test).

### Verified

- `cargo test --workspace`: 313 tests green (including 18 P2 Git scenarios and
  10 advanced GitLab contracts).
- `npm run build`, `npm run lint`, `npm run ui:smoke`: graph, diff, staging,
  P1 navigation and 9 P2 screens (conflicts, rebase, worktrees, tags, remotes,
  submodules, patches, blame, profiles) with conflict resolution exercised,
  Geist font loaded and side contrast ≥ 7:1 in dark/light.

### Known limitations

- Rebase drag & drop stays in P3; reordering is done with the arrow keys.
- The 3-way merge of a patch may still fail after `--check` on extreme drift;
  the error is explicit and the patch is not replayed.
- P2-T01 to T14 are covered in behaviour and tests; human dogfooding remains to
  be scheduled.

## [0.2.0] — 2026-10-27

### Added — P1

- **Index**: staging/unstaging per file, hunk and line via a patch engine
  (`git diff` → reduced patch → `git apply --check` → `git apply`), SHA-256
  fingerprints, confirmed irreversible discard, explicit `.gitignore`. CRLF,
  missing final newline, executable mode, Unicode and renames covered.
- **Commit**: message on stdin, amend with or without keeping the message, Git
  hooks executed and output displayed, identity preflight, signing delegated
  to Git (`commit.gpgsign`, `user.signingkey`, `gpg.format`), no `--no-verify`.
- **Branches**: creation, checkout, rename, local/remote deletion, upstream,
  ahead/behind comparison, preflight merged/current/worktree.
- **Synchronization**: streamed fetch/pull/push, pull depth (`pull.rebase`),
  explicit `--force-with-lease` with expected SHA, cancellation, remote
  revalidation after a cancelled push, auth/SSH/non-fast-forward errors.
- **History**: merge/rebase, conflicts, `continue`/`skip`/`abort`, marking
  resolved, recovery after restart, refusal of a second operation.
- **Stash**: creation (explicit untracked), list, apply/pop, conflicting pop
  leaving the stash intact, confirmed drop with recoverable SHA.
- **Multi-repository**: tabs, isolated sessions, closing with confirmation if
  an operation/conflict is running, restoration of the tabs and of the active
  tab.
- **Search**: message/author/SHA, explicit depth, pagination, cancellation, no
  implicit full read.
- **Graph**: branch/all refs (stash) filters, context menu
  checkout/branch/comparison/copy SHA/MR, MR/CI badges, refresh.
- **GitLab**: MR list (scopes), detail, creation with verification of the
  pushed branch, browser opening, pipelines and CI badge, 30 s polling active
  only when the window is visible, repository ↔ project matching.
- **Destructive safety**: centralized policy (`Confirmation`, name entry),
  SQLite journal of actions, no application backups.
- **External tools**: editor/terminal/diff/merge detection, argv configuration
  without a shell, opening at the right worktree, diff/merge with placeholders.
- **Benchmarks**: PERF-07 (partial staging) and PERF-10 (fetch + refresh)
  measurable and integrated into the reduced set.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace` (dedicated P1 tests included).
- `npm run lint`, `npm run build`, `npm run ui:smoke` (graph, diff, line
  staging, P1 navigation).
- PERF-07 and PERF-10 scenarios measured (`target/bench-perf07.json`,
  `target/bench-perf10.json`).
- Full automated workflow: branch → partial staging → commit → stash → push →
  conflicting merge → resolution → continue → fetch.

### Known limitations

- P1-T14 (dogfooding by three developers) is not executed in this environment:
  the report and the protocol are in `docs/reviews/p1-dogfooding.md`.
- The `--all-reduced --assert` baseline keeps PERF-05/06 measured on a calmer
  machine; the new P1 scenarios comply with their absolute budgets.


## [0.1.0] — 2026-10-27

### Added — P0

- Rust workspace (`core`, `git`, `gitlab`, `store`, `app`, `bench`) and a
  Tauri 2 / React 19.3 shell with a restrictive CSP.
- Single Git CLI engine: argv allowlist, controlled environment, bounded
  capture, streaming, cancellation, timeouts, centralized redaction, capability
  detection (Git ≥ 2.34).
- Worktree-aware sessions: discovery (worktree, common dir, bare, submodule),
  intermediate state (merge, rebase, cherry-pick, revert, sequence, bisect,
  conflicts, locks), watcher with debounce and targeted invalidation,
  serialized mutation queue, generations.
- Read model: refs, `--porcelain=v2 -z` status, paginated log, commit detail,
  unified diff with limits, binary files, CRLF, Unicode, missing final newline.
- Frontend prototypes: virtualized canvas graph with Rust lanes and frame
  timing, hunk/inline/split diff with windowing and limited highlighting.
- Self-hosted GitLab REST v4: URL normalization, PAT in the keychain (native
  `apple-native`/`windows-native`/`sync-secret-service` features), `GET /user`
  validation, internal CA, paginated projects, ETag cache, error mapping
  401/403/404/409/422/429/5xx. Validated live on GitLab 19.2.9.
- Errors and recovery: `AppError` taxonomy, mapping of known Git errors,
  SQLite journal, detection of interrupted operations, recovery panel, redacted
  diagnostics export.
- Benchmark harness: deterministic corpus (10k→1M commits, branches, merges,
  files, diff, CRLF, worktrees), PERF-01..12 scenarios (07 and 10 declared P1),
  versioned JSON reports, baseline and CI thresholds, nightly job.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`, `npm run lint`, `npm run build`.
- Reduced benchmark set under the thresholds of the versioned baseline.
## [0.3.0] — 2026-10-27

### Added — P2

- **Interactive rebase**: plan generated by the application (pick/reword/
  squash/fixup/edit/drop), reordering, custom messages via
  `GIT_SEQUENCE_EDITOR` + `commit --amend -F`, visible conflicts,
  continue/skip/abort, strict validation of the plan against
  `rev-list upstream..HEAD`.
- **3-panel conflicts**: base/ours/theirs + editable result, acceptance of one
  version, combination, raw editing, marker detection, explicit refusal of
  binaries and files > 8 MiB, atomic write preserving CRLF/LF, marking resolved
  in the index.
- **Cherry-pick / revert**: ordered selection, range, conflicts,
  continue/skip/abort, refusal of a concurrent operation or dirty worktree.
- **Worktrees**: list with status per worktree, creation, opening in a tab,
  lock/unlock, prune, confirmed deletion (path entry if dirty).
- **File history and blame**: rename tracking, limits (500 commits /
  2,000 lines), navigation to the commit.
- **Deep search**: message, author, SHA, path, bounded and cancellable content
  (`git grep` 20 s), date/author/path filters, displayed scope.
- **Command palette and shortcuts**: fuzzy search, unavailable actions
  explained, configurable shortcuts without silent duplicates, help.
- **Advanced GitLab**: inline discussions anchored on `diff_refs` (creation,
  reply, resolution), approvals with feature detection, merge by SHA
  (405/406/409 explained), bounded jobs and logs.
- **Submodules**: statuses, add, bounded recursive init/update, sync, explicit
  pointer.
- **Tags and remotes**: annotated tags (message/tagger), explicit deletion and
  push, remote management, refusal of URLs containing a password, prune.
- **Profiles**: Git identity, preferences, GitLab instance per profile, tokens
  isolated in the keychain, application of the identity to the repository.
- **Patches**: creation from worktree/index/commit/range, visible provenance,
  verified application without alteration in case of conflict, binaries
  refused, explicit export.
- **Secrets**: development builds store the GitLab token in a 0600 file
  (`secrets-dev.json`) instead of the macOS keychain, whose ACL is invalidated
  on every unsigned recompilation ("Always allow" asked again on every launch).
  A one-shot migration copies the existing token then no longer reads the
  keychain. Release builds keep the keychain.
- **Cloning**: home screen without marketing copy, choice of a local repository
  or clone of a GitLab project accessible to the user (search, SSH/HTTPS URL
  filled automatically), optional branch/depth/submodules, validated absolute
  destination, no overwriting of an existing folder.
  HTTPS uses the GitLab token via a temporary `GIT_ASKPASS` helper (0600),
  never in the URL/argv; SSH errors (known_hosts, publickey) and HTTPS are
  explained separately.
- **Design**: complete redesign of the shell and screens after the reference
  mockup (palette, density, panels, command palette, themes).
  **Bundled Geist / Geist Mono typography**, 13 px base, secondary text
  contrast raised to ≥ 7:1 in both themes (verified by the smoke test).

### Verified

- `cargo test --workspace`: 313 tests green (including 18 P2 Git scenarios and
  10 advanced GitLab contracts).
- `npm run build`, `npm run lint`, `npm run ui:smoke`: graph, diff, staging,
  P1 navigation and 9 P2 screens (conflicts, rebase, worktrees, tags, remotes,
  submodules, patches, blame, profiles) with conflict resolution exercised,
  Geist font loaded and side contrast ≥ 7:1 in dark/light.

### Known limitations

- Rebase drag & drop stays in P3; reordering is done with the arrow keys.
- The 3-way merge of a patch may still fail after `--check` on extreme drift;
  the error is explicit and the patch is not replayed.
- P2-T01 to T14 are covered in behaviour and tests; human dogfooding remains to
  be scheduled.

## [0.2.0] — 2026-10-27

### Added — P1

- **Index**: staging/unstaging per file, hunk and line via a patch engine
  (`git diff` → reduced patch → `git apply --check` → `git apply`), SHA-256
  fingerprints, confirmed irreversible discard, explicit `.gitignore`. CRLF,
  missing final newline, executable mode, Unicode and renames covered.
- **Commit**: message on stdin, amend with or without keeping the message, Git
  hooks executed and output displayed, identity preflight, signing delegated
  to Git (`commit.gpgsign`, `user.signingkey`, `gpg.format`), no `--no-verify`.
- **Branches**: creation, checkout, rename, local/remote deletion, upstream,
  ahead/behind comparison, preflight merged/current/worktree.
- **Synchronization**: streamed fetch/pull/push, pull depth (`pull.rebase`),
  explicit `--force-with-lease` with expected SHA, cancellation, remote
  revalidation after a cancelled push, auth/SSH/non-fast-forward errors.
- **History**: merge/rebase, conflicts, `continue`/`skip`/`abort`, marking
  resolved, recovery after restart, refusal of a second operation.
- **Stash**: creation (explicit untracked), list, apply/pop, conflicting pop
  leaving the stash intact, confirmed drop with recoverable SHA.
- **Multi-repository**: tabs, isolated sessions, closing with confirmation if
  an operation/conflict is running, restoration of the tabs and of the active
  tab.
- **Search**: message/author/SHA, explicit depth, pagination, cancellation, no
  implicit full read.
- **Graph**: branch/all refs (stash) filters, context menu
  checkout/branch/comparison/copy SHA/MR, MR/CI badges, refresh.
- **GitLab**: MR list (scopes), detail, creation with verification of the
  pushed branch, browser opening, pipelines and CI badge, 30 s polling active
  only when the window is visible, repository ↔ project matching.
- **Destructive safety**: centralized policy (`Confirmation`, name entry),
  SQLite journal of actions, no application backups.
- **External tools**: editor/terminal/diff/merge detection, argv configuration
  without a shell, opening at the right worktree, diff/merge with placeholders.
- **Benchmarks**: PERF-07 (partial staging) and PERF-10 (fetch + refresh)
  measurable and integrated into the reduced set.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace` (dedicated P1 tests included).
- `npm run lint`, `npm run build`, `npm run ui:smoke` (graph, diff, line
  staging, P1 navigation).
- PERF-07 and PERF-10 scenarios measured (`target/bench-perf07.json`,
  `target/bench-perf10.json`).
- Full automated workflow: branch → partial staging → commit → stash → push →
  conflicting merge → resolution → continue → fetch.

### Known limitations

- P1-T14 (dogfooding by three developers) is not executed in this environment:
  the report and the protocol are in `docs/reviews/p1-dogfooding.md`.
- The `--all-reduced --assert` baseline keeps PERF-05/06 measured on a calmer
  machine; the new P1 scenarios comply with their absolute budgets.


## [0.1.0] — 2026-10-27

### Added — P0

- Rust workspace (`core`, `git`, `gitlab`, `store`, `app`, `bench`) and a
  Tauri 2 / React 19.3 shell with a restrictive CSP.
- Single Git CLI engine: argv allowlist, controlled environment, bounded
  capture, streaming, cancellation, timeouts, centralized redaction, capability
  detection (Git ≥ 2.34).
- Worktree-aware sessions: discovery (worktree, common dir, bare, submodule),
  intermediate state (merge, rebase, cherry-pick, revert, sequence, bisect,
  conflicts, locks), watcher with debounce and targeted invalidation,
  serialized mutation queue, generations.
- Read model: refs, `--porcelain=v2 -z` status, paginated log, commit detail,
  unified diff with limits, binary files, CRLF, Unicode, missing final newline.
- Frontend prototypes: virtualized canvas graph with Rust lanes and frame
  timing, hunk/inline/split diff with windowing and limited highlighting.
- Self-hosted GitLab REST v4: URL normalization, PAT in the keychain (native
  `apple-native`/`windows-native`/`sync-secret-service` features), `GET /user`
  validation, internal CA, paginated projects, ETag cache, error mapping
  401/403/404/409/422/429/5xx. Validated live on GitLab 19.2.9.
- Errors and recovery: `AppError` taxonomy, mapping of known Git errors,
  SQLite journal, detection of interrupted operations, recovery panel, redacted
  diagnostics export.
- Benchmark harness: deterministic corpus (10k→1M commits, branches, merges,
  files, diff, CRLF, worktrees), PERF-01..12 scenarios (07 and 10 declared P1),
  versioned JSON reports, baseline and CI thresholds, nightly job.

### Verified

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`, `npm run lint`, `npm run build`.
- Reduced benchmark set under the thresholds of the versioned baseline.
