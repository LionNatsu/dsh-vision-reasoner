/**
 * The pure half: the camera, the record, the grid and the text. No I/O, no harness.
 *
 * The invariants here are the ones the redesign exists for: one shape for every view, a window
 * that may reach past the picture but never loses it, a sweep counted from where the camera
 * stopped, and a batch of marks coming back as a square rather than the strip that made a whole
 * session misread its own coordinates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RADIUS, frameRegion, gridLines, gridStep, placeAt, radiusFor, regionOf, regionText
} from '../lib/views.js'
import {
  CAMERA_TOOLS, MARK_TOOLS, TRACKED_TOOLS, applyToolArgs, commitCall, emptyRecord, markRect
} from '../lib/record.js'
import { MIN_SIDE, fitOp, moveOp, opsFor, resolveCamera, sweepGrid, sweepState } from '../lib/camera.js'
import { coordGridOverlay } from '../lib/draw.js'
import { describe as describeResult, recordLines, sweepLine } from '../lib/core.js'

const W = 2600
const H = 1831
const frame = () => frameRegion(W, H)
const window_ = (camera, width = W, height = H) => resolveCamera(camera, width, height)

test('the grid steps in round numbers of the picture\'s own pixels', () => {
  const view = { width: 1400, height: 986, sx: 1400 / W, sy: 986 / H }
  const step = gridStep(frame(), view)
  assert.equal(step, 200, 'a step a caller can read, not a scale to convert')
  const lines = gridLines(frame(), view)
  assert.ok(lines.across.length > 3 && lines.down.length > 2)
  assert.ok(lines.across.includes(200) && lines.across.includes(600), 'lines at round hundreds')
  assert.equal(lines.across[1] - lines.across[0], step, 'every line a step from the last')
})

test('the grid is always drawn, and its two axes are told apart by colour', () => {
  const view = { width: 1400, height: 1400, sx: 1400 / W, sy: 1400 / H, x0: 0, y0: 0 }
  const svg = coordGridOverlay(view, frame())
  assert.match(svg, /#22d3ee/, 'the columns that run down')
  assert.match(svg, /#f5b942/, 'the rows that run across')
  assert.ok(svg.split('<line').length - 1 > 10)
})

test('a place is read in the picture\'s own pixels, and refused outside them', () => {
  assert.deepEqual(placeAt([120, 240], W, H), [120, 240])
  assert.throws(() => placeAt([120], W, H), /must be \[x, y\]/)
  assert.throws(() => placeAt([W + 1, 10], W, H), /is outside the picture/)
  assert.equal(regionText(regionOf([10, 20, 30, 40], W, H)), '10,20,30,40')
})

test('a ring is a radius in pixels, and one way to say it', () => {
  assert.equal(DEFAULT_RADIUS, 30)
  assert.equal(radiusFor(undefined), 30)
  assert.equal(radiusFor(47), 47)
  assert.equal(radiusFor(3.4), 4)
  assert.throws(() => radiusFor('wide'), /r must be a number of picture pixels/)
})

test('the whole picture is one square window, the picture centred and the rest black', () => {
  const window = window_([{ op: 'reset' }])
  assert.equal(window.side, W, 'the longest side sets the square')
  assert.equal(window.cx, Math.round(W / 2))
  assert.equal(window.cy, Math.round(H / 2))
  assert.equal(window.x1 - window.x0, window.y1 - window.y0, 'square, always')
  assert.ok(window.y0 < 0 && window.y1 > H, 'the square reaches past the short side')
})

test('the sweep grid is aligned to the picture\'s centre, so the widest window is its first cell', () => {
  const grid = sweepGrid(W, H, W)
  assert.deepEqual({ across: grid.across, down: grid.down }, { across: 1, down: 1 })
  const whole = window_([{ op: 'reset' }])
  const after = window_([{ op: 'reset' }, { op: 'seen' }, { op: 'move', by: 'next' }])
  assert.deepEqual(after, whole, '"next" over a single window leaves the camera where it was')
  const grid4 = sweepGrid(W, H, W / 4)
  assert.deepEqual({ across: grid4.across, down: grid4.down }, { across: 4, down: 3 })
  assert.equal(grid4.originX, W / 2 - 2 * grid4.side)
})

test('the camera walks the sweep in reading order, and wraps', () => {
  const size = W / 4
  const base = [{ op: 'reset' }, { op: 'zoom', by: 4 }]
  const start = window_(base)
  const steps = (count, word = 'next') => window_([...base, ...Array.from({ length: count }, () => ({ op: 'move', by: word }))])
  const one = steps(1)
  assert.ok(one.cx > start.cx, 'the first step walks to the right of where the camera was')
  assert.equal(one.cy, start.cy, 'and stays on the row')
  const wrapped = steps(2)
  assert.ok(wrapped.cx < one.cx, 'at the right edge the next step wraps to the column')
  assert.equal(wrapped.cy, one.cy + size, 'and drops to the row below')
  const cycle = steps(12)
  assert.deepEqual(steps(13), one, 'a lap of twelve windows lands back on the cell it left')
  assert.notDeepEqual(cycle, start, 'and it lands on that cell\'s centre, not the picture\'s')
  assert.deepEqual(steps(1, 'previous'), steps(11), '"previous" is one window back')
})

test('a direction steps one whole window', () => {
  const base = [{ op: 'reset' }, { op: 'zoom', by: 4 }]
  const start = window_(base)
  const right = window_([...base, { op: 'move', by: 'right' }])
  assert.equal(right.cx - start.cx, start.side)
  const down = window_([...base, { op: 'move', by: 'down' }])
  assert.equal(down.cy - start.cy, start.side)
})

test('zoom halves and doubles about the centre, and stops at the picture and at MIN_SIDE', () => {
  const base = [{ op: 'reset' }, { op: 'zoom', by: 4 }]
  const start = window_(base)
  const closer = window_([...base, { op: 'zoom', by: 2 }])
  assert.equal(closer.side, start.side / 2)
  assert.equal(closer.cx, start.cx, 'about its centre, so nothing drifts')
  const further = window_([...base, { op: 'zoom', by: 0.5 }])
  assert.equal(further.side, start.side * 2)
  const tooFar = window_([{ op: 'reset' }, { op: 'zoom', by: 0.001 }])
  assert.equal(tooFar.side, W, 'never larger than the whole picture')
  const tiny = window_([{ op: 'reset' }, ...Array.from({ length: 12 }, () => ({ op: 'zoom', by: 2 }))])
  assert.equal(tiny.side, MIN_SIDE, 'never smaller than the smallest thing worth reading')
})

test('a place puts the window\'s centre there, and a wild place stays over the picture', () => {
  const here = window_([{ op: 'reset' }, { op: 'zoom', by: 2 }, { op: 'move', at: '700,400' }])
  assert.equal(here.cx, 700)
  assert.equal(here.cy, 400)
  const wild = window_([{ op: 'reset' }, { op: 'zoom', by: 2 }, { op: 'move', at: '-100,5000' }])
  assert.ok(wild.cx >= 0 && wild.cx <= W && wild.cy >= 0 && wild.cy <= H,
    'a camera pointed outside the picture would be a view of nothing')
})

test('the camera is aimed by the arguments, and refuses what it cannot read', () => {
  assert.deepEqual(opsFor('camera_reset', {}), [{ op: 'reset' }, { op: 'seen' }])
  assert.deepEqual(opsFor('camera_move', { step: 'next' }), [{ op: 'move', by: 'next' }, { op: 'seen' }])
  assert.deepEqual(opsFor('camera_move', { to: [10.4, -20.6] })[0], { op: 'move', at: '10,-21' })
  assert.deepEqual(opsFor('camera_zoom_in', { times: 3 })[0], { op: 'zoom', by: 8 })
  assert.deepEqual(opsFor('camera_zoom_out', {})[0], { op: 'zoom', by: 0.5 })
  assert.throws(() => opsFor('camera_move', {}), /needs `step`/)
  assert.throws(() => opsFor('camera_move', { step: 'sideways' }), /move must be/)
  assert.throws(() => opsFor('camera_zoom_in', { times: 0 }), /times must be/)
  assert.throws(() => moveOp([1]), /move must be/)
})

test('a batch of marks comes back as a square window with room around it', () => {
  const row = [100, 200, 300, 400].map((x, index) => ({ id: index + 1, x, y: 300, r: 20 }))
  const op = fitOp(row)
  const window = window_([{ op: 'reset' }, op])
  assert.equal(window.x1 - window.x0, window.y1 - window.y0, 'square: the strip is what this replaced')
  assert.equal(op.side, 480, 'the batch spans 300, with room for a ring either side')
  assert.equal(window.cx, 250)
  for (const mark of row) {
    assert.ok(mark.x > window.x0 && mark.x < window.x1, `mark ${mark.id} is inside the window`)
  }
  const single = window_([{ op: 'reset' }, fitOp([{ id: 1, x: 900, y: 400, r: 30 }])])
  assert.equal(single.side, 96, 'one mark gets a window around it, not a pixel')
})

test('a mark near the edge is shown whole, black outside the picture and all', () => {
  const op = fitOp([{ id: 1, x: 40, y: 30, r: 30 }])
  const window = window_([{ op: 'reset' }, op])
  assert.ok(window.x0 < 0 && window.y0 < 0, 'the window reaches past the corner rather than sliding off the mark')
  assert.equal(window.cx, 40)
  assert.equal(window.cy, 30)
})

test('the sweep counts the windows the camera stopped in, and a reset clears it', () => {
  const camera = [{ op: 'reset' }, { op: 'zoom', by: 4 }, { op: 'seen' }, { op: 'move', by: 'next' }, { op: 'seen' }]
  const sweep = sweepState(camera, W, H)
  assert.equal(sweep.total, 12, 'four across, three down')
  assert.equal(sweep.seen, 2)
  assert.deepEqual(sweep.here, { i: 3, j: 1 }, 'one window right of the middle, one row down')
  assert.equal(sweep.missing.length, 10)
  // A bare reset op clears the count and is not itself a visit; the tool appends the seen
  // marker that follows it, which is why a real reset counts as one look at the picture.
  const after = sweepState([...camera, { op: 'reset' }], W, H)
  assert.equal(after.total, 1, 'a reset is a picture being swept again')
  assert.equal(after.seen, 0)
  assert.equal(sweepState([...camera, { op: 'reset' }, { op: 'seen' }], W, H).seen, 1)
})

test('the sweep reads in words', () => {
  const sweep = { across: 4, down: 3, here: { i: 1, j: 2 }, seen: 5, total: 12, missing: [{ i: 0, j: 0 }] }
  const line = sweepLine(sweep)
  assert.match(line, /5 of 12 windows looked at/)
  assert.match(line, /this one is bottom column 2 of 4/)
  assert.match(line, /not yet: top column 1 of 4/)
  assert.match(sweepLine({ across: 1, down: 1, here: { i: 0, j: 0 }, seen: 1, total: 1, missing: [] }),
    /the whole picture is one window/)
})

test('a mark is a ring at the coordinates it was given', () => {
  const record = applyToolArgs(emptyRecord('a.png'), 'mark_add', {
    image: 'a.png', marks: [{ at: [500, 500], r: 47, caption: 'one' }]
  })
  assert.deepEqual(markRect(record.marks[0]), [453, 453, 547, 547])
  assert.match(recordLines(record)[0], /^#1 500,500 green "one"$/)
  const resized = applyToolArgs(record, 'mark_edit', { image: 'a.png', ops: [{ id: 1, r: 12 }] })
  assert.deepEqual(markRect(resized.marks[0]), [488, 488, 512, 512])
  const moved = applyToolArgs(record, 'mark_edit', { image: 'a.png', ops: [{ id: 1, move: [100, 200] }] })
  assert.deepEqual(markRect(moved.marks[0]), [53, 153, 147, 247])
  assert.equal(applyToolArgs(record, 'mark_remove', { image: 'a.png', marks: [1] }).marks.length, 0)
})

test('marking moves the camera to what was marked, and the fold remembers both', () => {
  const empty = emptyRecord('a.png')
  const one = commitCall(empty, 'mark_add', {
    image: 'a.png', marks: [{ at: [500, 400], r: 40, caption: 'a' }]
  })
  assert.deepEqual(one.result.marked, [1])
  assert.equal(one.record.marks.length, 1)
  assert.ok(one.record.camera.length >= 2, 'the camera was sent to the mark')
  const two = commitCall(one.record, 'mark_add', { image: 'a.png', marks: [{ at: [900, 600], r: 40 }] })
  assert.deepEqual(two.result.marked, [2])
  assert.equal(two.record.marks.length, 2)
  assert.equal(applyToolArgs(two.record, 'mark_remove', { image: 'a.png', marks: [1] }).marks.length, 1)
})

test('the tools are the camera and the record, and nothing else', () => {
  assert.deepEqual(CAMERA_TOOLS, ['camera_move', 'camera_zoom_in', 'camera_zoom_out', 'camera_reset'])
  assert.deepEqual(MARK_TOOLS, ['mark_add', 'mark_remove', 'mark_edit'])
  assert.equal(TRACKED_TOOLS.length, 7)
})

test('the text says which window, at what scale, and how far the sweep has got', () => {
  const camera = [{ op: 'reset' }, { op: 'zoom', by: 2 }, { op: 'seen' }]
  const window = window_(camera, 800, 600)
  const text = describeResult({
    image: 'a.png', picture: '800x600', window: `${window.x0},${window.y0},${window.x1},${window.y1}`,
    side: window.side, whole: false, scale: '3.5x', step: 50, marksShown: true, marks: 0,
    sweep: sweepLine(sweepState(camera, 800, 600)), record: [], views: [], images: []
  })
  assert.match(text, /window 200,100,600,500/)
  assert.match(text, /drawn 1400x1400 \(3\.5x of the picture\)/)
  assert.match(text, /the rest is black/)
  assert.match(text, /^sweep: 1 of 4 windows looked at · this one is bottom right/m)
  assert.match(text, /nothing marked yet/)
})
