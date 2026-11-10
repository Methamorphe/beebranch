import type { AppError } from '../../types/git'
import { getLocale } from '../translate'
import en from './en'
import fr from './fr'
import type { ErrorCopy } from './types'

export type { ErrorCopy }

/**
 * Localised error text.
 *
 * Known codes use the catalogue of the active language. A catalogue line that
 * still contains `{placeholders}` is a template the backend has already
 * filled, so the backend sentence is kept for French and the catalogue line
 * for English. An unknown code keeps the backend sentence: that is the only
 * text available.
 */
export function errorCopy(error: AppError): { message: string; remediation: string | null } {
  const catalog = getLocale() === 'en' ? en : fr
  const entry = catalog[error.code as keyof typeof catalog] as ErrorCopy | undefined
  if (entry && !entry.message.includes('{')) {
    return {
      message: entry.message,
      remediation: entry.remediation ?? (getLocale() === 'fr' ? error.remediation ?? null : null),
    }
  }
  if (getLocale() === 'en' && entry) {
    return {
      message: entry.message,
      remediation: entry.remediation ?? null,
    }
  }
  return {
    message: error.message,
    remediation: error.remediation ?? null,
  }
}
