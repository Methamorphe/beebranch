/**
 * Commit message subject helpers.
 *
 * Git treats the first line of the message as the subject; the convention caps
 * it at 72 characters so `git log --oneline` and forge lists stay readable.
 */

export const SUBJECT_LIMIT = 72

/** Length of the subject: everything before the first newline. */
export function subjectLength(message: string): number {
  const newline = message.indexOf('\n')
  return newline === -1 ? message.length : newline
}

/** Characters left before {@link SUBJECT_LIMIT}; negative once it is exceeded. */
export function subjectRemaining(message: string): number {
  return SUBJECT_LIMIT - subjectLength(message)
}
