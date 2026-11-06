/**
 * Background auto-fetch preference, shared by the Sync panel, the settings
 * page, the first-open prompt and the Workbench timer.
 *
 * The interval is one app-wide preference (minutes, `0` = off). Writers go
 * through `saveAutoFetchMinutes` so the Workbench timer re-reads the value
 * immediately instead of keeping the interval it read when the repository
 * was opened.
 */

import { preferenceGet, preferenceSet } from '../ipc/commands'
import type { MessageKey } from '../i18n'

export const AUTO_FETCH_PREFERENCE = 'git.autoFetchMinutes'
/** Set once the user has made (or dismissed) the first-open choice. */
export const AUTO_FETCH_PROMPTED_PREFERENCE = 'git.autoFetchPrompted'

const CHANGED_EVENT = 'beebranch:auto-fetch-changed'

/** Auto-fetch intervals, in minutes; `0` disables the background fetch. */
export const AUTO_FETCH_OPTIONS: { value: string; labelKey: MessageKey }[] = [
  { value: '0', labelKey: 'ops.sync.autoFetch.off' },
  { value: '1', labelKey: 'ops.sync.autoFetch.one' },
  { value: '5', labelKey: 'ops.sync.autoFetch.five' },
  { value: '15', labelKey: 'ops.sync.autoFetch.fifteen' },
  { value: '30', labelKey: 'ops.sync.autoFetch.thirty' },
]

/** Parses the stored value; anything but a positive number means "off". */
export function parseAutoFetchMinutes(raw: string | null | undefined): number {
  const minutes = Number(raw ?? '0')
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 0
}

/** Whether `value` is one of the choices the UI offers. */
export function isAutoFetchOption(value: string | null | undefined): value is string {
  return value != null && AUTO_FETCH_OPTIONS.some((option) => option.value === value)
}

/**
 * Whether the first-open prompt is still due. A value the user already chose
 * (in the Sync panel, before this prompt existed) counts as an answer, so
 * existing installs are asked only if they never touched the setting.
 */
export function autoFetchPromptDue(
  prompted: string | null | undefined,
  minutes: string | null | undefined,
): boolean {
  return !prompted && minutes == null
}

/** Persists the interval, marks the prompt as answered and notifies listeners. */
export async function saveAutoFetchMinutes(value: string): Promise<void> {
  await preferenceSet(AUTO_FETCH_PREFERENCE, value)
  await preferenceSet(AUTO_FETCH_PROMPTED_PREFERENCE, '1')
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

/** Records that the prompt was dismissed without changing the interval. */
export async function dismissAutoFetchPrompt(): Promise<void> {
  await preferenceSet(AUTO_FETCH_PROMPTED_PREFERENCE, '1')
}

/** Reads the stored interval in minutes (`0` = off). */
export async function loadAutoFetchMinutes(): Promise<number> {
  return parseAutoFetchMinutes(await preferenceGet(AUTO_FETCH_PREFERENCE))
}

/** Subscribes to interval changes; returns the unsubscribe function. */
export function onAutoFetchChanged(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener)
  return () => window.removeEventListener(CHANGED_EVENT, listener)
}
