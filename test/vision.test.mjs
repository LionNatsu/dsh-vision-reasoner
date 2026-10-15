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

import {
  MUTATING_TOOLS, TRACKED_TOOLS, applyLookArgs, applyToolArgs, emptyRecord, markPoint, markRect,
  marksInside
} from '../lib/record.js'
import { MAX_SHEET_TILES, describe as describeResult, planLook, planMark, recordLines } from '../lib/core.js'
import { cameraOps, resolveCamera } from '../lib/camera.js'
import { coordGridOverlay } from '../lib/draw.js'
import { MAX_SHEET_PIXELS, VIEW_TARGET, clampRegion, sheetLayout, viewOf } from '../lib/render.js'
import {
  SIZES, askedRegionText, frameRegion, gridLines, gridStep, placeAt, radiusFor, regionAround, regionOf,
  regionText
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
  // 1200x800 at 1400 wide is 1.17 view pixels per picture pixel, so a 50 step sits 58
  // apart — near enough to read a face off — and a 20 step would crowd the labels.
  assert.equal(gridStep(frame(), view), 50)
  assert.deepEqual(gridLines(frame(), view).across.slice(0, 5), [0, 50, 100, 150, 200])
  assert.deepEqual(gridLines(frame(), view).down.slice(0, 4), [0, 50, 100, 150])

  // Four times closer: a 20 step now sits 93 apart.
  const closer = regionOf([300, 200, 600, 400], 1200, 800)
  assert.equal(gridStep(closer, viewOf(closer, VIEW_TARGET)), 20)

  // A picture much larger than the view steps coarser, so labels never collide.
  const huge = frameRegion(20000, 15000)
  assert.equal(gridStep(huge, viewOf(huge, VIEW_TARGET)), 1000)
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
  assert.equal(radiusFor(undefined), 30, 'a caller that says nothing gets the crowd size')
  assert.throws(() => radiusFor('xl'), /size must be one of s, m, l/)
  // A number is the honest form: the ring is a size in the picture, so changing how
  // closely the caller is looking does not change the ring it already placed.
  assert.equal(radiusFor(undefined, 47), 47)
  assert.equal(radiusFor('s', 200), 200, 'a number wins over a preset')
  assert.equal(radiusFor(undefined, 3.4), 4, 'and is at least a few pixels across')
  assert.throws(() => radiusFor(undefined, 'wide'), /r must be a number of picture pixels/)
})

test('a radius given in pixels survives a replay', () => {
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark',
    { image: 'a.png', marks: [{ at: [500, 500], r: 47 }] })
  assert.deepEqual(markRect(record.marks[0]), [453, 453, 547, 547])
  const resized = applyToolArgs(record, 'vision_edit', { image: 'a.png', ops: [{ id: 1, r: 12 }] })
  assert.deepEqual(resized.marks.map(markRect), [[488, 488, 512, 512]])
})

test('the grid is always drawn, and its axes are told apart by colour', () => {
  const view = viewOf(frame(), VIEW_TARGET)
  const svg = coordGridOverlay(view, frame())
  assert.match(svg, /#22d3ee/, 'the columns that run down')
  assert.match(svg, /#f5b942/, 'the rows that run across')
  const lines = svg.split('<line').length - 1
  assert.ok(lines > 10, 'the grid draws its lines: ' + lines)
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
  assert.equal(looked.result.step, 20)
  assert.equal(looked.views[0].kind, 'crop')
  assert.equal(looked.views[0].name, 'crop-300-200-a.png')
  assert.equal(looked.views[0].width, VIEW_TARGET)
  assert.ok(looked.views[0].height <= VIEW_TARGET)
  assert.match(describeResult(looked.result), /grid every 20 original pixels/)
})

test('a look the caller did not ask to be marked comes back clean', async () => {
  const src = await source()
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark',
    { image: 'a.png', marks: [{ at: [600, 400] }] })
  const clean = await planLook({ record, args: { image: 'a.png' }, loadSource: loadSource(src) })
  assert.equal(clean.result.marksShown, false)
  assert.equal(clean.result.marks, 1, 'the record comes back even when the marks do not')
  assert.match(describeResult(clean.result), /1 mark is not drawn here — `marks: true` draws them at this scale/,
    'a caller that never sees its own record drawn is told it can')
  assert.match(describeResult({ ...clean.result, marks: 0, record: [] }),
    /nothing marked yet — mark a place as you decide it/,
    'and before anything is marked it is told how marking works')
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
  assert.equal(marked.result.step, 10, 'and the grid is finer there, because the view is closer')
})

test('several rectangles come back as one sheet, each labelled with where it came from', async () => {
  const src = await source()
  const swept = await planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', regions: [[0, 0, 600, 400], [600, 0, 1200, 400], [0, 400, 1200, 800]] },
    loadSource: loadSource(src)
  })
  assert.equal(swept.views.length, 1, 'one picture, not one per rectangle')
  assert.equal(swept.views[0].kind, 'compare')
  assert.equal(swept.views[0].name, 'sheet-3-a.png')
  assert.match(swept.views[0].label, /#1 0,0,600,400, #2 600,0,1200,400, #3 0,400,1200,800/)
  // Three tiles, so two columns; and the cells take the tiles' own shape — about
  // twice as wide as tall here — rather than being padded into 620-pixel squares,
  // which would have made the sheet 1354 tall and shown no more picture.
  assert.equal(swept.views[0].width, 2 * (620 + 10) + 10)
  assert.equal(swept.views[0].height, 2 * (310 + 10 + 42) + 10)
})

test('a sheet holds a bounded number of rectangles', async () => {
  const src = await source()
  const many = Array.from({ length: MAX_SHEET_TILES + 1 }, (_, i) => [i * 100, 0, i * 100 + 100, 100])
  await assert.rejects(
    () => planLook({ record: emptyRecord('a.png'), args: { image: 'a.png', regions: many }, loadSource: loadSource(src) }),
    /regions holds at most 9 rectangles, got 10/
  )
})

test('a sheet is never bigger than the pipeline will carry', () => {
  // A sixteen-tile sheet reached a caller as 1982x2114 rather than the 2530x2698 that
  // was drawn: the pipeline resamples past about four mebipixels, and a caller that
  // sees one size while being told another cannot read a position off it.
  for (const count of [4, 9, 16, 36, 64]) {
    const layout = sheetLayout(count)
    const pixels = layout.width * layout.height
    assert.ok(pixels <= MAX_SHEET_PIXELS,
      `${count} tiles made a ${layout.width}x${layout.height} sheet, ${(pixels / 1e6).toFixed(2)}MP`)
  }
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

test('the camera is aimed by the arguments, and resolved in the picture', () => {
  assert.deepEqual(cameraOps({ zoom: 'in' }), [{ op: 'zoom', by: 2 }])
  assert.deepEqual(cameraOps({ zoom: 'out' }), [{ op: 'zoom', by: 0.5 }])
  assert.deepEqual(cameraOps({ zoom: '3' }), [{ op: 'zoom', by: 3 }])
  assert.deepEqual(cameraOps({ move: [10.4, -20.6] }), [{ op: 'move', by: [10, -21] }])
  assert.equal(cameraOps({ regions: [[0, 0, 10, 10]] })[0].op, 'reset', 'a sweep starts from the whole picture')
  assert.deepEqual(cameraOps({}), [], 'a plain look aims nothing and stays where it is')
  assert.throws(() => cameraOps({ zoom: 'closer' }), /zoom must be "in", "out" or a factor/)
  assert.throws(() => cameraOps({ move: [1] }), /move must be \[dx, dy\] in original pixels/)

  const whole = frameRegion(2400, 1600)
  assert.deepEqual(resolveCamera([{ op: 'reset' }], 2400, 1600), whole)
  assert.deepEqual(resolveCamera([{ op: 'zoom', by: 2 }], 2400, 1600),
    { x0: 600, y0: 400, x1: 1800, y1: 1200 }, 'a step in halves the view about its centre')
  assert.deepEqual(resolveCamera([{ op: 'zoom', by: 2 }, { op: 'move', by: [100, 50] }], 2400, 1600),
    { x0: 700, y0: 450, x1: 1900, y1: 1250 }, 'and a move shifts it by original pixels')
  assert.deepEqual(resolveCamera([{ op: 'move', by: [300, 200] }], 2400, 1600), whole,
    'a view never leaves the picture')
  const deep = resolveCamera(Array.from({ length: 12 }, () => ({ op: 'zoom', by: 2 })), 2400, 1600)
  assert.equal(deep.x1 - deep.x0, 200, 'and never gets smaller than a twelfth of the longer side')
})

test('a look shows what the camera is pointed at', async () => {
  const src = await source(2400, 1600)
  const load = loadSource(src)
  let record = emptyRecord('a.png')

  const zoomed = await planLook({ record, args: { image: 'a.png', zoom: 'in' }, loadSource: load })
  assert.equal(zoomed.result.region, '600,400,1800,1200')
  // The frame of a 2400-wide picture is drawn at 0.58x, so one step in doubles that.
  assert.match(describeResult(zoomed.result), /\(1\.2x of the picture\)/)

  record = applyLookArgs(record, { image: 'a.png', zoom: 'in' })
  const again = await planLook({ record, args: { image: 'a.png' }, loadSource: load })
  assert.equal(again.result.region, '600,400,1800,1200', 'looking again shows where the camera is')

  const moved = await planLook({ record, args: { image: 'a.png', move: [-300, -200] }, loadSource: load })
  assert.equal(moved.result.region, '300,200,1500,1000')

  const covered = await planLook({ record, args: { image: 'a.png', cover: 'green' }, loadSource: load })
  assert.equal(covered.result.region, '600,400,1800,1200', 'covering needs no rectangle: it covers what is seen')

  const back = await planLook({ record, args: { image: 'a.png', reset: true }, loadSource: load })
  assert.equal(back.result.region, '0,0,2400,1600')
})

test('the mutating tools are the ones the fold replays', () => {
  assert.deepEqual(MUTATING_TOOLS, ['vision_mark', 'vision_unmark', 'vision_edit'])
  assert.deepEqual(TRACKED_TOOLS, ['vision_mark', 'vision_unmark', 'vision_edit', 'vision_look'],
    'a look leaves the rectangles it worked in')
})

test('the ledger remembers the rectangles a look worked in', () => {
  assert.equal(askedRegionText([400, 300, 100, 200]), '100,200,400,300', 'either corner may be named first')
  assert.equal(askedRegionText(undefined), undefined, 'nothing asked about, nothing to remember')
  assert.throws(() => askedRegionText(['a', 1, 2, 3]), /region must be four numbers in original pixels/)
  let record = emptyRecord('a.png')
  record = applyLookArgs(record, { region: [0, 0, 900, 450] })
  record = applyLookArgs(record, { regions: [[900, 0, 1800, 450], [0, 0, 900, 450]] })
  assert.deepEqual(record.looks, ['900,0,1800,450', '0,0,900,450'], 'newest first, each once')
  record = applyLookArgs(record, {})
  assert.equal(record.looks.length, 2, 'a look of the whole picture asks about nothing in particular')

  record = applyToolArgs(record, 'vision_mark',
    { image: 'a.png', marks: [{ at: [200, 200] }, { at: [1200, 200] }] })
  assert.equal(marksInside(record, '0,0,900,450'), 1)
  assert.equal(marksInside(record, '900,0,1800,450'), 1)
})

test('the text says how the picture on screen relates to the picture', () => {
  const base = {
    image: 'a.png',
    picture: '2600x1831',
    step: 200,
    marksShown: true,
    marks: 1,
    looked: [{ region: '0,0,900,450', marks: 0 }],
    record: ['#1 100,100 green'],
    images: []
  }
  const whole = describeResult({
    ...base,
    region: '0,0,2600,1831',
    views: [{ kind: 'frame', name: 'frame-a.png', label: '', width: 1400, height: 986 }]
  })
  assert.match(whole, /drawn 1400x986 \(0\.54x of the picture\)/)
  assert.match(whole, /looked: 0,0,900,450 \(0\)/)
  assert.match(whole, /nothing marked inside 0,0,900,450 yet/)

  const close = describeResult({
    ...base,
    region: '0,0,300,200',
    views: [{ kind: 'crop', name: 'crop-a.png', label: '', width: 1400, height: 933 }]
  })
  assert.match(close, /\(4\.7x of the picture\)/)

  const sheet = describeResult({
    ...base,
    region: '0,0,2600,1831',
    step: 0,
    views: [{ kind: 'compare', name: 'sheet-2-a.png', label: '#1 0,0,900,450', width: 1900, height: 900 }]
  })
  assert.match(sheet, /drawn 1900x900 as a sheet of tiles/)
  assert.match(sheet, /each tile carries its own grid/, 'no tile is drawn without a grid')
})
