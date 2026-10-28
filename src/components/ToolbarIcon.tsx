const gear = Array.from({ length:32 }, (_, index) => { const angle = index * Math.PI / 16; const radius = index % 4 === 1 || index % 4 === 2 ? 10 : 8; return `${index ? 'L' : 'M'}${12 + Math.cos(angle) * radius},${12 + Math.sin(angle) * radius}` }).join(' ') + 'Z'

const paths = {
  clone: ['M8 8h13v13H8zM16 8V3H3v13h5'],
  folder: ['M3 6h6l2 2h10v12H3zM3 6V4h6l2 2'],
  plus: ['M12 5v14M5 12h14'],
  chevron: ['m7 10 5 5 5-5'],
  search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5'],
  settings: [gear, 'M15.5 12a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0'],
  fetch: ['M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5'],
  pull: ['M12 3v14m-5-5 5 5 5-5M5 21h14'],
  push: ['M12 17V3m-5 5 5-5 5 5M5 21h14'],
  branch: ['M6 3v18M6 15a12 12 0 0 0 12-12M3 5h6M15 5h6M3 19h6'],
  stash: ['M3 13h18v8H3zM12 2v12m-4-4 4 4 4-4M3 13l3-4h2M21 13l-3-4h-2'],
  pop: ['M3 13h18v8H3zM12 14V2M8 6l4-4 4 4M3 13l3-4h2M21 13l-3-4h-2'],
  terminal: ['m4 5 6 7-6 7M13 19h7'],
  actions: ['M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  redo: ['m15 14 5-5-5-5', 'M20 9H10a6 6 0 0 0 0 12h3'],
}
export function ToolbarIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name].map((d, index) => <path key={index} d={d} />)}</svg>
}
