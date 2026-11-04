/**
 * Headless checks for the conflict resolver's pure logic: undecided regions
 * keep their markers, presets assemble the right lines, and sides are named
 * from the marker labels. No frontend test runner in the repo.
 * Run: node --experimental-strip-types scripts/conflict-resolution-check.ts
 */
import assert from 'node:assert/strict'
import {
  assembleRegions,
  choiceKind,
  countMarkers,
  presetChoice,
  sideNames,
} from '../src/components/conflictResolution.ts'
import type { ConflictRegion, ConflictView } from '../src/types/git.ts'

const working = [
  'name: app',
  '<<<<<<< Updated upstream',
  'version: 1.13',
  '=======',
  'version: 1.28',
  '>>>>>>> Stashed changes',
  'sdk: 3',
  '<<<<<<< Updated upstream',
  'a',
  '=======',
  'b',
  '>>>>>>> Stashed changes',
  '',
].join('\n')

const regions: ConflictRegion[] = [
  { index: 0, start: 2, end: 6, ours: ['version: 1.13'], base: [], theirs: ['version: 1.28'],
    oursLabel: 'Updated upstream', theirsLabel: 'Stashed changes' },
  { index: 1, start: 8, end: 12, ours: ['a'], base: [], theirs: ['b'],
    oursLabel: 'Updated upstream', theirsLabel: 'Stashed changes' },
]

// Nothing decided: the result is the working file, markers included.
assert.equal(assembleRegions(working, regions, {}), working)
assert.equal(countMarkers(working), 6)

// One decided, one pending: only the pending block keeps markers.
const partial = assembleRegions(working, regions, { 0: presetChoice(regions[0], 'theirs') })
assert.ok(partial.startsWith('name: app\nversion: 1.28\nsdk: 3\n<<<<<<< '))
assert.equal(countMarkers(partial), 3)

// Both decided: marker-free, trailing newline preserved.
const full = assembleRegions(working, regions, {
  0: presetChoice(regions[0], 'ours'),
  1: presetChoice(regions[1], 'both'),
})
assert.equal(full, 'name: app\nversion: 1.13\nsdk: 3\na\nb\n')
assert.equal(countMarkers(full), 0)

// Choice kinds round-trip, and partial line picks read as custom.
for (const kind of ['ours', 'theirs', 'both'] as const) {
  assert.equal(choiceKind(presetChoice(regions[0], kind)), kind)
}
assert.equal(choiceKind({ ours: [false], theirs: [false], base: false }), 'custom')
const diff3: ConflictRegion = { ...regions[0], base: ['version: 1.27'] }
assert.equal(choiceKind(presetChoice(diff3, 'base')), 'base')
assert.ok(assembleRegions(working, [diff3], { 0: presetChoice(diff3, 'base') }).includes('version: 1.27'))

// Side names.
const view = (oursLabel: string, theirsLabel: string): ConflictView => ({
  path: 'pubspec.yaml', binary: false, tooLarge: false, eol: 'lf', hasMarkers: true,
  markerLines: [], resolved: false,
  regions: [{ ...regions[0], oursLabel, theirsLabel }],
})
const master = { kind: 'branch' as const, name: 'master' }
assert.deepEqual(sideNames(view('Updated upstream', 'Stashed changes'), master, undefined),
  { source: 'stash', ours: 'master' })
assert.deepEqual(sideNames(view('HEAD', 'feature'), master, { kind: 'merge' }),
  { source: 'merge', ours: 'master', theirs: 'feature' })
assert.deepEqual(sideNames(view('HEAD', 'abc1234 (fix)'), master, { kind: 'rebase', variant: 'merge' }),
  { source: 'rebase', theirs: 'abc1234 (fix)' })
assert.deepEqual(sideNames(view('HEAD', 'abc1234 (fix)'), master, { kind: 'sequencer', sequencer: 'cherryPick' }),
  { source: 'cherryPick', ours: 'master', theirs: 'abc1234 (fix)' })
assert.deepEqual(sideNames(null, { kind: 'detached', sha: 'abc' }, undefined), { source: 'unknown', ours: undefined, theirs: undefined })

console.log('conflict-resolution-check: ok')
