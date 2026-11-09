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

/** Lucide `cloud` — remote-tracking badge. */
export const CLOUD: LucideCanvasNode[] = [
  ['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }],
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
