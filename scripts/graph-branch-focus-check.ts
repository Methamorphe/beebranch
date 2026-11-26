// Run: node --experimental-strip-types scripts/graph-branch-focus-check.ts
import assert from 'node:assert/strict'
import { graphBranchFocus, graphClosestBranches } from '../src/lib/graphBranchFocus.ts'
import type { CommitSummary, GraphRow } from '../src/types/git.ts'

const commit = (sha: string, parents: string[]): CommitSummary => ({ sha, parents, refs: [], subject: sha, author: { name: '', email: '', timestamp: 0 }, committer: { name: '', email: '', timestamp: 0 } })
const row = (nodeLane: number, rails: [number, boolean, boolean][], arrivals: number[] = [], departures: number[] = []): GraphRow => ({ nodeLane, laneCount: 3, rails: rails.map(([lane, fromTop, toBottom]) => ({ lane, fromTop, toBottom })), arrivals, departures, overflow: false })

// main -> base; topic -> merge -> (left, right) -> base; later reuses lane 0.
const commits = [commit('main', ['base']), commit('topic', ['merge']), commit('merge', ['left', 'right']), commit('left', ['base']), commit('right', ['base']), commit('base', []), commit('other', ['unloaded'])]
const rows = [
  row(0, [[0, false, true]]),
  row(1, [[0, true, true], [1, false, true]]),
  row(1, [[0, true, true], [1, true, true], [2, false, true]], [], [2]),
  row(1, [[0, true, true], [1, true, true], [2, true, true]]),
  row(2, [[0, true, true], [1, true, true], [2, true, true]]),
  row(0, [[0, true, false], [1, true, false], [2, true, false]], [1, 2]),
  row(0, [[0, false, true]]),
]
const focus = graphBranchFocus(commits, rows, 'topic')
assert.deepEqual([...focus.ancestors].sort(), ['base', 'left', 'merge', 'right', 'topic'])
assert.deepEqual([...focus.lanes[1]!.top], [])
assert.deepEqual([...focus.lanes[1]!.bottom], [1])
assert.deepEqual([...focus.lanes[2]!.bottom], [1, 2])
assert.equal(focus.lanes[5]!.top.has(0), false, 'unrelated child stays dim above shared base')
assert.equal(focus.lanes[5]!.top.has(1), true)
assert.equal(focus.lanes[5]!.top.has(2), true)
assert.equal(focus.lanes[6]!.bottom.has(0), false, 'reused lane does not inherit focus')
assert.deepEqual([...graphBranchFocus(commits, rows, 'main').ancestors].sort(), ['base', 'main'])
assert.deepEqual([...graphBranchFocus(commits, rows, 'other').ancestors].sort(), ['other', 'unloaded'], 'pagination boundary is supported')
// A merge can attach to an already active rail owned by another branch.
const shared = graphBranchFocus([commit('other', ['base']), commit('merge', ['left', 'base']), commit('left', ['base']), commit('base', [])], [
  row(0, [[0, false, true]]), row(1, [[0, true, true], [1, false, true]], [], [0]), row(1, [[0, true, true], [1, true, true]]), row(0, [[0, true, false], [1, true, false]], [1]),
], 'merge')
assert.equal(shared.lanes[1]!.top.has(0), false)
assert.equal(shared.lanes[1]!.bottom.has(0), true)

const closest = graphClosestBranches(
  commits,
  [
    ['main', [{ label: 'main' }]],
    ['topic', [{ label: 'topic' }]],
  ],
  (ref) => ref.label,
)
assert.equal(closest.get('topic')?.refs[0]?.label, 'topic')
assert.equal(closest.get('merge')?.refs[0]?.label, 'topic')
assert.equal(closest.get('left')?.refs[0]?.label, 'topic')
assert.equal(closest.get('right')?.refs[0]?.label, 'topic', 'second parent of the merge stays on topic')
assert.equal(closest.get('main')?.refs[0]?.label, 'main')
assert.equal(closest.get('base')?.refs[0]?.label, 'main', 'shared ancestor prefers the closer tip')
assert.equal(closest.has('other'), false, 'unrelated history has no covering branch')
assert.deepEqual(
  graphClosestBranches(
    commits,
    [['main', [{ label: 'main' }, { label: 'origin/main' }]]],
    (ref) => ref.label,
  ).get('main')?.refs.map((ref) => ref.label),
  ['main', 'origin/main'],
)
console.log('Branch focus: ancestry, merges, shared rails, lane reuse, pagination and closest branch passed.')
