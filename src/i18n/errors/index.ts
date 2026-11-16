import type { AppError } from '../../types/git'
import { getLocale } from '../translate'
import en from './en'
import fr from './fr'
import type { ErrorCopy } from './types'

export type { ErrorCopy }

/** Fill `{name}` from `params`. An unknown name is left in place. */
export function fillErrorTemplate(
  template: string,
  params: Record<string, string> | undefined,
): string {
  if (!template.includes('{')) return template
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined || value === '' ? match : value
  })
}

/**
 * Localised error text.
 *
 * Known codes use the catalogue of the active language. Placeholders are
 * filled from `params`. A template that is still unfilled falls back to the
 * backend sentence, which is already formatted. An unknown code keeps that
 * sentence: it is the only text available.
 */
export function errorCopy(error: AppError): { message: string; remediation: string | null } {
  const catalog = getLocale() === 'en' ? en : fr
  const entry = catalog[error.code as keyof typeof catalog] as ErrorCopy | undefined
  if (!entry) {
    return { message: error.message, remediation: error.remediation ?? null }
  }
  const filled = fillErrorTemplate(entry.message, error.params)
  const message = filled.includes('{') ? error.message : filled
  if (entry.remediation) {
    const remediation = fillErrorTemplate(entry.remediation, error.params)
    return {
      message,
      remediation: remediation.includes('{') ? error.remediation ?? null : remediation,
    }
  }
  return {
    message,
    remediation: getLocale() === 'fr' ? error.remediation ?? null : null,
  }
}
