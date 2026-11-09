/**
 * Folder view of branch names: `feature/auth/login` is shown as `feature` >
 * `auth` > `login`. Remote branches carry the remote as first segment
 * (`origin/feature/x`), so the remote becomes the top folder on its own.
 *
 * Pure model: callers pass which folders are open, rows come back flat.
 */

import type { RefEntry } from '../types/git'

type Node = {
  name: string
  path: string
  dirs: Node[]
  leaves: { entry: RefEntry; label: string }[]
  /** Branches below this folder, nested ones included. */
  count: number
  /** The checked-out branch lives below this folder. */
  hasHead: boolean
}

export type BranchTreeRow =
  | { kind: 'dir'; key: string; path: string; name: string; depth: number; count: number; open: boolean }
  | { kind: 'branch'; key: string; entry: RefEntry; label: string; depth: number }

const emptyNode = (name: string, path: string): Node => ({
  name,
  path,
  dirs: [],
  leaves: [],
  count: 0,
  hasHead: false,
})

function buildNodes(entries: RefEntry[]): Node {
  const root = emptyNode('', '')
  for (const entry of entries) {
    const segments = entry.name.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let node = root
    node.count += 1
    node.hasHead ||= entry.isHead
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const path = segments.slice(0, depth + 1).join('/')
      let child = node.dirs.find((dir) => dir.path === path)
      if (!child) {
        child = emptyNode(segments[depth]!, path)
        node.dirs.push(child)
      }
      child.count += 1
      child.hasHead ||= entry.isHead
      node = child
    }
    node.leaves.push({ entry, label: segments[segments.length - 1]! })
  }
  return root
}

/**
 * Flatten branches into visible rows. A folder is open when `toggled` says so;
 * otherwise it follows `defaultOpen`, which callers set while filtering and
 * which always holds for the folder of the checked-out branch.
 */
export function buildBranchRows(
  entries: RefEntry[],
  scope: string,
  toggled: Record<string, boolean>,
  defaultOpen: boolean,
): BranchTreeRow[] {
  const rows: BranchTreeRow[] = []
  const byName = <T extends { name?: string; label?: string }>(a: T, b: T) =>
    (a.name ?? a.label ?? '').localeCompare(b.name ?? b.label ?? '')
  const walk = (node: Node, depth: number) => {
    for (const dir of [...node.dirs].sort(byName)) {
      const key = `${scope}:${dir.path}`
      const open = toggled[key] ?? (defaultOpen || dir.hasHead)
      rows.push({ kind: 'dir', key, path: dir.path, name: dir.name, depth, count: dir.count, open })
      if (open) walk(dir, depth + 1)
    }
    for (const leaf of [...node.leaves].sort(byName)) {
      rows.push({ kind: 'branch', key: leaf.entry.fullName, entry: leaf.entry, label: leaf.label, depth })
    }
  }
  walk(buildNodes(entries), 0)
  return rows
}
