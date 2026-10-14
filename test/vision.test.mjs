/**
 * The pure half: the grid, the places, and the pictures.
 *
 * About invariants, not snapshots: a place is named in the picture's own pixels, the
 * grid steps in round numbers of those pixels, a call replays from its own arguments
 * alone, and no result states a count of what the picture holds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import sharp from 'sharp'

import { MUTATING_TOOLS, applyToolArgs, emptyRecord, markPoint, markRect } from '../lib/record.js'
import { describe as describeResult, planLook, planMark, recordLines } from '../lib/core.js'
import { VIEW_TARGET, clampRegion, viewOf } from '../lib/render.js'
import {
  SIZES, frameRegion, gridLines, gridStep, placeAt, radiusFor, regionAround, regionOf, regionText
} from '../lib/views.js'

const frame = () => frameRegion(1200, 800)

/** A flat, dark scene: anything drawn over it stands out. A real JPEG, because the
 *  renderer is the image library's and a fake would not be testing it. */
async function source(width = 1200, height = 800) {
  const bytes = await sharp(Buffer.alloc(width * height * 3, 60), {
    raw: { width, height, channels: 3 }
  }).jpeg({ quality: 80 }).toBuffer()
  return { bytes, width, height, orientation: undefined }
}

const loadSource = (src) => async () => src

test('a grid steps in round numbers of the picture\'s own pixels', () => {
  const view = viewOf(frame(), VIEW_TARGET)
  // 1200x800 at 1400 wide is 1.17 view pixels per picture pixel, so a 100 step sits
  // 117 apart and a 50 step would crowd the labels.
  assert.equal(gridStep(frame(), view), 100)
  assert.deepEqual(gridLines(frame(), view).across,
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200])
  assert.deepEqual(gridLines(frame(), view).down, [0, 100, 200, 300, 400, 500, 600, 700, 800])

  // Four times closer: the same labels would be 467 apart, so the grid steps finer.
  const closer = regionOf([300, 200, 600, 400], 1200, 800)
  assert.equal(gridStep(closer, viewOf(closer, VIEW_TARGET)), 50)

  // A picture much larger than the view steps coarser, so labels never collide.
  const huge = frameRegion(20000, 15000)
  assert.equal(gridStep(huge, viewOf(huge, VIEW_TARGET)), 2000)
})

test('a place is read in the picture\'s own pixels, and refused outside it', () => {
  assert.deepEqual(placeAt([1200, 640], 2600, 1831), [1200, 640])
  assert.deepEqual(placeAt([1200.4, 640.6], 2600, 1831), [1200, 641], 'a pixel is a whole pixel')
  assert.deepEqual(placeAt([2600, 1831], 2600, 1831), [2600, 1831], 'the far edge is inside')
  assert.throws(() => placeAt([2601, 10], 2600, 1831), /outside the picture, which is 2600x1831 original pixels/)
  assert.throws(() => placeAt([-1, 10], 2600, 1831), /outside the picture/)
  assert.throws(() => placeAt('C3', 2600, 1831), /at must be \[x, y\] in original pixels/)
  assert.throws(() => placeAt([1], 2600, 1831), /at must be \[x, y\] in original pixels/)
})

test('a region is four numbers, trimmed to the picture, either way round', () => {
  assert.deepEqual(regionOf(undefined, 1200, 800), frame())
  assert.deepEqual(regionOf([200, 100, 400, 300], 1200, 800), { x0: 200, y0: 100, x1: 400, y1: 300 })
  assert.deepEqual(regionOf([400, 300, 200, 100], 1200, 800), { x0: 200, y0: 100, x1: 400, y1: 300 })
  assert.deepEqual(regionOf([-50, -50, 5000, 5000], 1200, 800), frame(), 'trimmed, never outside')
  assert.equal(regionText(frame()), '0,0,1200,800')
  assert.throws(() => regionOf([1, 2, 3], 1200, 800), /region must be \[x0, y0, x1, y1\]/)
  assert.throws(() => regionOf(['a', 2, 3, 4], 1200, 800), /region must be four numbers/)
})

test('a size is a ring in pixels, the same whatever is being looked at', () => {
  assert.deepEqual(SIZES, { s: 30, m: 60, l: 120 })
  assert.equal(radiusFor('s'), 30)
  assert.equal(radiusFor(undefined), 60, 'a caller that says nothing gets the middle size')
  assert.throws(() => radiusFor('xl'), /size must be one of s, m, l/)
})

test('a view is a uniform scale of its rectangle, and a closer rectangle is magnified', () => {
  const whole = viewOf(frame(), VIEW_TARGET)
  // Rounded to whole pixels, so the two scales agree to within a pixel, not exactly.
  assert.ok(Math.abs(whole.sx - whole.sy) < 0.01, 'a view does not distort the picture')
  assert.deepEqual([whole.width, whole.height], [1400, 933])

  const closer = regionOf([300, 200, 600, 400], 1200, 800)
  const closeView = viewOf(closer, VIEW_TARGET)
  assert.ok(closeView.sx > whole.sx * 3, 'looking closer magnifies')
  assert.deepEqual(clampRegion({ x0: -10, y0: -10, x1: 4000, y1: 4000 }, { width: 1200, height: 800 }), frame())
})

test('the rectangle around places has room for what is next to them', () => {
  assert.deepEqual(regionAround([[100, 100]]), { x0: 60, y0: 60, x1: 140, y1: 140 })
  assert.deepEqual(regionAround([[100, 100], [200, 300]]), { x0: 15, y0: -70, x1: 285, y1: 470 })
})

test('a mark is a ring at the coordinates it was given', () => {
  const marked = applyToolArgs(emptyRecord('a.png'), 'vision_mark',
    { image: 'a.png', marks: [{ at: [1200, 640], size: 'm', caption: 'one' }] })
  assert.equal(marked.marks.length, 1)
  assert.deepEqual(markPoint(marked.marks[0]), [1200, 640], 'the place is the place, to the pixel')
  assert.deepEqual(markRect(marked.marks[0]), [1140, 580, 1260, 700], 'and the ring is the size it was told')
  assert.deepEqual(applyToolArgs(marked, 'vision_edit', { image: 'a.png', ops: [{ id: 1, move: [40, 500] }] })
    .marks.map(markPoint), [[40, 500]])
  assert.deepEqual(applyToolArgs(marked, 'vision_edit', { image: 'a.png', ops: [{ id: 1, size: 'l' }] })
    .marks.map(markRect), [[1080, 520, 1320, 760]])
  assert.equal(applyToolArgs(marked, 'vision_unmark', { image: 'a.png', marks: [1] }).marks.length, 0)
})

test('the record says where every mark is, in the picture\'s own pixels', () => {
  let record = emptyRecord('a.png')
  record = applyToolArgs(record, 'vision_mark', {
    image: 'a.png',
    marks: [{ at: [866, 700], colour: 'magenta', caption: 'front woman' }, { at: [40, 50] }]
  })
  assert.deepEqual(recordLines(record), ['#1 866,700 magenta "front woman"', '#2 40,50 green'])
  const text = describeResult({
    image: 'a.png',
    picture: '2600x1831',
    region: '0,0,2600,1831',
    step: 200,
    marksShown: false,
    marks: record.marks.length,
    record: recordLines(record),
    views: [],
    images: []
  })
  assert.match(text, /#1 866,700 magenta "front woman"/)
  assert.match(text, /\(2600x1831\)/, 'the picture\'s own size, in original pixels')
  assert.match(text, /view 0,0,2600,1831 — grid every 200 original pixels, no marks drawn/)
})

test('looking closer draws the rectangle it was asked for, at the frame\'s own size', async () => {
  const src = await source()
  const looked = await planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', region: [300, 200, 600, 400] },
    loadSource: loadSource(src)
  })
  assert.equal(looked.result.region, '300,200,600,400')
  assert.equal(looked.result.picture, '1200x800')
  assert.equal(looked.result.step, 50)
  assert.equal(looked.views[0].kind, 'crop')
  assert.equal(looked.views[0].name, 'crop-300-200-a.png')
  assert.equal(looked.views[0].width, VIEW_TARGET)
  assert.ok(looked.views[0].height <= VIEW_TARGET)
  assert.match(describeResult(looked.result), /grid every 50 original pixels/)
})

test('a look the caller did not ask to be marked comes back clean', async () => {
  const src = await source()
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark',
    { image: 'a.png', marks: [{ at: [600, 400] }] })
  const clean = await planLook({ record, args: { image: 'a.png' }, loadSource: loadSource(src) })
  assert.equal(clean.result.marksShown, false)
  assert.equal(clean.result.marks, 1, 'the record comes back even when the marks do not')
  const drawn = await planLook({ record, args: { image: 'a.png', marks: true }, loadSource: loadSource(src) })
  assert.equal(drawn.result.marksShown, true)
  assert.equal(drawn.views[0].kind, 'frame')
  assert.equal(drawn.views[0].name, 'frame-a.png')
})

test('marking reports where it landed, and draws a rectangle around it', async () => {
  const src = await source()
  const marked = await planMark({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', marks: [{ at: [600, 400] }, { at: [660, 460] }] },
    loadSource: loadSource(src)
  })
  assert.deepEqual(marked.result.marked, [1, 2])
  assert.deepEqual(marked.result.record, ['#1 600,400 green', '#2 660,460 green'])
  assert.equal(marked.result.region, '549,349,711,511', 'around what was just marked')
  assert.equal(marked.result.views[0].kind, 'crop')
  assert.equal(marked.result.step, 20, 'and the grid is finer there, because the view is closer')
})

test('a comparison sheet puts the marks side by side', async () => {
  const src = await source()
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark',
    { image: 'a.png', marks: [{ at: [300, 300], caption: 'left' }, { at: [900, 500], caption: 'right' }] })
  const compared = await planLook({
    record,
    args: { image: 'a.png', compare: [1, 2] },
    loadSource: loadSource(src)
  })
  assert.equal(compared.views.length, 1, 'one sheet of tiles, not one picture per mark')
  assert.equal(compared.views[0].kind, 'compare')
  assert.match(compared.views[0].label, /#1 left, #2 right/)
})

test('the mutating tools are the ones the fold replays', () => {
  assert.deepEqual(MUTATING_TOOLS, ['vision_mark', 'vision_unmark', 'vision_edit'])
})
