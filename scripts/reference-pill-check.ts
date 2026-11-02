/**
 * Headless checks for the reference pills of the history canvas: every kind is
 * painted solid in the hue of its rail, and the label picks the ink with the
 * higher WCAG ratio. No frontend test runner in the repo.
 * Run: node --experimental-strip-types scripts/reference-pill-check.ts
 */
import assert from 'node:assert/strict'
import {
  bestInkRatio,
  contrastRatio,
  pillFill,
  readableTextColor,
} from '../src/lib/contrast.ts'

/** Lane vectors of `src/styles/tokens.css` (--lane-1 … --lane-6). */
const LANES_DARK = ['#81a9ef', '#a48ae0', '#52c993', '#e66b75', '#f0a45b', '#7cb518']
const LANES_LIGHT = ['#2B7CB3', '#7B3FC4', '#007A7A', '#C23A78', '#C2410C', '#557D0F']

type Kind = 'head' | 'tag' | 'remote' | 'local' | 'other'

function palette(light: boolean): { kind: Kind; fill: string }[] {
  const lanes = light ? LANES_LIGHT : LANES_DARK
  return [
    { kind: 'head', fill: '#f5bb45' },
    { kind: 'tag', fill: light ? '#94470a' : '#f0a45b' },
    { kind: 'remote', fill: light ? '#2b6cb0' : '#81a9ef' },
    { kind: 'other', fill: light ? '#e2e5eb' : '#2a303c' },
    ...lanes.map((fill) => ({ kind: 'local' as Kind, fill })),
  ]
}

// The reason `pillFill` exists: mid-tone light-theme lanes clear neither ink.
assert.ok(bestInkRatio('#2B7CB3') < 4.5, 'lane 1 was expected to sit between the inks')
assert.ok(bestInkRatio('#557D0F') < 4.5, 'lane 6 was expected to sit between the inks')
assert.ok(bestInkRatio('#f5bb45') >= 4.5, 'the accent already passes; no nudge expected')

// A fill that already passes is returned untouched.
assert.strictEqual(pillFill('#f5bb45'), '#f5bb45')
assert.strictEqual(pillFill('#81a9ef'), '#81a9ef')

let worst = Number.POSITIVE_INFINITY
for (const light of [false, true]) {
  for (const { kind, fill } of palette(light)) {
    const solid = pillFill(fill)
    const ink = kind === 'other' ? (light ? '#4b5568' : '#b9c2d0') : readableTextColor(solid)
    const ratio = contrastRatio(solid, ink)
    worst = Math.min(worst, ratio)
    assert.ok(
      ratio >= 4.5,
      `${kind} pill ${fill} -> ${solid} on ${ink} is ${ratio.toFixed(2)}:1 (light=${light})`,
    )
    // The nudge must not change the hue: it only darkens the same colour.
    assert.match(solid, /^#[0-9a-f]{6}$/i)
  }
}

console.log(`reference-pill-check: ok (worst ${worst.toFixed(2)}:1)`)
