import type { AppError } from '../../types/git'
import { getLocale } from '../translate'
import en from './en'
import type { ErrorCopy } from './types'

export type { ErrorCopy }

/** Localised error text; `null` remediation means the backend provides none. */
export function errorCopy(error: AppError): { message: string; remediation: string | null } {
  const entry = getLocale() === 'en' ? en[error.code as keyof typeof en] : undefined
  return {
    message: entry?.message ?? error.message,
    remediation: entry?.remediation ?? error.remediation ?? null,
  }
}
