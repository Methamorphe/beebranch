import { useContext } from 'react'
import { I18nContext } from './context'
import type { Locale } from './locale'
import { plural, t, type MessageKey, type TranslationParams } from './translate'

export type I18n = {
  locale: Locale
  /** Translate a key for the active language. */
  t: (key: MessageKey, params?: TranslationParams) => string
  /** Pick the singular or plural message for `count`. */
  plural: (one: MessageKey, other: MessageKey, count: number, params?: TranslationParams) => string
  /** Switch the interface language; the provider owns persistence. */
  changeLocale: (locale: Locale) => void
}

/**
 * Language and translation helpers for a component.
 *
 * Reading the context subscribes the component to language changes even when
 * its parent skipped an update.
 */
export function useI18n(): I18n {
  const { locale, changeLocale } = useContext(I18nContext)
  return { locale, t, plural, changeLocale }
}
