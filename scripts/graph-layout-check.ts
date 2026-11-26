// Run: node --experimental-strip-types scripts/graph-layout-check.ts
import assert from 'node:assert/strict'
import {
  MIN_MESSAGE_WIDTH,
  boundColumnWidths,
  clampColumnWidths,
  graphContentWidth,
} from '../src/lib/layout.ts'

const comfortable = boundColumnWidths({ refs: 140, graph: 64, author: 130, date: 150 })
assert.equal(comfortable.refs, 140)
assert.equal(comfortable.author, 130)
assert.equal(comfortable.date, 150)

const minInner = graphContentWidth(comfortable)
assert.equal(minInner, 140 + 64 + 130 + 150 + MIN_MESSAGE_WIDTH)
assert.ok(minInner > 400, 'a phone-sized graph pane still overflows and must scroll')
assert.ok(minInner < 900, 'a desktop history pane keeps every column without scrolling')

const narrowViewport = 400
const contentWidth = Math.max(narrowViewport, graphContentWidth(comfortable))
const scrolling = clampColumnWidths(contentWidth, comfortable)
assert.deepEqual(scrolling, comfortable, 'a narrow viewport keeps every column and scrolls')
assert.ok(contentWidth > narrowViewport)

const wide = clampColumnWidths(1600, comfortable)
assert.deepEqual(wide, comfortable)

const hiddenAuthor = boundColumnWidths({ ...comfortable, author: 0 })
assert.equal(hiddenAuthor.author, 0)
assert.equal(graphContentWidth(hiddenAuthor, MIN_MESSAGE_WIDTH), 140 + 64 + 0 + 150 + MIN_MESSAGE_WIDTH)

console.log('Graph layout: bound columns, content width and overflow-without-dropping passed.')
