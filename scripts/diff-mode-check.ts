// Run: node --experimental-strip-types scripts/diff-mode-check.ts
import assert from 'node:assert/strict'
import {
  DEFAULT_DIFF_MODE,
  applyStoredDiffMode,
  diffModeEpoch,
  getDiffMode,
  isDiffMode,
  parseDiffMode,
  rememberDiffMode,
} from '../src/lib/diffMode.ts'

assert.equal(parseDiffMode(null), DEFAULT_DIFF_MODE)
assert.equal(parseDiffMode(undefined), 'inline')
assert.equal(parseDiffMode('custom'), 'inline')
assert.equal(parseDiffMode('inline'), 'inline')
assert.equal(parseDiffMode('split'), 'split')
assert.equal(parseDiffMode('hunk'), 'hunk')
assert.equal(isDiffMode('split'), true)
assert.equal(isDiffMode('side-by-side'), false)

assert.equal(getDiffMode(), 'inline')
rememberDiffMode('split')
assert.equal(getDiffMode(), 'split')
const epoch = diffModeEpoch()
assert.equal(applyStoredDiffMode(null, epoch), true)
assert.equal(getDiffMode(), 'split')
assert.equal(applyStoredDiffMode('inline', epoch), true)
assert.equal(getDiffMode(), 'inline')
rememberDiffMode('hunk')
assert.equal(applyStoredDiffMode('split', epoch), false)
assert.equal(getDiffMode(), 'hunk')

console.log('Diff mode: parse, cache and late preference reads.')
