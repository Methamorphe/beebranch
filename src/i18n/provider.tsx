import { useEffect, useMemo, type ReactNode } from 'react'
import { I18nContext } from './context'
import type { Locale } from './locale'
import { getLocale, setLocale } from './translate'

type Props = {
  locale: Locale
  onChange: (locale: Locale) => void
  children: ReactNode
}

/**
 * Applies `locale` to the translation runtime and re-renders its children when
 * the language changes.
 *
 * The module-level language is updated during render on purpose: children call
 * `t` while they render, so it must already be current. The update is
 * idempotent, which keeps it safe under StrictMode. The `<html lang>` attribute
 * is a DOM side effect and waits for the commit.
 */
export function I18nProvider({ locale, onChange, children }: Props) {
  if (getLocale() !== locale) {
    setLocale(locale)
  }
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  const value = useMemo(() => ({ locale, changeLocale: onChange }), [locale, onChange])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
