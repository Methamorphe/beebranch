/**
 * Headless checks for `src/lib/upstreamChoices.ts` (no frontend test runner in repo).
 * Run: node --experimental-strip-types scripts/upstream-choices-check.ts
 */
import assert from 'node:assert/strict'
import {
  isCurrentUpstream,
  remoteTrackingBranchName,
  upstreamChoices,
} from '../src/lib/upstreamChoices.ts'
import type { RefEntry } from '../src/types/git.ts'

const ref = (
  kind: RefEntry['kind'],
  name: string,
  extra: Partial<RefEntry> = {},
): RefEntry => ({
  fullName:
    kind === 'branch'
      ? `refs/heads/${name}`
      : kind === 'remoteBranch'
        ? `refs/remotes/${name}`
        : `refs/tags/${name}`,
  name,
  kind,
  targetOid: 'abc',
  objectType: 'commit',
  isHead: false,
  remote: kind === 'remoteBranch' ? name.split('/')[0] : undefined,
  ...extra,
})

const entries: RefEntry[] = [
  ref('branch', 'main', { isHead: true, upstream: 'refs/remotes/origin/main' }),
  ref('branch', 'feature/foo'),
  ref('remoteBranch', 'origin/HEAD', { symref: 'refs/remotes/origin/main' }),
  ref('remoteBranch', 'origin/main'),
  ref('remoteBranch', 'origin/not-main'),
  ref('remoteBranch', 'origin/feature/foo'),
  ref('remoteBranch', 'origin/feature'),
  ref('remoteBranch', 'github/main'),
  ref('remoteBranch', 'github/feature/foo'),
  ref('tag', 'v1.0'),
]

assert.equal(remoteTrackingBranchName(entries[3]!), 'main')
assert.equal(remoteTrackingBranchName(entries[5]!), 'feature/foo')
assert.equal(remoteTrackingBranchName(entries[0]!), undefined)

const main = upstreamChoices(entries, 'main').map((entry) => entry.name)
assert.deepEqual(main, ['github/main', 'origin/main'])

const feature = upstreamChoices(entries, 'feature/foo').map((entry) => entry.name)
assert.deepEqual(feature, ['github/feature/foo', 'origin/feature/foo'])

assert.deepEqual(upstreamChoices(entries, 'missing').map((entry) => entry.name), [])
assert.equal(
  upstreamChoices(entries, 'main').some((entry) => entry.name === 'origin/HEAD'),
  false,
)

assert.equal(isCurrentUpstream('refs/remotes/origin/main', entries[3]!), true)
assert.equal(isCurrentUpstream('origin/main', entries[3]!), true)
assert.equal(isCurrentUpstream('refs/remotes/github/main', entries[3]!), false)
assert.equal(isCurrentUpstream(undefined, entries[3]!), false)

console.log('upstream-choices-check: ok')
