# 10 — Visual direction

## 1. Intent

BeeBranch must feel **immediately familiar** to a developer coming from an established desktop Git client: the same visual landmarks, the same density, the same way of reading history. It must also have **its own identity**: original name, logo, palette, and iconography.

The reference is **ergonomics**, not assets.

## 2. What is adopted from the benchmark experience

- Central history graph, colored lanes, visible refs, readable merges.
- Left reference panel (branches, remotes, tags, stashes, worktrees).
- Right detail panel (commit, files, diff, metadata).
- Repository tabs and quick navigation.
- Discreet status bar: current branch, ahead/behind, synchronization status.
- High density: compact rows, little wasted space.
- Right-click context actions.
- Command palette and keyboard shortcuts.
- Dark theme by default, light theme available.

## 3. Distinct identity

| Element | Direction |
|---|---|
| Name | **BeeBranch** |
| Symbol | Bee / honeycomb / branch, to be designed; never the benchmark vendor's logo |
| Accent | **Amber yellow `#FED100`**, adapted to `#F5BB45` on a dark background in the reference mockup; reserved for primary actions, selection, and focus |
| Base | Background `#101216`, panels `#15181E`, raised surfaces `#1C2028`, borders `#282D36`, text `#E1E5EC`, secondary `#8992A2` (reference mockup) |
| Lane palette | 6 derived functional colors, readable on a black background; the accent yellow is not used as a lane |
| Iconography | Original icon set or library under a compatible license |
| Typography | **Geist** for the UI, **Geist Mono** for diffs and SHAs, bundled through Fontsource (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) |
| Tone | Technical, calm, precise; no marketing in the application |

The base palette uses `#0A0A0A`, `#191919`, `#F6F6F6`, `#EDEDED`, and `#FED100`. The P2 reference mockup (not versioned) sets the implemented values: `#101216`, `#15181E`, `#1C2028`, `#282D36`, `#E1E5EC`, `#8992A2`, accent `#F5BB45`. Status and lane values are derived for the application.

**Legal and ethical guardrails**

- Do not copy the benchmark client's assets, icons, screenshots, fonts, logos, or exact palette.
- Do not use any benchmark vendor's trademark in the name, logo, domain, or product communications.
- Do not reproduce identifiable trade dress; drawing inspiration from common interface conventions (graph, panels, tabs) is acceptable.
- Check the license of every third-party icon or font before integration.

## 4. Main screen structure

```text
┌─────────────────────────────────────────────────────────────┐
│ Top bar: repository, branch, fetch/pull/push, search        │
├──────────────┬──────────────────────────────┬───────────────┤
│ References   │ Graph + commit list          │ Commit detail │
│ branches     │ lanes, refs, authors, dates  │ files         │
│ remotes      │                              │ diff          │
│ tags         │                              │ metadata      │
│ stashes      │                              │               │
│ worktrees    │                              │               │
├──────────────┴──────────────────────────────┴───────────────┤
│ Status bar: Git state, sync, index, operations              │
└─────────────────────────────────────────────────────────────┘
```

- Three resizable columns, remembered per repository.
- The graph remains the dominant area.
- Panels may be hidden, never at the expense of visible Git status.
- Destructive actions or intermediate states occupy a persistent area, not a transient toast.

Below `1120px`, commit details, comparison, and commit preparation
become a **drawer overlaid** on the graph instead of being stacked: the graph
keeps its height, the panel closes through its button or `Échap`. The status
bar remains actionable (branch, counters, operations, GitLab), and its
Operations menu exposes the recent journal without turning feedback into toasts.

## 5. Tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg` | `#0A0A0A` | `#F6F6F6` | main background |
| `--surface` | `#191919` | `#FFFFFF` | panels |
| `--surface-raised` | `#242424` | `#FFFFFF` | dialogs, menus |
| `--border` | `#2E2E2E` | `#E6E6E6` | separators |
| `--text` | `#EDEDED` | `#191919` | main text |
| `--muted` | `#A3A3A3` | `#616161` | metadata |
| `--accent` | `#FED100` | `#FED100` | primary actions, selection |
| `--accent-contrast` | `#191919` | `#191919` | text on accent |
| `--accent-soft` | `#FED10026` | `#FED10033` | selection background |
| `--success` | `#07BC0C` | `#078A0B` | CI success |
| `--warning` | `#F97316` | `#C2410C` | warning |
| `--error` | `#E74D3C` | `#C0392B` | error |
| `--lane-1` | `#4EA8DE` | `#2B7CB3` | blue |
| `--lane-2` | `#9B5DE5` | `#7B3FC4` | purple |
| `--lane-3` | `#00A6A6` | `#007A7A` | teal |
| `--lane-4` | `#E85D9E` | `#C23A78` | pink |
| `--lane-5` | `#F97316` | `#C2410C` | orange |
| `--lane-6` | `#7CB518` | `#557D0F` | green |

- `#FED100` is the application's accent color and must not be used as a lane color.
- Dark values respect the `#0A0A0A` / `#191919` background.
- Light values are darkened variants to preserve contrast.
- On a light background, `#FED100` never carries light text: use `--accent-contrast` (`#191919`).
- Verified contrast ratios: `#EDEDED`/`#191919` = 15.0:1; `#191919`/`#FED100` = 12.0:1; `#A3A3A3`/`#191919` = 7.0:1. Lanes are validated against the 3:1 graphical minimum.

## 6. Density and motion

- Compact mode by default: 28–32 px rows, no decorative padding.
- Comfortable mode available.
- Short animations (120–160 ms), never blocking, disabled with `prefers-reduced-motion`.
- No animation on graph scrolling.
- Transitions aid understanding (panel opening, tab change), not decoration.

## 7. Accessibility

- Contrast compliant with the chosen level (AA proposed).
- Visible focus, full keyboard navigation.
- Lane colors are never the sole information carrier (shape, label, position).
- CI statuses have a label, not just a color.
- Error messages are announced and persistent.

## 8. Implementation

- P0: neutral tokens and panel structure, no polish.
- P1: basic components, consistent states, density.
- P2: shell and screens aligned with the reference mockup — top bar
  with repository tabs, toolbar (branch, ahead/behind, fetch/pull/
  push), grouped navigation, status bar; Conflicts (3 panels),
  Interactive rebase, Worktrees, Tags, Remotes, Submodules, Patches, Blame,
  Advanced search, Merge requests (discussions/approvals/jobs),
  Profiles and settings screens; command palette, configurable shortcuts, and
  dark/light theme.
- P3: complete design system, advanced animations, visual and
  accessibility audit — shipped: spacing/typography/depth tokens, compact/
  comfortable density, `Button` and `Dialog` primitives, animations of
  120–220 ms, contrast audit (text ≥ 7:1, muted ≥ 4.5:1, lanes ≥ 3:1), and
  automated a11y audit.

### P2 implementation (actual tokens)

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#101216` | `#F5F6F8` |
| `--surface` | `#15181E` | `#ECEEF2` |
| `--surface-raised` | `#1C2028` | `#E2E5EB` |
| `--border` | `#282D36` | `#D3D7DF` |
| `--text` | `#E1E5EC` | `#222936` |
| `--muted` | `#8992A2` | `#667184` |
| `--accent` | `#F5BB45` | `#F5BB45` |
| `--success` | `#52C993` | `#136B46` |
| `--warning` | `#F0A45B` | `#94470A` |
| `--error` | `#E66B75` | `#B93B48` |
| `--info` | `#81A9EF` | `#2B6CB0` |

Animations are limited to 120–160 ms and disabled with
`prefers-reduced-motion`. Keyboard shortcuts are configurable in
Profiles and settings; duplicates are rejected.

Every visual change must respect the guardrails in section 3.

### Graph rendering (benchmark reference)

The graph follows the benchmark client's reading conventions without reusing its assets:

- each commit row is a **band tinted** with the branch color
  (6% in dark, 5% in light), with 3 px top/bottom insets and
  4 px corners; selection and multi-selection strengthen the tint and add an
  accent bar on the left;
- references are **pills colored by type** — accent for HEAD,
  lane color for a local branch, `--info` for a remote branch,
  `--warning` for a tag — with the corresponding icon (fork, cloud,
  label); all visible references are drawn, the overflow becomes
  `+N` and opens the reference menu;
- nodes are lane-colored disks, outlined with `--surface` to
  stand out from the lines; HEAD receives an accent halo;
- **lane junctions** are rounded on the destination commit's row,
  as in the benchmark client: a branch joining its parent keeps its column
  until the parent's row, then curves **above** the midline; only a
  secondary parent opens a column **below** the commit, with a curve below
  the midline. A commit whose parent is already taken by another column
  therefore no longer abandons its column prematurely;
- a **stash** is a separate node, inserted at its date in history (an old stash
  does not rise above recent commits): a dotted rounded-square badge
  with a chest, in the lane color, and labeled with the
  entered message (without the `On <branch>:` prefix). Its `index` snapshot stays
  out of the graph, and files from the `untracked` snapshot appear in
  the stash details: one stash = one row;
- **pin left** anchors a branch in the first column starting at its
  tip: columns 0 and n swap places at the tip's row, which
  draws the switch, without moving the nodes above. **Solo** reduces the
  graph to one branch through the filter, without modifying the repository;
- lane spacing is fixed (22 px), and the branch column follows the
  longest label (96 to 220 px), reserving 520 px for the message and 90 px for
  the author so the subject is never truncated.

Pill text/background contrast ratios remain ≥ 4.5:1 (measured ≥ 7:1 in dark).

### P3 implementation (additional tokens)

| Family | Tokens |
|---|---|
| Spacing | `--space-1` … `--space-12` (4 px base) |
| Typography | `--text-xs` … `--text-2xl`, `--line-tight`, `--line-normal` |
| Density | `--row-height`, `--control-height`; `data-density="compact"` (13 px / 26 px) or `"comfortable"` (15 px / 34 px) |
| Depth | `--z-base` … `--z-toast`, `--shadow-sm`, `--shadow-md`, `--focus-ring` |
| Motion | `--duration-fast` 120 ms, `--duration-normal` 160 ms, `--duration-slow` 220 ms |

Light lane colors are darkened to stay ≥ 3:1 on the light
background; the accent yellow is never a lane. View, dialog,
and overlay animations are disabled entirely with
`prefers-reduced-motion`.

### Custom background

Preferences → General accepts an image or animated GIF (png, jpg, gif, webp,
avif, bmp · 32 MB). The path is the only persisted data
(`ui.background`); the backend rereads the file at startup and returns it as a
`data:` URL, avoiding opening filesystem access to the webview and
letting the webview animate the GIF. The `--app-bg-image`,
`--app-bg-size`, `--app-bg-repeat`, `--app-bg-dim`, and `--app-bg-blur` variables control
the fixed layer rendered beneath the shell, at `z-index: -1`.

When an image is active, `data-background="image"` on `:root` replaces
`--bg`, `--surface`, `--surface-raised`, `--border`, and `--selection-bg` with
translucent variants (56–92% opacity), adapted for the dark theme, the
explicit light theme, and the system preference. Dimming (0–90%, 45% by
default) applies a `--bg-scrim` veil over the image: only the veil degrades
contrast, so text remains readable by default even on a light photo.
The layer is hidden as soon as reading fails (file moved), and the error
is displayed in settings; the shell becomes opaque again rather than leaving
an empty background.

The splash screen follows the same pattern (`ui.splash`, same formats, 32 MB) and
the same controls. The splash window does not use the application's
stylesheet: the page remains in `data-splash="pending"` (nothing but the
window color) until `src/splash.ts` has read the preference through
IPC and obtained the image as a `data:` URL; it then switches to `data-splash="image"`
and sets `--splash-image`, `--splash-size`, `--splash-repeat`, `--splash-dim`, and
`--splash-blur`. The hexagonal logo is hidden, the brand and progress
bar remain above the veil. Without a preference, or if the file has
disappeared, the mode reverts to `data-splash="logo"`: the splash screen can
never block or delay launch beyond two seconds.

### Secondary screens

Non-graph screens (Merge requests, Pull requests, Search, Interactive
rebase, File history, Worktrees, Tags, Remotes, Submodules,
Patches, Synchronization) share a single template rather than isolated
cards:

- **full-width surface**: a top toolbar (filters, view
  actions), a scrolling body, and a right inspector for forms
  or progress; titles appear only once in the shell's view
  bar;
- **dense rows**: minimum height of 44 px, one rule per row, `--selection-bg`
  selection with a left accent bar, right-aligned actions;
- **microtypography**: section labels in 10.5 px uppercase, metadata
  in 11 px, SHAs and paths in `Geist Mono`; statuses always pair a
  label with their pill, never color alone;
- **states**: persistent errors in a side banner, confirmations for
  destructive operations, empty states that explain the next action.

The corresponding CSS core lives in `src/components/p2.module.css`
(`screen`, `toolbar`, `entry`, `chip`, `alert`, `paneSection`): a new secondary
screen reuses these primitives instead of inventing new ones.
