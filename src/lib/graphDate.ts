/**
 * Date column of the commit graph.
 *
 * `relative` keeps the historical behaviour: a relative age for the last seven
 * days, then the short date and time. Every other value always shows that
 * absolute format, including for recent commits.
 */

// Explicit extensions: `scripts/graph-date-format-check.ts` imports this module
// straight from Node, which resolves ESM specifiers literally.
import { localeTag, type Locale } from '../i18n/locale.ts'
import { formatRelativeTime } from '../i18n/relativeTime.ts'

export const GRAPH_DATE_PREFERENCE = 'ui.graphDateFormat'

export const GRAPH_DATE_FORMATS = [
  'relative',
  'dateTime',
  'date',
  'numericTime',
  'numeric',
  'isoTime',
  'iso',
] as const

export type GraphDateFormat = (typeof GRAPH_DATE_FORMATS)[number]

export const DEFAULT_GRAPH_DATE_FORMAT: GraphDateFormat = 'relative'

/** Fixed local sample so each option shows the format, not the current time. */
export const GRAPH_DATE_SAMPLE = new Date(2026, 2, 28, 23, 59)

const CHANGED_EVENT = 'beebranch:graph-date-changed'

const DATE_FIELDS: Record<
  Exclude<GraphDateFormat, 'relative' | 'iso' | 'isoTime'>,
  Intl.DateTimeFormatOptions
> = {
  dateTime: { day: '2-digit', month: 'short', year: 'numeric' },
  date: { day: '2-digit', month: 'short', year: 'numeric' },
  numericTime: { day: '2-digit', month: '2-digit', year: 'numeric' },
  numeric: { day: '2-digit', month: '2-digit', year: 'numeric' },
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(localeTag(locale), options)
    dateFormatters.set(key, formatter)
  }
  return formatter
}

const WITH_TIME = new Set<GraphDateFormat>(['dateTime', 'numericTime', 'isoTime'])

let current: GraphDateFormat = DEFAULT_GRAPH_DATE_FORMAT
/** Bumped only when the user picks a format, so a late preference read cannot overwrite it. */
let userEpoch = 0

export function isGraphDateFormat(value: string | null | undefined): value is GraphDateFormat {
  return value != null && (GRAPH_DATE_FORMATS as readonly string[]).includes(value)
}

export function parseGraphDateFormat(value: string | null | undefined): GraphDateFormat {
  return isGraphDateFormat(value) ? value : DEFAULT_GRAPH_DATE_FORMAT
}

export function getGraphDateFormat(): GraphDateFormat {
  return current
}

export function graphDateEpoch(): number {
  return userEpoch
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatIso(date: Date, withTime: boolean): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (!withTime) return day
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAbsolute(
  date: Date,
  format: Exclude<GraphDateFormat, 'relative'>,
  locale: Locale,
): string {
  if (format === 'iso' || format === 'isoTime') return formatIso(date, format === 'isoTime')
  const day = dateFormatter(locale, DATE_FIELDS[format]).format(date)
  if (!WITH_TIME.has(format)) return day
  const time = dateFormatter(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day} ${time}`
}

/** Label drawn in the graph date column. `timestamp` is Unix seconds. */
export function formatGraphCommitDate(
  timestamp: number,
  format: GraphDateFormat,
  locale: Locale,
  now: Date = new Date(),
): string {
  const date = new Date(timestamp * 1000)
  if (format === 'relative') {
    return formatRelativeTime(date, locale, now) ?? formatAbsolute(date, 'dateTime', locale)
  }
  return formatAbsolute(date, format, locale)
}

/** Example shown on a format option, in the active language. */
export function graphDateExample(
  format: Exclude<GraphDateFormat, 'relative'>,
  locale: Locale,
): string {
  return formatGraphCommitDate(Math.floor(GRAPH_DATE_SAMPLE.getTime() / 1000), format, locale)
}

function publish(format: GraphDateFormat) {
  if (current === format) return
  current = format
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

/** User choice: later preference reads that started earlier are ignored. */
export function rememberGraphDateFormat(format: GraphDateFormat) {
  userEpoch += 1
  publish(format)
}

/**
 * Apply a value just read from the preference store.
 * Returns false when the user picked a format after this read started.
 */
export function applyStoredGraphDate(raw: string | null | undefined, seenEpoch: number): boolean {
  if (seenEpoch !== userEpoch) return false
  publish(parseGraphDateFormat(raw))
  return true
}

export function onGraphDateFormatChanged(listener: (format: GraphDateFormat) => void): () => void {
  const handler = () => listener(current)
  window.addEventListener(CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHANGED_EVENT, handler)
}
