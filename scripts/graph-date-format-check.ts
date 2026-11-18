// Run: node --experimental-strip-types scripts/graph-date-format-check.ts
import assert from 'node:assert/strict'
import {
  formatGraphCommitDate,
  graphDateExample,
  parseGraphDateFormat,
} from '../src/lib/graphDate.ts'

const sample = Math.floor(new Date(2026, 2, 28, 23, 59).getTime() / 1000)
const recent = Math.floor(Date.now() / 1000) - 3700
const old = Math.floor(Date.now() / 1000) - 10 * 24 * 3600
const now = new Date()

assert.equal(formatGraphCommitDate(sample, 'iso', 'en', now, 'fr-FR'), '2026-03-28')
assert.equal(formatGraphCommitDate(sample, 'isoTime', 'en', now, 'fr-FR'), '2026-03-28 23:59')
assert.equal(formatGraphCommitDate(sample, 'date', 'en', now, 'fr-FR'), '28 mars 2026')
assert.equal(formatGraphCommitDate(sample, 'date', 'fr', now, 'fr-FR'), '28 mars 2026')
assert.equal(formatGraphCommitDate(sample, 'dateTime', 'en', now, 'fr-FR'), '28 mars 2026 23:59')
assert.equal(formatGraphCommitDate(sample, 'numeric', 'en', now, 'fr-FR'), '28/03/2026')
assert.equal(formatGraphCommitDate(sample, 'numericTime', 'en', now, 'fr-FR'), '28/03/2026 23:59')
assert.equal(graphDateExample('isoTime', 'en'), '2026-03-28 23:59')
assert.match(formatGraphCommitDate(recent, 'relative', 'fr', now, 'en-US'), /heure/)
assert.equal(formatGraphCommitDate(recent, 'isoTime', 'fr', now, 'fr-FR').includes('heure'), false)
assert.match(formatGraphCommitDate(old, 'relative', 'fr', now, 'fr-FR'), /\d{4}/)
assert.equal(formatGraphCommitDate(old, 'relative', 'fr', now, 'fr-FR').includes('il y a'), false)
assert.equal(
  formatGraphCommitDate(old, 'relative', 'en', now, 'fr-FR'),
  formatGraphCommitDate(old, 'relative', 'fr', now, 'fr-FR'),
)
assert.equal(parseGraphDateFormat(null), 'relative')
assert.equal(parseGraphDateFormat('iso'), 'iso')
assert.equal(parseGraphDateFormat('custom'), 'relative')

assert.equal(formatGraphCommitDate(sample, 'date', 'fr', now, 'en-US'), 'Mar 28, 2026')
assert.equal(formatGraphCommitDate(sample, 'date', 'en', now, 'en-US'), 'Mar 28, 2026')
assert.match(formatGraphCommitDate(sample, 'dateTime', 'fr', now, 'en-US'), /Mar 28, 2026/)
assert.match(formatGraphCommitDate(sample, 'dateTime', 'fr', now, 'en-US'), /11:59/)
assert.match(formatGraphCommitDate(recent, 'relative', 'en', now, 'fr-FR'), /hour/)
assert.equal(formatGraphCommitDate(sample, 'iso', 'fr', now, 'en-US'), '2026-03-28')

console.log('Graph date formats: relative window, absolute presets and locale passed.')
