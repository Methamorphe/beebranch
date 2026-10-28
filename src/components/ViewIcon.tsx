import type { ViewId } from '../data/navigation'

type IconKey = ViewId | 'branch'

const paths: Partial<Record<IconKey, string[]>> = {
  graph: ['M6 3v18M6 8h7a5 5 0 0 1 5 5v8', 'M3 8h6M15 15h6'],
  status: ['M14 3H5v18h14V8z', 'M14 3v5h5M8 12h8M8 16h5'],
  branch: ['M6 3v18M6 15a12 12 0 0 0 12-12', 'M3 5h6M15 5h6M3 19h6'],
  stash: ['M3 8h18v13H3zM2 3h20v5H2zM9 12h6'],
  mrs: ['M6 3v18M18 21v-8a7 7 0 0 0-7-7', 'm14 3-3 3 3 3M3 5h6M15 19h6'],
  search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5'],
  conflicts: ['m12 3 10 18H2zM12 9v5M12 17v.1'],
  rebase: ['M6 3v18M18 3v6a6 6 0 0 1-6 6H6M3 5h6M15 5h6M3 19h6'],
  worktrees: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  tags: ['m3 3 9 .1L22 13 13 22 3 12zM7 7h.01'],
  remotes: ['M4 17a4 4 0 0 1 0-8 8 8 0 0 1 15-2 5 5 0 0 1 0 10', 'M12 21V11m-4 4 4-4 4 4'],
  submodules: ['m12 2 10 5v10l-10 5-10-5V7zM2 7l10 5 10-5M12 12v10'],
  patches: ['M14 3H5v18h14V8zM14 3v5h5M9 14h6M12 11v6'],
  sync: ['M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5'],
  profiles: ['M4 7h16M4 17h16M8 4v6M16 14v6'],
  gitlab: ['M8 9V6a4 4 0 0 1 8 0v3M5 9h14v12H5zM12 13v4'],
  tools: ['m4 5 6 7-6 7M13 19h7'],
  recovery: ['M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2'],
  fileHistory: ['M14 3H5v18h14V8zM14 3v5h5M9 12h6M9 16h6'],
}
export function ViewIcon({ view }: { view: IconKey }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{(paths[view] ?? paths.status)!.map((d, index) => <path key={index} d={d} />)}</svg>
}
