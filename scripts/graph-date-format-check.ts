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

assert.equal(formatGraphCommitDate(sample, 'iso', 'fr'), '2026-03-28')
assert.equal(formatGraphCommitDate(sample, 'isoTime', 'fr'), '2026-03-28 23:59')
assert.equal(formatGraphCommitDate(sample, 'date', 'fr'), '28 mars 2026')
assert.equal(formatGraphCommitDate(sample, 'dateTime', 'fr'), '28 mars 2026 23:59')
assert.equal(formatGraphCommitDate(sample, 'numeric', 'fr'), '28/03/2026')
assert.equal(formatGraphCommitDate(sample, 'numericTime', 'fr'), '28/03/2026 23:59')
assert.equal(graphDateExample('isoTime', 'fr'), '2026-03-28 23:59')
assert.match(formatGraphCommitDate(recent, 'relative', 'fr'), /heure/)
assert.equal(formatGraphCommitDate(recent, 'isoTime', 'fr').includes('heure'), false)
assert.match(formatGraphCommitDate(old, 'relative', 'fr'), /\d{4}/)
assert.equal(formatGraphCommitDate(old, 'relative', 'fr').includes('il y a'), false)
assert.equal(parseGraphDateFormat(null), 'relative')
assert.equal(parseGraphDateFormat('iso'), 'iso')
assert.equal(parseGraphDateFormat('custom'), 'relative')

assert.equal(formatGraphCommitDate(sample, 'date', 'en'), 'Mar 28, 2026')
assert.match(formatGraphCommitDate(sample, 'dateTime', 'en'), /Mar 28, 2026/)
assert.match(formatGraphCommitDate(sample, 'dateTime', 'en'), /11:59/)
assert.match(formatGraphCommitDate(recent, 'relative', 'en'), /hour/)
assert.equal(formatGraphCommitDate(sample, 'iso', 'en'), '2026-03-28')

console.log('Graph date formats: relative window, absolute presets and locale passed.')
