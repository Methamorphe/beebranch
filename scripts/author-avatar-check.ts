/**
 * Headless checks for `src/lib/authorAvatar.ts` (no frontend test runner in repo).
 * Run: node --experimental-strip-types scripts/author-avatar-check.ts
 */
import assert from 'node:assert/strict'
import {
  AUTHOR_AVATAR_PALETTE_DARK,
  AUTHOR_AVATAR_PALETTE_LIGHT,
  authorAvatarContrastRatio,
  authorAvatarFill,
  authorAvatarLabelColor,
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
assert.strictEqual(hashAuthorEmail('foo@bar.com'), hashAuthorEmail('foo@bar.com'))

const sampleEmails = [
  'alice@example.com',
  'bob@example.com',
  'chloe@example.com',
  'dan@example.com',
]
const darkFills = new Set(sampleEmails.map((email) => authorAvatarFill(email, false)))
assert.ok(
  darkFills.size >= 3,
  `expected distinct avatar fills, got ${darkFills.size}: ${[...darkFills].join(', ')}`,
)

for (const light of [false, true]) {
  const palette = light ? AUTHOR_AVATAR_PALETTE_LIGHT : AUTHOR_AVATAR_PALETTE_DARK
  const seen = new Set<string>()
  for (let index = 0; index < 128; index += 1) {
    const fill = authorAvatarFill(`user${index}@example.com`, light)
    if (seen.has(fill)) continue
    seen.add(fill)
    const label = authorAvatarLabelColor(fill)
    assert.ok(
      authorAvatarContrastRatio(fill, label) >= 4.5,
      `contrast too low for ${fill} / ${label} (light=${light})`,
    )
  }
  assert.ok(seen.size >= palette.length)
}

console.log('author-avatar-check: ok')
