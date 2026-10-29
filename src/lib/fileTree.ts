/** Directory tree shared by every file list: the comparison inspector and the
 * status view group paths the same way, so the shape lives here. */

export type FileTreeItem = { path: string }

export type FileTreeNode<T extends FileTreeItem> = {
  name: string
  path: string
  dirs: FileTreeNode<T>[]
  files: T[]
  /** Files below this directory, its own included. */
  count: number
}

export type FileTreeRow<T extends FileTreeItem> =
  | { kind: 'dir'; key: string; name: string; depth: number; count: number; open: boolean }
  | { kind: 'file'; key: string; item: T; depth: number }

export function buildFileTree<T extends FileTreeItem>(items: T[]): FileTreeNode<T> {
  const root: FileTreeNode<T> = { name: '', path: '', dirs: [], files: [], count: 0 }
  for (const item of items) {
    const segments = item.path.split('/')
    let node = root
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const path = segments.slice(0, depth + 1).join('/')
      let child = node.dirs.find((dir) => dir.path === path)
      if (!child) {
        child = { name: segments[depth]!, path, dirs: [], files: [], count: 0 }
        node.dirs.push(child)
      }
      node = child
    }
    node.files.push(item)
  }
  const finalise = (node: FileTreeNode<T>): number => {
    node.dirs.sort((left, right) => left.name.localeCompare(right.name))
    node.files.sort((left, right) => left.path.localeCompare(right.path))
    node.count =
      node.files.length + node.dirs.reduce((sum, child) => sum + finalise(child), 0)
    return node.count
  }
  finalise(root)
  return root
}

/** A directory that only holds another one reads as `a/b/c`, like git clients show it. */
function compactDir<T extends FileTreeItem>(dir: FileTreeNode<T>) {
  let current = dir
  let name = dir.name
  while (current.files.length === 0 && current.dirs.length === 1) {
    current = current.dirs[0]!
    name = `${name}/${current.name}`
  }
  return { name, dir: current }
}

/**
 * Rows in display order. `keyPrefix` separates collapse state when several
 * lists share one tree (the status view stacks staged and unstaged files).
 */
export function flattenFileTree<T extends FileTreeItem>(
  root: FileTreeNode<T>,
  collapsed: Set<string>,
  keyPrefix = '',
): FileTreeRow<T>[] {
  const rows: FileTreeRow<T>[] = []
  const walk = (dir: FileTreeNode<T>, depth: number) => {
    for (const child of dir.dirs) {
      const compact = compactDir(child)
      const key = `${keyPrefix}${compact.dir.path}`
      const open = !collapsed.has(key)
      rows.push({
        kind: 'dir',
        key,
        name: compact.name,
        depth,
        count: compact.dir.count,
        open,
      })
      if (open) {
        walk(compact.dir, depth + 1)
      }
    }
    for (const item of dir.files) {
      rows.push({ kind: 'file', key: item.path, item, depth })
    }
  }
  walk(root, 0)
  return rows
}
