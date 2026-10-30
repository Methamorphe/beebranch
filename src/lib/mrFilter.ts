/**
 * Review-list filter grammar.
 *
 * Tokens follow the syntax the desktop client documents: `author:`, `label:`,
 * `reviewer:` and `state:`, each accepting a leading `-` to exclude. Anything
 * else is free text matched against the request. A token whose field is not
 * known is reported instead of being silently ignored: callers refuse to filter
 * while `unknown` is non-empty, so the list never pretends a typo was applied.
 */

import type { ForgeMergeRequest } from './forge'

export type ReviewFilterField = 'text' | 'author' | 'label' | 'reviewer' | 'state'

export type ReviewFilterToken = {
  field: ReviewFilterField
  value: string
  negated: boolean
}

export type ReviewFilter = {
  tokens: ReviewFilterToken[]
  /** Raw tokens that could not be parsed; the list stays unfiltered. */
  unknown: string[]
}

const FIELDS = new Set<ReviewFilterField>(['author', 'label', 'reviewer', 'state'])
const STATES = new Set(['open', 'closed', 'merged', 'draft'])

/** Parse the filter input into tokens plus the raw tokens it cannot honour. */
export function parseReviewFilter(input: string): ReviewFilter {
  const tokens: ReviewFilterToken[] = []
  const unknown: string[] = []
  for (const raw of input.split(/\s+/).filter(Boolean)) {
    const negated = raw.length > 1 && raw.startsWith('-')
    const body = negated ? raw.slice(1) : raw
    const separator = body.indexOf(':')
    if (separator < 0) {
      tokens.push({ field: 'text', value: body.toLowerCase(), negated })
      continue
    }
    const field = body.slice(0, separator).toLowerCase()
    const value = body.slice(separator + 1).toLowerCase()
    if (!FIELDS.has(field as ReviewFilterField) || value.length === 0) {
      unknown.push(raw)
      continue
    }
    if (field === 'state' && !STATES.has(value)) {
      unknown.push(raw)
      continue
    }
    tokens.push({ field: field as ReviewFilterField, value, negated })
  }
  return { tokens, unknown }
}

function userMatches(user: { username: string; name: string }, value: string): boolean {
  const username = user.username.toLowerCase()
  const name = user.name.toLowerCase()
  return username.includes(value) || name.includes(value)
}

function stateMatches(mr: ForgeMergeRequest, value: string): boolean {
  const open = mr.state === 'opened' || mr.state === 'open'
  switch (value) {
    case 'open':
      return open && !mr.draft
    case 'draft':
      return mr.draft
    case 'closed':
      return mr.state === 'closed'
    case 'merged':
      return mr.state === 'merged'
    default:
      return false
  }
}

function tokenMatches(mr: ForgeMergeRequest, token: ReviewFilterToken): boolean {
  switch (token.field) {
    case 'text': {
      const haystack = [
        mr.title,
        mr.sourceBranch,
        mr.targetBranch,
        mr.author.username,
        mr.author.name,
        String(mr.iid),
        ...mr.labels,
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(token.value)
    }
    case 'author':
      return userMatches(mr.author, token.value)
    case 'label':
      return mr.labels.some((label) => label.toLowerCase() === token.value)
    case 'reviewer':
      return mr.reviewers.some((user) => userMatches(user, token.value))
    case 'state':
      return stateMatches(mr, token.value)
  }
}

/** Every token must pass; a negated token must not match. */
export function matchesReviewFilter(
  mr: ForgeMergeRequest,
  filter: ReviewFilter,
): boolean {
  if (filter.unknown.length > 0) {
    return true
  }
  return filter.tokens.every(
    (token) => tokenMatches(mr, token) !== token.negated,
  )
}

/**
 * Completion values for the filter input, derived from the loaded requests so
 * the list only proposes authors and labels that exist.
 */
export function reviewFilterSuggestions(items: ForgeMergeRequest[]): string[] {
  const authors = new Set<string>()
  const reviewers = new Set<string>()
  const labels = new Set<string>()
  for (const mr of items) {
    authors.add(mr.author.username)
    for (const reviewer of mr.reviewers) {
      reviewers.add(reviewer.username)
    }
    for (const label of mr.labels) {
      labels.add(label)
    }
  }
  const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b))
  return [
    ...sorted(authors).map((name) => `author:${name}`),
    ...sorted(reviewers).map((name) => `reviewer:${name}`),
    ...sorted(labels).map((label) => `label:${label}`),
    'state:open',
    'state:draft',
    'state:closed',
    'state:merged',
  ]
}
