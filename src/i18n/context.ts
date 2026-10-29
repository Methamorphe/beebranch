import { createContext } from 'react'
import { DEFAULT_LOCALE, type Locale } from './locale'

export type I18nContextValue = {
  locale: Locale
  changeLocale: (locale: Locale) => void
}

/** Active interface language and its setter, provided by `I18nProvider`. */
export const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  changeLocale: () => undefined,
})
