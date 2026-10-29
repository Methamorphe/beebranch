import { invoke } from '@tauri-apps/api/core'
import { errorCopy } from '../i18n/errors'
import { t } from '../i18n'
import type { AppError } from '../types/git'

const FALLBACK: Omit<AppError, 'message' | 'detail'> = {
  code: 'ipc.unavailable',
  category: 'internal',
  retryable: false,
}

export class IpcError extends Error {
  readonly app: AppError

  constructor(app: AppError) {
    super(app.message)
    this.name = 'IpcError'
    this.app = app
  }
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string'
  )
}

export function normalizeError(cause: unknown): AppError {
  if (isAppError(cause)) {
    return cause
  }
  if (typeof cause === 'string') {
    try {
      const parsed: unknown = JSON.parse(cause)
      if (isAppError(parsed)) {
        return parsed
      }
    } catch {
      return {
        ...FALLBACK,
        message: cause,
      }
    }
    return {
      ...FALLBACK,
      message: cause,
    }
  }
  if (cause instanceof Error) {
    return {
      ...FALLBACK,
      message: cause.message,
      detail: cause.stack,
    }
  }
  return {
    ...FALLBACK,
    message: t('common.unknownError'),
    detail: String(cause),
  }
}

export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    throw new IpcError(normalizeError(cause))
  }
}

export function errorMessage(cause: unknown): string {
  const error = cause instanceof IpcError ? cause.app : normalizeError(cause)
  const { message, remediation } = errorCopy(error)
  return remediation ? `${message} ${remediation}` : message
}

export function errorDetail(cause: unknown): string | null {
  const error = cause instanceof IpcError ? cause.app : normalizeError(cause)
  return error.detail ?? null
}
