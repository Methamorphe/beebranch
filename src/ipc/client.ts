import { invoke } from '@tauri-apps/api/core'
import { errorCopy } from '../i18n/errors'
import { t } from '../i18n'
import { recordActivity } from '../lib/activity'
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
  const started = performance.now()
  try {
    const result = await invoke<T>(command, args)
    record(command, args, started, 'ok')
    return result
  } catch (cause) {
    const error = normalizeError(cause)
    record(command, args, started, 'failed', error.code)
    throw new IpcError(error)
  }
}

/**
 * Append one activity entry.
 *
 * Only the command name, its repository and the stable error code are kept:
 * arguments may contain tokens or file contents and are never logged.
 */
function record(
  command: string,
  args: Record<string, unknown> | undefined,
  started: number,
  outcome: 'ok' | 'failed',
  code?: string,
) {
  const repoId = repositoryOf(args)
  recordActivity({
    command,
    repoId,
    durationMs: Math.round(performance.now() - started),
    outcome,
    code,
  })
}

/** Extract the repository id from the shapes the commands accept. */
function repositoryOf(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) {
    return undefined
  }
  if (typeof args.repoId === 'string') {
    return args.repoId
  }
  const request = args.request
  if (request && typeof request === 'object' && 'repoId' in request) {
    const value = request.repoId
    return typeof value === 'string' ? value : undefined
  }
  const input = args.input
  if (input && typeof input === 'object' && 'repoId' in input) {
    const value = input.repoId
    return typeof value === 'string' ? value : undefined
  }
  return undefined
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

/**
 * Stable error code of any failure `call` produced or rejected with.
 *
 * `call` throws an `IpcError`: unwrapping it here keeps callers from
 * re-implementing that distinction and reading `ipc.unavailable` instead.
 */
export function errorCode(cause: unknown): string {
  const error = cause instanceof IpcError ? cause.app : normalizeError(cause)
  return error.code
}
