/**
 * Headless checks for `src/lib/authorAvatar.ts` (no frontend test runner in repo).
 * Run: node --experimental-strip-types scripts/author-avatar-check.ts
 */
import assert from 'node:assert/strict'
import {
  authorAvatarFill,
  authorInitials,
  hashAuthorEmail,
  normalizeAuthorEmail,
} from '../src/lib/authorAvatar.ts'

assert.strictEqual(normalizeAuthorEmail('  Foo@Bar.COM '), 'foo@bar.com')
assert.strictEqual(authorInitials('Ada Lovelace', 'ada@test'), 'AL')
assert.strictEqual(authorInitials('Cher', 'cher@test'), 'CH')
assert.strictEqual(authorInitials('', 'bob.smith@corp.dev'), 'BO')
assert.strictEqual(authorInitials('Jean-Pierre Martin', 'jp@test'), 'JM')

const stable = authorAvatarFill('same@example.com', false)
assert.strictEqual(authorAvatarFill('same@example.com', false), stable)
assert.notStrictEqual(
  authorAvatarFill('a@x.com', false),
  authorAvatarFill('b@y.com', false),
)
assert.strictEqual(hashAuthorEmail('foo@bar.com'), hashAuthorEmail('foo@bar.com'))

console.log('author-avatar-check: ok')
