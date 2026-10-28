import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { CommitSummary, GraphRow, RefEntry } from '../types/git'
import {
  COLUMN_CEILINGS,
  COLUMN_FLOORS,
  MIN_MESSAGE_WIDTH,
  clampColumnWidths,
  type GraphColumnWidths,
} from '../lib/layout'
import { Resizer } from './Resizer'
import { GraphRefPopover, type RefAnchor } from './GraphRefPopover'
import {
  foldUpstreamRefs,
  graphCommitRefs,
  graphRefKind,
  graphRefLabel,
  isCheckoutableRef,
  resolveGraphRef,
  type GraphRefKind,
} from '../lib/graphRefs'
import styles from './GraphCanvas.module.css'

export type MrBadge = {
  iid: number
  status: string
  state: string
}

/** Click modifiers that change what a row click means. Shift extends the
 * selection towards the previously picked commit; the platform modifier
 * (`⌘`/`Ctrl`) compares that commit with the clicked one only, skipping
 * everything in between. */
export type SelectModifiers = {
  shift: boolean
  meta: boolean
}

type Props = {
  worktreeRow?: ReactNode
  headerTools?: ReactNode
  columnWidths?: GraphColumnWidths | null
  onColumnWidthsChange?: (widths: GraphColumnWidths | null) => void
  commits: CommitSummary[]
  rows: GraphRow[]
  selected?: string
  mrBadges?: Record<string, MrBadge>
  refEntries?: RefEntry[]
  checkoutDisabled?: boolean
  onCheckoutRef?: (raw: string) => void
  onSelect: (sha: string, modifiers: SelectModifiers) => void
  onContextMenu?: (commit: CommitSummary, x: number, y: number) => void
  onRefContextMenu?: (entry: RefEntry, x: number, y: number) => void
  onRefDrop?: (source: RefEntry, target: RefEntry, x: number, y: number) => void
  branchTarget?: string | null
  branchName?: string
  onBranchName?: (value: string) => void
  onBranchSubmit?: () => void
  onBranchCancel?: () => void
  onBranchRequest?: (sha: string | null) => void
  onLoadMore: () => void
  loading: boolean
  generation: number
  theme?: string
  picked?: string[]
}

const ROW_HEIGHT = 30
const OVERSCAN = 8
/** Reused across rows and frames: Intl formatters are expensive to build. */
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
const TIME_FORMAT = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })

/** Commit date and local time shown in the history date column. */
function commitDateLabel(timestamp: number) {
  const date = new Date(timestamp * 1000)
  return `${DATE_FORMAT.format(date)} ${TIME_FORMAT.format(date)}`
}
/** Constant distance between two lanes: the graph column grows with the lane
 * count instead of squeezing every lane into a fixed width, which used to turn
 * a branched history into an unreadable ladder. */
const LANE_PITCH = 22
/** Commit dot radius, measured from GitKraken: 11 px across on a 28 px row. */
const NODE_RADIUS = 5.5
/** Radius of the corner that turns a parent edge into its lane. */
const ELBOW_RADIUS = 7
const LANE_COLORS = [
  '#4c8dff',
  '#a970ff',
  '#2fd39a',
  '#ff5d6c',
  '#ffa236',
  '#ffd257',
  '#2bc3d9',
  '#f472b6',
]
const LIGHT_LANE_COLORS = [
  '#1f5fd0',
  '#6b3fc0',
  '#0d7a4f',
  '#c02a3a',
  '#9a4a05',
  '#7a6200',
  '#0a6b7a',
  '#a01f6b',
]

/**
 * Column layout. The reference column follows the longest label (between 96
 * and 220 px) but always leaves at least 520 px to the message so a branch
 * name never pushes the commit subject out of the viewport. The date column is
 * always present; the user can resize every fixed column.
 */
function defaultColumns(
  width: number,
  lanes: number,
  desiredRefs = 140,
): GraphColumnWidths {
  // Lanes need 22 px each plus a 9 px gutter on both sides: a two-lane history
  // stays at the 64 px floor, nine lanes take 216 px. The column grows with the
  // history instead of squeezing the lanes together.
  const graph =
    width < 520
      ? 64
      : Math.min(COLUMN_CEILINGS.graph, Math.max(64, lanes * LANE_PITCH + 18))
  // Date and time on one line: 128 px fits the widest month (`28 mars 2026
  // 23:59`, 110 px at 12 px) with room for the padding.
  const date = width >= 560 ? 128 : COLUMN_FLOORS.date
  let refs = width >= 480 ? Math.min(desiredRefs, Math.round(width * 0.34)) : 0
  if (refs > 0) {
    // Keep 520 px for the message and 90 px for the author before widening the
    // reference column; below that the labels fall back to a compact 96 px.
    const budget = width - graph - date - 520 - 90
    refs = Math.max(96, Math.min(refs, budget))
  }
  // Keep at least 520 px for the message; the author column takes the rest.
  const room = width - refs - graph - date - 520
  const author = room >= 130 ? 130 : room >= 110 ? 110 : room >= 90 ? 90 : 0
  return clampColumnWidths(width, { refs, graph, author, date })
}

function hexToRgb(value: string): [number, number, number] | null {
  const hex = value.trim().replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const number = Number.parseInt(full, 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

/** Linear blend used for branch-tinted pills and rows. */
function mix(color: string, target: string, ratio: number) {
  const from = hexToRgb(color)
  const to = hexToRgb(target)
  if (!from || !to) return color
  const channel = (index: number) => Math.round(from[index]! + (to[index]! - from[index]!) * ratio)
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`
}
function fitText(context: CanvasRenderingContext2D, text: string, width: number) {
  if (width <= 0) return ''
  if (context.measureText(text).width <= width) return text
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (context.measureText(text.slice(0, middle) + '…').width <= width) low = middle
    else high = middle - 1
  }
  return text.slice(0, low) + '…'
}

type FrameStats = {
  p50: number
  p95: number
  missed: number
}

/** All refs shown on one row, in draw order. */
type BadgeRef = {
  raw: string
  label: string
  kind: GraphRefKind
}

const BADGE_ICON_WIDTH = 12

/** Drawn on every badge: fork for a local branch, cloud for a remote-tracking
 * ref, tag for a tag. Shapes match the sidebar icon set so the two agree. */
function drawRefIcon(context: CanvasRenderingContext2D, kind: GraphRefKind, x: number, y: number, color: string) {
  if (kind === 'other') return
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = 1.3
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  if (kind === 'local' || kind === 'head') {
    context.moveTo(x + 2.5, y + 4)
    context.lineTo(x + 2.5, y - 4)
    context.moveTo(x + 2.5, y)
    context.bezierCurveTo(x + 7, y, x + 7, y - 1.5, x + 7, y - 4)
    context.stroke()
    context.beginPath()
    context.arc(x + 2.5, y - 4, 1.5, 0, Math.PI * 2)
    context.arc(x + 2.5, y + 4, 1.5, 0, Math.PI * 2)
    context.arc(x + 7, y - 4, 1.5, 0, Math.PI * 2)
    context.fill()
  } else if (kind === 'remote') {
    context.moveTo(x, y + 3.4)
    context.bezierCurveTo(x - 2.6, y + 3.4, x - 2.8, y - 0.4, x + 0.6, y - 0.6)
    context.bezierCurveTo(x + 0.8, y - 4.6, x + 6.6, y - 4.8, x + 7, y - 1.2)
    context.bezierCurveTo(x + 10.4, y - 1.6, x + 11, y + 3.4, x + 8.6, y + 3.4)
    context.closePath()
    context.stroke()
  } else {
    context.moveTo(x + 1, y - 4.5)
    context.lineTo(x + 4.4, y - 4.5)
    context.lineTo(x + 9.2, y)
    context.lineTo(x + 5, y + 4.5)
    context.lineTo(x + 1, y)
    context.closePath()
    context.stroke()
    context.beginPath()
    context.arc(x + 3.6, y - 2.6, 0.9, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

declare global {
  interface Window {
    __beebranchGraphStats?: FrameStats
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
  return sorted[index] ?? 0
}

export function GraphCanvas({
  worktreeRow,
  headerTools,
  columnWidths = null,
  onColumnWidthsChange,
  commits,
  rows,
  selected,
  mrBadges,
  onSelect,
  refEntries = [],
  checkoutDisabled = false,
  onCheckoutRef,
  onContextMenu,
  onRefContextMenu,
  onRefDrop,
  branchTarget = null,
  branchName = '',
  onBranchName,
  onBranchSubmit,
  onBranchCancel,
  onBranchRequest,
  onLoadMore,
  loading,
  generation,
  theme,
  picked = [],
}: Props) {
  const [viewportWidth, setViewportWidth] = useState(1000)
  const maxLanes = useMemo(() => rows.reduce((max, row) => Math.max(max, row.laneCount), 1), [rows])
  // Every visible ref of a commit, in draw order. A remote-tracking mirror of
  // a local branch is folded out: `main` and `origin/main` on the same commit
  // are one branch, not two.
  const decorations = useMemo(() => {
    const map = new Map<string, BadgeRef[]>()
    for (const commit of commits) {
      if (commit.refs.length === 0) continue
      const decorated = graphCommitRefs(commit, refEntries)
      const { visible } = foldUpstreamRefs(decorated)
      const refs = visible.map((decoration) => ({
        raw: decoration.raw,
        label: graphRefLabel(decoration.raw),
        kind: graphRefKind(decoration.raw, decoration.entry),
      }))
      if (refs.length > 0) map.set(commit.sha, refs)
    }
    return map
  }, [commits, refEntries])
  const refsWidth = useMemo(() => {
    let longest = 0
    for (const refs of decorations.values()) {
      for (const ref of refs) longest = Math.max(longest, ref.label.length)
    }
    return Math.min(220, Math.max(140, Math.round(longest * 7.1 + 58)))
  }, [decorations])
  const layout = useMemo(
    () =>
      clampColumnWidths(
        viewportWidth,
        columnWidths ?? defaultColumns(viewportWidth, maxLanes, refsWidth),
      ),
    [viewportWidth, columnWidths, maxLanes, refsWidth],
  )
  const columnBudget = viewportWidth - MIN_MESSAGE_WIDTH
  const maxColumn = (key: keyof GraphColumnWidths) => {
    const fixed =
      layout.refs + layout.graph + layout.author + layout.date - layout[key]
    return Math.max(
      COLUMN_FLOORS[key],
      Math.min(COLUMN_CEILINGS[key], columnBudget - fixed),
    )
  }
  const resizeColumn = (key: keyof GraphColumnWidths, value: number) => {
    onColumnWidthsChange?.(
      clampColumnWidths(viewportWidth, { ...layout, [key]: value }),
    )
  }
  const [refHover, setRefHover] = useState<RefAnchor | null>(null)
  const dragStart = useRef<{ entry: RefEntry; x: number; y: number } | null>(null)
  const dragTargetRect = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const [drag, setDrag] = useState<{ entry: RefEntry; x: number; y: number; target: RefEntry | null } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refRects = useRef<{ commit: CommitSummary; raw: string; x:number; y:number; width:number; height:number; overflow?: boolean }[]>([])
  /** Commits whose subject does not fit the message column, filled by `draw`.
   * Only those rows deserve the hover tooltip: a subject that is fully
   * readable already makes the popup noise. */
  const truncatedSubjects = useRef<Set<string>>(new Set())
  const cancelRefClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null } }
  const closeRefSoon = () => { cancelRefClose(); closeTimer.current = setTimeout(() => { if (!popupRef.current?.contains(document.activeElement)) setRefHover(null) }, 140) }
  const checkoutRef = (raw: string) => {
    if (checkoutDisabled || !isCheckoutableRef(resolveGraphRef(raw, refEntries))) return
    cancelRefClose()
    setRefHover(null)
    onCheckoutRef?.(raw)
  }
  const hoveredRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollTopRef = useRef(0)
  const drawRef = useRef<() => void>(() => {})
  const frameRef = useRef<number | null>(null)
  const frameTimes = useRef<number[]>([])
  const lastFrame = useRef(0)
  const statsRef = useRef<FrameStats>({ p50: 16, p95: 16, missed: 0 })

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) {
      return
    }
    frameRef.current = window.requestAnimationFrame((time) => {
      frameRef.current = null
      if (lastFrame.current > 0) {
        const delta = time - lastFrame.current
        frameTimes.current.push(delta)
        if (frameTimes.current.length > 240) {
          frameTimes.current.shift()
        }
      }
      lastFrame.current = time
      drawRef.current()
    })
  }, [])

  const draw = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) {
      return
    }
    const ratio = window.devicePixelRatio || 1
    const width = container.clientWidth
    const height = container.clientHeight
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
    }
    // The canvas stays pinned by CSS while the spacer supplies the full
    // history height. Avoid deferred scroll compensation so a repaint of
    // the neighbouring commit editor cannot expose a displaced frame.
    canvas.style.height = `${height}px`

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    refRects.current = []
    truncatedSubjects.current.clear()
    context.textBaseline = 'middle'
    const computed = getComputedStyle(canvas)
    const light = computed.colorScheme === 'light'
    const laneColors = light ? LIGHT_LANE_COLORS : LANE_COLORS
    const fontFamily = computed.getPropertyValue('--sans').trim()
    const textColor = computed.getPropertyValue('--text').trim() || '#e1e5ec'
    const mutedColor = computed.getPropertyValue('--muted').trim() || '#8992a2'
    const accentColor = computed.getPropertyValue('--accent').trim() || '#f5bb45'
    const accentTextColor =
      computed.getPropertyValue('--accent-text').trim() || accentColor
    // Text drawn *on* the accent fill (the HEAD pill) needs the dark accent
    // contrast color; `--accent-text` is the accent hue meant for dark
    // backgrounds and would be unreadable on top of it.
    const accentContrastColor =
      computed.getPropertyValue('--accent-contrast').trim() || '#171a1f'
    const surfaceColor = computed.getPropertyValue('--surface').trim() || '#15181e'
    const warningColor = computed.getPropertyValue('--warning').trim() || '#f0a45b'
    const infoColor = computed.getPropertyValue('--info').trim() || '#81a9ef'
    const borderColor = computed.getPropertyValue('--border').trim()
    const raisedColor = computed.getPropertyValue('--surface-raised').trim()
    const bgColor = computed.getPropertyValue('--bg').trim() || '#181b22'

    const col = layout
    const scrollTop = scrollTopRef.current
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(
      commits.length - 1,
      Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    )

    // Constant pitch, centred in the column: lanes never hug the labels and
    // never compress unless the column itself was dragged narrower.
    const pitch = Math.min(
      LANE_PITCH,
      Math.max(10, (col.graph - 16) / Math.max(1, maxLanes)),
    )
    const graphLeft =
      col.refs + Math.max(8, (col.graph - pitch * maxLanes) / 2) + pitch / 2
    const messageX = col.refs + col.graph + 14
    const messageRight = width - col.author - col.date
    const stripInset = 3
    const chipText = light ? '#101216' : '#F4F6FA'

    const laneX = (lane: number) => graphLeft + lane * pitch
    /** Corner radius for an elbow, capped by half the run and half a row. */
    const corner = (from: number, to: number) =>
      Math.min(ELBOW_RADIUS, Math.abs(to - from) / 2, ROW_HEIGHT / 2 - 1)
    const laneColor = (lane: number) => laneColors[lane % laneColors.length]!
    const emphasisFor = (sha: string, index: number) =>
      sha === selected ? 0.5 : picked.includes(sha) ? 0.34 : hoveredRef.current === index ? 0.18 : 0

    // 1. Row emphasis stays neutral: only the graph column carries the branch
    // colors, so a selected row lifts the surface instead of tinting the row.
    for (let index = first; index <= last; index += 1) {
      const commit = commits[index]
      if (!commit) continue
      const y = index * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
      const emphasis = emphasisFor(commit.sha, index)
      if (emphasis > 0) {
        context.globalAlpha = emphasis
        context.fillStyle = raisedColor
        context.beginPath()
        context.roundRect(6, y - ROW_HEIGHT / 2 + stripInset, Math.max(0, width - 12), ROW_HEIGHT - stripInset * 2, 4)
        context.fill()
        context.globalAlpha = 1
      }
      if (commit.sha === selected || picked.includes(commit.sha)) {
        context.fillStyle = accentColor
        context.fillRect(2, y - ROW_HEIGHT / 2 + stripInset, 2, ROW_HEIGHT - stripInset * 2)
      }
    }

    // 2. Lane rails. Each span carries its own extents, so a lane opens on the
    // elbow of the commit that created it and stops on the commit it reaches
    // instead of running through the whole row.
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 2
    context.save()
    context.beginPath()
    context.rect(col.refs, 0, col.graph, height)
    context.clip()
    for (let index = first; index <= last; index += 1) {
      const row = rows[index]
      if (!row) continue
      const top = index * ROW_HEIGHT - scrollTop
      const center = top + ROW_HEIGHT / 2
      const nodeX = laneX(row.nodeLane)
      for (const rail of row.rails) {
        const x = laneX(rail.lane)
        // A rail opened by a parent edge starts after the elbow's corner; the
        // node lane stops on the dot.
        const start = rail.fromTop ? top : center + corner(x, nodeX)
        const end = rail.toBottom ? top + ROW_HEIGHT : center
        if (end - start < 0.5) continue
        context.strokeStyle = laneColor(rail.lane)
        context.beginPath()
        context.moveTo(x, start)
        context.lineTo(x, end)
        context.stroke()
      }
    }

    // 3. Parent edges: the horizontal run sits on the commit's centerline and
    // turns into the parent lane with a rounded corner, the shape GitKraken
    // uses, instead of a full-row S-curve crossing every other lane.
    for (let index = first; index <= last; index += 1) {
      const row = rows[index]
      if (!row) continue
      const center = index * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
      const nodeX = laneX(row.nodeLane)
      for (const parentLane of row.parents) {
        if (parentLane === row.nodeLane) continue
        const x = laneX(parentLane)
        const radius = corner(nodeX, x)
        const sign = x > nodeX ? 1 : -1
        context.strokeStyle = laneColor(parentLane)
        context.beginPath()
        context.moveTo(nodeX, center)
        context.lineTo(x - sign * radius, center)
        context.arcTo(x, center, x, center + radius, radius)
        context.stroke()
      }
    }

    // 4. Commit nodes are drawn after every edge, so no line overpaints a dot.
    // The gap ring keeps the dot readable where a rail touches it and the HEAD
    // commit gets an accent ring.
    for (let index = first; index <= last; index += 1) {
      const commit = commits[index]
      const row = rows[index]
      if (!commit || !row) continue
      const y = index * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
      const nodeX = laneX(row.nodeLane)
      const isSelected = commit.sha === selected
      const headCommit = commit.refs.some((raw) => raw === 'HEAD' || raw.startsWith('HEAD -> '))
      const radius = isSelected ? NODE_RADIUS + 1 : NODE_RADIUS
      const rowBackground = mix(bgColor, raisedColor, emphasisFor(commit.sha, index))
      if (isSelected || headCommit) {
        context.fillStyle = rowBackground
        context.beginPath()
        context.arc(nodeX, y, radius + 2.4, 0, Math.PI * 2)
        context.fill()
      }
      context.fillStyle = laneColor(row.nodeLane)
      context.beginPath()
      context.arc(nodeX, y, radius, 0, Math.PI * 2)
      context.fill()
      if (isSelected || headCommit) {
        context.strokeStyle = accentColor
        context.lineWidth = 1.5
        context.beginPath()
        context.arc(nodeX, y, radius + 3.2, 0, Math.PI * 2)
        context.stroke()
        context.lineWidth = 2
      }
    }
    context.restore()

    // 5. Reference pills, message and columns.
    for (let index = first; index <= last; index += 1) {
      const commit = commits[index]
      const row = rows[index]
      if (!commit || !row) {
        continue
      }
      const y = index * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
      const nodeColor = laneColor(row.nodeLane)

      // References: every visible ref is a colored pill, overflow becomes `+N`.
      const refs = decorations.get(commit.sha)
      if (col.refs > 0 && refs) {
        context.font = `600 12px ${fontFamily}`
        let cursorX = 12
        let drawn = 0
        for (const ref of refs) {
          const kindColor =
            ref.kind === 'head'
              ? accentColor
              : ref.kind === 'tag'
                ? warningColor
                : ref.kind === 'remote'
                  ? infoColor
                  : ref.kind === 'local'
                    ? nodeColor
                    : mutedColor
          const tone = ref.kind === 'head' ? accentContrastColor : chipText
          const available = col.refs - 10 - cursorX - BADGE_ICON_WIDTH - 14
          if (available < 20) break
          const label = fitText(context, ref.label, available)
          const chipWidth = Math.min(
            col.refs - 8 - cursorX,
            context.measureText(label).width + BADGE_ICON_WIDTH + 16,
          )
          if (chipWidth < 24) break
          context.fillStyle =
            ref.kind === 'head' ? accentColor : mix(surfaceColor, kindColor, light ? 0.2 : 0.32)
          context.beginPath()
          context.roundRect(cursorX, y - 10, chipWidth, 20, 4)
          context.fill()
          drawRefIcon(context, ref.kind, cursorX + 5, y, tone)
          context.fillStyle = tone
          context.fillText(label, cursorX + 5 + BADGE_ICON_WIDTH + 4, y)
          refRects.current.push({ commit, raw: ref.raw, x: cursorX, y: y - 10, width: chipWidth, height: 20 })
          cursorX += chipWidth + 4
          drawn += 1
        }
        const extra = refs.length - drawn
        if (extra > 0) {
          const label = `+${extra}`
          const chipWidth = context.measureText(label).width + 12
          if (cursorX + chipWidth <= col.refs - 8) {
            context.fillStyle = raisedColor
            context.beginPath()
            context.roundRect(cursorX, y - 10, chipWidth, 20, 4)
            context.fill()
            context.fillStyle = mutedColor
            context.fillText(label, cursorX + 6, y)
            refRects.current.push({ commit, raw: refs[refs.length - 1]!.raw, x: cursorX, y: y - 10, width: chipWidth, height: 20, overflow: true })
          }
        }
      }

      context.save()
      context.beginPath()
      context.rect(messageX, y - ROW_HEIGHT / 2, Math.max(0, messageRight - messageX - 12), ROW_HEIGHT)
      context.clip()
      let cursor = messageX
      context.font = `14px ${fontFamily}`
      if (mrBadges) {
        const badge = commit.refs.map((ref) => mrBadges[ref.replace('HEAD -> ', '').replace(/^origin\//, '')]).find(Boolean)
        if (badge) {
          const badgeText = `!${badge.iid}`
          context.fillStyle = badge.state === 'success' ? computed.getPropertyValue('--success').trim() : badge.state === 'failed' ? computed.getPropertyValue('--error').trim() : mutedColor
          context.fillText(badgeText, cursor, y)
          cursor += context.measureText(badgeText).width + 12
        }
      }
      const subjectWidth = messageRight - cursor - 16
      if (context.measureText(commit.subject).width > subjectWidth) {
        truncatedSubjects.current.add(commit.sha)
      }
      context.fillStyle = textColor
      context.fillText(fitText(context, commit.subject, subjectWidth), cursor, y)
      context.restore()
      context.font = `12px ${fontFamily}`
      context.fillStyle = mutedColor
      if (col.author) context.fillText(fitText(context, commit.author.name, col.author - 20), width - col.author - col.date + 10, y)
      if (col.date) context.fillText(fitText(context, commitDateLabel(commit.committer.timestamp), col.date - 16), width - col.date + 8, y)

    }

    const dropRect = dragTargetRect.current
    if (dropRect) {
      context.strokeStyle = accentTextColor
      context.lineWidth = 2
      context.beginPath()
      context.roundRect(dropRect.x - 1, dropRect.y - 1, dropRect.width + 2, dropRect.height + 2, 5)
      context.stroke()
    }

    context.strokeStyle = borderColor
    context.lineWidth = 1
    for (const x of [col.refs, col.refs + col.graph, ...(col.author ? [width - col.author - col.date] : []), ...(col.date ? [width - col.date] : [])]) {
      if (x > 0) { context.beginPath(); context.moveTo(x + .5, 0); context.lineTo(x + .5, height); context.stroke() }
    }

  }, [commits, rows, selected, mrBadges, picked, maxLanes, layout, decorations])

  useLayoutEffect(() => {
    drawRef.current = draw
  }, [draw])

  useEffect(() => {
    const times = frameTimes.current
    const stats: FrameStats = {
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      missed: times.filter((value) => value > 50).length,
    }
    statsRef.current = stats
    window.__beebranchGraphStats = stats
    const timer = window.setInterval(() => {
      if (times.length > 0) {
        statsRef.current = {
          p50: percentile(times, 0.5),
          p95: percentile(times, 0.95),
          missed: times.filter((value) => value > 50).length,
        }
        window.__beebranchGraphStats = statsRef.current
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    scheduleDraw()
    void document.fonts.ready.then(scheduleDraw)
    if (commits.length > 0) {
      performance.mark('graph.first-page')
    }
  }, [scheduleDraw, draw, commits.length, generation, theme])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const observer = new ResizeObserver(() => { setViewportWidth(container.clientWidth); scheduleDraw() })
    observer.observe(container)
    return () => observer.disconnect()
  }, [scheduleDraw])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', scheduleDraw)
    const observer = new MutationObserver(scheduleDraw)
    observer.observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] })
    return () => { media.removeEventListener('change', scheduleDraw); observer.disconnect() }
  }, [scheduleDraw])

  useEffect(() => {
    if (!drag) return
    const abort = () => {
      dragStart.current = null
      dragTargetRect.current = null
      setDrag(null)
      scheduleDraw()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') abort()
    }
    const releaseOutside = (event: PointerEvent) => {
      const canvas = canvasRef.current
      if (canvas && event.target instanceof Node && canvas.contains(event.target)) return
      abort()
    }
    document.addEventListener('keydown', escape)
    window.addEventListener('pointerup', releaseOutside)
    return () => {
      document.removeEventListener('keydown', escape)
      window.removeEventListener('pointerup', releaseOutside)
    }
  }, [drag, scheduleDraw])

  useEffect(() => {
    if (!branchTarget) return
    const index = commits.findIndex((commit) => commit.sha === branchTarget)
    const container = containerRef.current
    if (index < 0 || !container) return
    const top = index * ROW_HEIGHT
    if (top < container.scrollTop || top + ROW_HEIGHT > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, top - container.clientHeight / 4)
      scrollTopRef.current = container.scrollTop
      scheduleDraw()
    }
  }, [branchTarget, commits, scheduleDraw])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  useEffect(() => {
    if (!refHover) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.metaKey || event.ctrlKey) setRefHover(null) }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
      if (event.target !== canvasRef.current) setRefHover(null)
    }
    const resize = () => setRefHover(null)
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    window.addEventListener('blur', resize)
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); window.removeEventListener('blur', resize) }
  }, [refHover])

  const dropTargetAt = (clientX: number, clientY: number, source: RefEntry) => {
    const hit = hitRef(clientX, clientY)
    if (!hit) return null
    const entry = resolveGraphRef(hit.raw, refEntries)
    if (!entry || entry.kind !== 'branch') return null
    if (entry.fullName === source.fullName) return null
    return {
      entry,
      rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height },
    }
  }

  const hitRef = (clientX: number, clientY: number) => {
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!bounds) return
    const x = clientX - bounds.left, y = clientY - bounds.top
    return refRects.current.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)
  }

  const onScroll = () => {
    cancelRefClose()
    setRefHover(null)
    // Rows moved under a still cursor: drop the tooltip measured for the
    // previous offset instead of leaving a stale subject on screen.
    if (canvasRef.current) canvasRef.current.title = ''
    const container = containerRef.current
    if (!container) {
      return
    }
    scrollTopRef.current = container.scrollTop
    if (
      !loading &&
      container.scrollTop + container.clientHeight >
        container.scrollHeight - ROW_HEIGHT * 4
    ) {
      onLoadMore()
    }
    scheduleDraw()
  }

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 0 && !branchTarget) {
      const hit = hitRef(event.clientX, event.clientY)
      if (hit && !hit.overflow) {
        const entry = resolveGraphRef(hit.raw, refEntries)
        if (entry && (entry.kind === 'branch' || entry.kind === 'remoteBranch')) {
          cancelRefClose()
          dragStart.current = { entry, x: event.clientX, y: event.clientY }
          return
        }
      }
    }
    onPointer(event)
  }

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = dragStart.current
    if (start) {
      if (!drag && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) {
        return
      }
      if (!drag) {
        setRefHover(null)
      }
      const found = dropTargetAt(event.clientX, event.clientY, start.entry)
      dragTargetRect.current = found?.rect ?? null
      scheduleDraw()
      setDrag({ entry: start.entry, x: event.clientX, y: event.clientY, target: found?.entry ?? null })
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((scrollTopRef.current + event.clientY - bounds.top) / ROW_HEIGHT)
    const hit = hitRef(event.clientX, event.clientY)
    if (hit) {
      const refs = decorations.get(hit.commit.sha)
      // One real ref (a branch and its own remote mirror count as one) leaves
      // nothing to choose between: keep the tooltip, skip the menu.
      if ((refs?.length ?? hit.commit.refs.length) < 2) {
        if (refHover) closeRefSoon()
        const ref = refs?.[0]
        event.currentTarget.title = ref
          ? `${ref.label} · ${ref.kind === 'remote' ? 'distante' : ref.kind === 'tag' ? 'tag' : 'locale'}`
          : ''
      } else {
        cancelRefClose()
        event.currentTarget.title = ''
        setRefHover((current) => current?.commit.sha === hit.commit.sha ? current : { commit:hit.commit, left:bounds.left + hit.x, top:bounds.top + hit.y, bottom:bounds.top + hit.y + hit.height })
      }
    } else {
      if (refHover) closeRefSoon()
      const commit = commits[index]
      // No tooltip on a readable row: only a subject cut by the message column
      // needs the popup to reveal its full text.
      event.currentTarget.title =
        commit && truncatedSubjects.current.has(commit.sha)
          ? `${commit.subject}\n${commit.author.name} · ${commit.sha.slice(0, 12)}`
          : ''
    }
    if (hoveredRef.current !== index) { hoveredRef.current = index; scheduleDraw() }
  }

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = dragStart.current
    dragStart.current = null
    if (drag) {
      const target = drag.target
      dragTargetRect.current = null
      setDrag(null)
      scheduleDraw()
      if (start && target && onRefDrop) {
        onRefDrop(start.entry, target, event.clientX, event.clientY)
      }
      return
    }
    dragTargetRect.current = null
  }

  const onPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // A badge click must not resize the graph before the second click arrives.
    if (hitRef(event.clientX, event.clientY)) return
    setRefHover(null)
    const bounds = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(
      (scrollTopRef.current + (event.clientY - bounds.top)) / ROW_HEIGHT,
    )
    const commit = commits[index]
    if (commit) {
      onSelect(commit.sha, {
        shift: event.shiftKey,
        meta: event.metaKey || event.ctrlKey,
      })
    }
  }

  const onContextMenuEvent = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    setRefHover(null)
    const hit = hitRef(event.clientX, event.clientY)
    if (hit && onRefContextMenu) {
      const entry = resolveGraphRef(hit.raw, refEntries)
      if (entry && (entry.kind === 'branch' || entry.kind === 'remoteBranch')) {
        onRefContextMenu(entry, event.clientX, event.clientY)
        return
      }
    }
    if (!onContextMenu) {
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(
      (scrollTopRef.current + (event.clientY - bounds.top)) / ROW_HEIGHT,
    )
    const commit = commits[index]
    if (commit) {
      onSelect(commit.sha, { shift: false, meta: false })
      onContextMenu(commit, event.clientX, event.clientY)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (commits.length === 0) {
      return
    }
    const current = commits.findIndex((commit) => commit.sha === selected)
    const index = current >= 0 ? current : 0
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && onContextMenu) {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      onContextMenu(commits[index]!, bounds.left + 120, Math.max(bounds.top, bounds.top + index * ROW_HEIGHT - scrollTopRef.current))
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? commits.length - 1 : Math.max(0, Math.min(commits.length - 1, current < 0 ? 0 : index + (event.key === 'ArrowDown' ? 1 : -1)))
      const commit = commits[next]
      if (commit) {
        onSelect(commit.sha, {
          shift: event.shiftKey,
          meta: event.metaKey || event.ctrlKey,
        })
        const container = containerRef.current
        if (container) {
          const top = next * ROW_HEIGHT
          if (top < container.scrollTop) container.scrollTop = top
          else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight) container.scrollTop = top + ROW_HEIGHT - container.clientHeight
          scrollTopRef.current = container.scrollTop
          scheduleDraw()
        }
      }
    }

  }

  return (
    <div className={styles.wrap} style={{ '--refs-width': `${layout.refs}px`, '--graph-width': `${layout.graph}px`, '--author-width': `${layout.author}px`, '--date-width': `${layout.date}px` } as React.CSSProperties}>
      <div className={styles.columns} style={{ gridTemplateColumns: `${layout.refs}px ${layout.graph}px minmax(0,1fr) ${layout.author}px ${layout.date}px` }}>
        <div className={styles.refsHeader}>
          <span>{layout.refs ? 'Branches / tags' : ''}</span>
          {layout.refs && onBranchRequest ? (
            <button type="button" className={styles.addRef} title="Créer une branche sur le commit sélectionné" aria-label="Créer une branche" onClick={() => onBranchRequest(selected ?? null)}>+</button>
          ) : null}
        </div>
        <span>Graphe</span><div className={styles.messageHeader}><span>Message de commit</span>{headerTools}</div><span>{layout.author ? 'Auteur' : ''}</span><span>{layout.date ? 'Date' : ''}</span>
      </div>
      {([
        ['refs', 'Largeur de la colonne Références', 'right'],
        ['graph', 'Largeur du graphe', 'right'],
        ['author', 'Largeur de la colonne Auteur', 'left'],
        ['date', 'Largeur de la colonne Date', 'left'],
      ] as const).map(([key, label, side]) => {
        if (key === 'author' && layout.author === 0) return null
        const boundary =
          key === 'refs'
            ? layout.refs
            : key === 'graph'
              ? layout.refs + layout.graph
              : key === 'author'
                ? viewportWidth - layout.author - layout.date
                : viewportWidth - layout.date
        return (
          <Resizer
            key={key}
            className={styles.columnResizer}
            style={{ left: Math.max(4, boundary) }}
            label={label}
            side={side}
            value={layout[key]}
            min={COLUMN_FLOORS[key]}
            max={maxColumn(key)}
            onChange={(value) => resizeColumn(key, value)}
            onReset={() => onColumnWidthsChange?.(null)}
          />
        )
      })}
      {worktreeRow}
      <div className={styles.scroll} style={{ top: worktreeRow ? 64 : 32 }} ref={containerRef} onScroll={onScroll}>
        <div
          className={styles.spacer}
          style={{ height: Math.max(1, commits.length * ROW_HEIGHT) }}
        />
        {branchTarget ? (() => {
          const index = commits.findIndex((commit) => commit.sha === branchTarget)
          if (index < 0) return null
          return (
            <form
              className={styles.createRow}
              style={{ top: index * ROW_HEIGHT + 2, width: layout.refs > 0 ? Math.max(180, layout.refs - 16) : 220 }}
              onSubmit={(event) => { event.preventDefault(); onBranchSubmit?.() }}
            >
              <input
                autoFocus
                value={branchName}
                onChange={(event) => onBranchName?.(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); onBranchCancel?.() }
                }}
                placeholder="nom de la branche"
                aria-label="Nom de la nouvelle branche"
                spellCheck={false}
              />
              <button type="submit" className={styles.createSubmit} disabled={branchName.trim().length === 0} aria-label="Créer la branche" title="Créer la branche">↵</button>
            </form>
          )
        })() : null}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          data-dragging={drag ? 'true' : undefined}
          role="img"
          tabIndex={0}
          aria-label={`Graphe d'historique, ${commits.length} commits chargés`}
          onPointerMove={onCanvasPointerMove}
          onPointerLeave={(event) => {
            if (drag) return
            hoveredRef.current = null
            scheduleDraw()
            if (!(event.relatedTarget instanceof Node && popupRef.current?.contains(event.relatedTarget))) closeRefSoon()
          }}
          onDoubleClick={(event) => {
            const hit = hitRef(event.clientX, event.clientY)
            if (hit && !hit.overflow) { event.preventDefault(); checkoutRef(hit.commit.refs[0]!) }
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerUp={onCanvasPointerUp}
          onContextMenu={onContextMenuEvent}
          onKeyDown={onKeyDown}
        />
      </div>
      {drag ? (
        <div
          className={styles.dragGhost}
          data-target={drag.target ? 'true' : 'false'}
          style={{ left: drag.x + 14, top: drag.y + 12 }}
          role="status"
        >
          <strong>{drag.entry.name}</strong>
          <span>{drag.target ? `→ ${drag.target.name}` : 'Déposer sur une branche'}</span>
        </div>
      ) : null}
      {refHover ? <GraphRefPopover anchor={refHover} entries={refEntries} disabled={checkoutDisabled || !onCheckoutRef} elementRef={popupRef} onEnter={cancelRefClose} onLeave={closeRefSoon} onCheckout={checkoutRef} onClose={() => { setRefHover(null); canvasRef.current?.focus() }} /> : null}
      <div className={styles.footer}><span>{commits.length} commits chargés{rows.some((row) => row.overflow) ? ' · Certaines branches sont regroupées' : ''}</span><span>{loading ? 'Chargement…' : 'Glissez une branche sur une autre pour l’intégrer · ↑ ↓ pour parcourir · Maj+clic pour sélectionner une plage · ⌘/Ctrl+clic pour comparer deux commits seulement · clic droit pour les actions'}</span></div>
      <span className={styles.srOnly} role="status">{selected ? commits.find((commit) => commit.sha === selected)?.subject : ''}</span>
    </div>
  )
}

