/** Interface languages supported by the application. */
export const LOCALES = ['fr', 'en'] as const

export type Locale = (typeof LOCALES)[number]

/** Fallback used when neither the preference nor the system locale decides. */
export const DEFAULT_LOCALE: Locale = 'fr'

/** Persisted preference holding the interface language code. */
export const LANGUAGE_PREFERENCE_KEY = 'ui.language'

/** BCP 47 tag used by `Intl` formatters for each interface language. */
const LOCALE_TAGS: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale]
}

/** Native names, so the picker is readable whatever the current language is. */
export const LOCALE_NAMES: Record<Locale, string> = {
  fr: 'Français',
  en: 'English',
}

/**
 * Pick the initial language from the system preferences.
 *
 * The app ships French and English; every other system language falls back to
 * English, the widest common denominator, and the stored preference always
 * wins once it has been read.
 */
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') {
    return DEFAULT_LOCALE
  }
  const preferred = [navigator.language, ...(navigator.languages ?? [])]
  for (const tag of preferred) {
    const lower = tag.toLowerCase()
    if (lower.startsWith('fr')) {
      return 'fr'
    }
    if (lower.startsWith('en')) {
      return 'en'
    }
  }
  return preferred.length > 0 ? 'en' : DEFAULT_LOCALE
}
