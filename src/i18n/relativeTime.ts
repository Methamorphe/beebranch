import { localeTag, type Locale } from './locale.ts'

const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>()

/** Beyond a week a relative age is harder to read than the date itself. */
const RELATIVE_LIMIT_SECONDS = 7 * 24 * 3600

/**
 * "3 hours ago", "yesterday" for a date within the last week, `null` beyond
 * (or in the future, e.g. a skewed committer clock): callers then show the
 * absolute date.
 */
export function formatRelativeTime(value: Date, locale: Locale, now: Date = new Date()): string | null {
  const seconds = Math.round((now.getTime() - value.getTime()) / 1000)
  if (seconds < 0 || seconds >= RELATIVE_LIMIT_SECONDS) return null
  let formatter = relativeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: 'auto' })
    relativeFormatters.set(locale, formatter)
  }
  if (seconds < 60) return formatter.format(0, 'second')
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour')
  return formatter.format(-Math.floor(seconds / 86400), 'day')
}
