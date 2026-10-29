/**
 * Minimal, dependency-free translation runtime.
 *
 * The catalogue is a flat `MessageKey -> string` map. The French catalogue is
 * the source of truth for the key set: TypeScript rejects an English catalogue
 * that misses one of its keys, so a component can never reference a message the
 * other language does not define.
 *
 * Components read the active language through {@link useI18n}; pure helpers
 * (notices, adapters) call {@link t} directly, which always reads the language
 * currently applied by the provider.
 */

import { en, fr } from './messages'
import { DEFAULT_LOCALE, localeTag, type Locale } from './locale'

export type MessageKey = keyof typeof fr
export type TranslationParams = Record<string, string | number>

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { fr, en }

let activeLocale: Locale = DEFAULT_LOCALE

/** Language applied to every `t` call outside React. */
export function getLocale(): Locale {
  return activeLocale
}

/**
 * Apply a language to the translation runtime.
 *
 * The provider calls this while rendering, before its children, so every `t`
 * call of the same render already sees the new language. DOM effects that
 * depend on the language (the `<html lang>` attribute) stay in the provider.
 */
export function setLocale(locale: Locale): void {
  activeLocale = locale
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Translate `key`, interpolating `{name}` placeholders from `params`. */
export function t(key: MessageKey, params?: TranslationParams): string {
  const template = CATALOGS[activeLocale][key] ?? CATALOGS[DEFAULT_LOCALE][key]
  return template === undefined ? key : interpolate(template, params)
}

/**
 * Pick the singular or plural message.
 *
 * French treats 0 and 1 as singular; English only 1. Callers pass the two keys
 * explicitly so the catalog stays fully typed.
 */
export function plural(
  one: MessageKey,
  other: MessageKey,
  count: number,
  params?: TranslationParams,
): string {
  const isOne = activeLocale === 'fr' ? count <= 1 : count === 1
  return t(isOne ? one : other, { count, ...params })
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

function dateFormatter(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${activeLocale}|${options ? JSON.stringify(options) : 'default'}`
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(localeTag(activeLocale), options)
    dateFormatters.set(key, formatter)
  }
  return formatter
}

function numberFormatter(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${activeLocale}|${options ? JSON.stringify(options) : 'default'}`
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(localeTag(activeLocale), options)
    numberFormatters.set(key, formatter)
  }
  return formatter
}

/** Format a date in the active language. */
export function formatDate(
  value: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return dateFormatter(options).format(value)
}

/** Format a date and time in the active language. */
export function formatDateTime(
  value: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return dateFormatter(options).format(value)
}

/** Unix timestamp (seconds) to a `Date`, as returned by the Git backend. */
export function dateFromSeconds(seconds: number): Date {
  return new Date(seconds * 1000)
}

/** Format a number with the active language's grouping and decimal separators. */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(options).format(value)
}
