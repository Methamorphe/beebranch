/**
 * Stroke Lucide glyphs on a canvas without rasterizing them. Paths match the
 * Lucide 24×24 viewBox (ISC) so graph badges stay identical to the React icons.
 */

export type LucideCanvasNode =
  | ['path', { d: string; fill?: string }]
  | ['circle', { cx: number; cy: number; r: number; fill?: string }]
  | ['rect', { x: number; y: number; width: number; height: number; rx?: number }]

/** Lucide `archive` — stash medallion. */
export const ARCHIVE: LucideCanvasNode[] = [
  ['rect', { x: 2, y: 3, width: 20, height: 5, rx: 1 }],
  ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }],
  ['path', { d: 'M10 12h4' }],
]

/** Lucide `git-branch` — local / HEAD badge. */
export const GIT_BRANCH: LucideCanvasNode[] = [
  ['path', { d: 'M15 6a9 9 0 0 0-9 9V3' }],
  ['circle', { cx: 18, cy: 6, r: 3 }],
  ['circle', { cx: 6, cy: 18, r: 3 }],
]

/** Lucide `laptop` — local branch on a pill, same as the hover list. */
export const LAPTOP: LucideCanvasNode[] = [
  ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }],
  ['path', { d: 'M2 20h20' }],
]

/** Lucide `cloud` — remote-tracking badge. */
export const CLOUD: LucideCanvasNode[] = [
  ['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }],
]

/** GitLab tanuki — same path as `ForgeLogo`. */
export const GITLAB_MARK: LucideCanvasNode[] = [
  [
    'path',
    {
      d: 'M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.92.92 0 0 0 .33-1.024',
      fill: 'currentColor',
    },
  ],
]

/** GitHub mark — same path as `ForgeLogo`. */
export const GITHUB_MARK: LucideCanvasNode[] = [
  [
    'path',
    {
      d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      fill: 'currentColor',
    },
  ],
]

/** Azure DevOps mark — same path as `ForgeLogo`. */
export const AZURE_MARK: LucideCanvasNode[] = [
  [
    'path',
    {
      d: 'M4 16.5 9.2 4h2.1L7.2 16.5H4zm6.4 0 2.2-5.2 2.2 5.2h-4.4zm4.3 0h3.1L22 4h-2.1l-3.1 8.2L13.7 4h-2.1l3.1 12.5z',
      fill: 'currentColor',
    },
  ],
]

/** Lucide `tag` — tag badge. */
export const TAG: LucideCanvasNode[] = [
  [
    'path',
    {
      d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    },
  ],
  ['circle', { cx: 7.5, cy: 7.5, r: 0.5, fill: 'currentColor' }],
]

/** Lucide `circle-dashed` — selection ring / WIP marker. */
export const CIRCLE_DASHED: LucideCanvasNode[] = [
  ['path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }],
  ['path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }],
  ['path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
  ['path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }],
  ['path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
  ['path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }],
  ['path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
  ['path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
]

const VIEW = 24

/**
 * Stroke a Lucide glyph centered at `(cx, cy)` with the given CSS-pixel size.
 * `lineWidth` is in CSS pixels (not scaled with the glyph).
 */
export function strokeLucideIcon(
  context: CanvasRenderingContext2D,
  nodes: LucideCanvasNode[],
  cx: number,
  cy: number,
  size: number,
  color: string,
  lineWidth = 1.5,
) {
  const scale = size / VIEW
  context.save()
  context.translate(cx - size / 2, cy - size / 2)
  context.scale(scale, scale)
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = lineWidth / scale
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const node of nodes) {
    const [kind, attrs] = node
    context.beginPath()
    if (kind === 'path') {
      const path = new Path2D(attrs.d)
      if (attrs.fill === 'currentColor') {
        context.fill(path)
      } else {
        context.stroke(path)
      }
    } else if (kind === 'circle') {
      context.arc(attrs.cx, attrs.cy, attrs.r, 0, Math.PI * 2)
      if (attrs.fill === 'currentColor') {
        context.fill()
      } else {
        // Filled circles in Lucide (branch tips) read better filled at small size.
        context.fill()
      }
    } else {
      const rx = attrs.rx ?? 0
      if (typeof context.roundRect === 'function') {
        context.roundRect(attrs.x, attrs.y, attrs.width, attrs.height, rx)
      } else {
        context.rect(attrs.x, attrs.y, attrs.width, attrs.height)
      }
      context.stroke()
    }
  }
  context.restore()
}
