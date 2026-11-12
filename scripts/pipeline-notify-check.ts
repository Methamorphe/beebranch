/**
 * Headless checks for pipeline failure detection.
 * Run: node --experimental-strip-types scripts/pipeline-notify-check.ts
 */
import assert from 'node:assert/strict'
import { collectPipelineFailures } from '../src/lib/pipelineNotify.ts'

const seen = new Map<string, string>()
assert.deepEqual(
  collectPipelineFailures('repo', 'Bee', [{ id: 1, status: 'failed', refName: 'main' }], seen),
  [],
)
assert.deepEqual(
  collectPipelineFailures('repo', 'Bee', [{ id: 1, status: 'failed', refName: 'main' }], seen),
  [],
)
assert.deepEqual(
  collectPipelineFailures('repo', 'Bee', [{ id: 1, status: 'running', refName: 'main' }], seen),
  [],
)
assert.deepEqual(
  collectPipelineFailures('repo', 'Bee', [{ id: 1, status: 'failed', refName: 'main' }], seen),
  [{ repoName: 'Bee', ref: 'main', id: 1 }],
)
assert.deepEqual(
  collectPipelineFailures('repo', 'Bee', [{ id: 2, status: 'failed' }], seen),
  [{ repoName: 'Bee', ref: '', id: 2 }],
)
assert.deepEqual(
  collectPipelineFailures('other', 'Other', [{ id: 9, status: 'success' }], seen),
  [],
)

console.log('pipeline notify checks passed')
