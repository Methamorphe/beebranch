/** Persisted workspace geometry: navigation, inspector and history columns. */
export type GraphColumnWidths = {
  refs: number
  graph: number
  author: number
  date: number
}

export type LayoutPreferences = {
  sidebar: number
  inspector: number
  graph: GraphColumnWidths | null
}

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 420
export const INSPECTOR_MIN = 300
export const INSPECTOR_MAX = 760
/** The message column keeps this much room before fixed columns are shrunk. */
export const MIN_MESSAGE_WIDTH = 160
export const COLUMN_FLOORS: GraphColumnWidths = {
  refs: 0,
  graph: 56,
  author: 0,
  date: 84,
}
export const COLUMN_CEILINGS: GraphColumnWidths = {
  refs: 260,
  graph: 320,
  author: 240,
  date: 200,
}

export function clamp(value: number, min: number, max: number) {
  const ceiling = Math.max(min, max)
  return Math.min(Math.max(value, min), ceiling)
}

export function defaultInspectorWidth() {
  return Math.round(clamp(window.innerWidth * 0.27, INSPECTOR_MIN, INSPECTOR_MAX))
}

export function defaultLayout(): LayoutPreferences {
  return { sidebar: 210, inspector: defaultInspectorWidth(), graph: null }
}

/**
 * The message column is flexible; fixed columns are shrunk when the viewport
 * cannot honour every stored width (small window, narrow split).
 */
export function clampColumnWidths(
  width: number,
  wanted: GraphColumnWidths,
): GraphColumnWidths {
  const next: GraphColumnWidths = {
    refs: clamp(wanted.refs, COLUMN_FLOORS.refs, COLUMN_CEILINGS.refs),
    graph: clamp(wanted.graph, COLUMN_FLOORS.graph, COLUMN_CEILINGS.graph),
    author: clamp(wanted.author, COLUMN_FLOORS.author, COLUMN_CEILINGS.author),
    date: clamp(wanted.date, COLUMN_FLOORS.date, COLUMN_CEILINGS.date),
  }
  let excess =
    next.refs + next.graph + next.author + next.date -
    (width - MIN_MESSAGE_WIDTH)
  for (const key of ['author', 'refs', 'date', 'graph'] as const) {
    if (excess <= 0) break
    const removable = Math.max(0, Math.min(excess, next[key] - COLUMN_FLOORS[key]))
    next[key] -= removable
    excess -= removable
  }
  return next
}

function readWidth(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback
}

export function parseLayout(raw: string | null): LayoutPreferences {
  const base = defaultLayout()
  if (!raw) {
    return base
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return base
    }
    const record = parsed as Record<string, unknown>
    const graphRaw = record.graph
    let graph: GraphColumnWidths | null = null
    if (graphRaw && typeof graphRaw === 'object') {
      const values = graphRaw as Record<string, unknown>
      if (
        [values.refs, values.graph, values.author, values.date].every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
      ) {
        graph = {
          refs: readWidth(values.refs, COLUMN_FLOORS.refs, COLUMN_FLOORS.refs, COLUMN_CEILINGS.refs),
          graph: readWidth(values.graph, COLUMN_FLOORS.graph, COLUMN_FLOORS.graph, COLUMN_CEILINGS.graph),
          author: readWidth(values.author, COLUMN_FLOORS.author, COLUMN_FLOORS.author, COLUMN_CEILINGS.author),
          date: readWidth(values.date, COLUMN_FLOORS.date, COLUMN_FLOORS.date, COLUMN_CEILINGS.date),
        }
      }
    }
    return {
      sidebar: readWidth(record.sidebar, base.sidebar, SIDEBAR_MIN, SIDEBAR_MAX),
      inspector: readWidth(record.inspector, base.inspector, INSPECTOR_MIN, INSPECTOR_MAX),
      graph,
    }
  } catch {
    return base
  }
}
