/**
 * The record, the views and the shared call layer.
 *
 * About invariants, not snapshots: a record is reproducible from the calls that
 * produced it, a label on a view is an original-image coordinate, a mark lands
 * where the record says, and no result claims to know what a picture holds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import sharp from 'sharp'

import {
  applyMarkArgs, applyUpdateArgs, colourOf, colourName, emptyRecord, findMark,
  imageKey, markPoint, markRect, parseAddress, recordSummary
} from '../lib/record.js'
import { escapeXml, fitText, fitView, mapOverlay, textWidth } from '../lib/draw.js'
import { renderViews } from '../lib/render.js'
import { describe as describeResult, planList, planMark, planShow, planUpdate } from '../lib/core.js'
import { COLOURS } from '../lib/draw.js'

/** A deterministic synthetic photograph: a gradient with hard edges to align to. */
async function scene(width = 600, height = 400) {
  const channels = 3
  const data = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      data[i] = Math.round((x * 255) / width)
      data[i + 1] = Math.round((y * 255) / height)
      data[i + 2] = 128
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer()
}

const withScene = async (record, request, size = {}) => {
  const bytes = size.bytes ?? await scene(size.width, size.height)
  return renderViews({
    bytes,
    width: size.width ?? 600,
    height: size.height ?? 400,
    orientation: 1
  }, record, request)
}

/** Decode a rendered PNG so a test can ask what colour a pixel actually is. */
async function pixels(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    at(x, y) {
      const i = (Math.round(y) * info.width + Math.round(x)) * 4
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }
  }
}

/** How many pixels of a decoded view are close to a colour. */
function countNear(image, rgb, tolerance = 40) {
  let count = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = image.at(x, y)
      if (Math.abs(r - rgb[0]) <= tolerance && Math.abs(g - rgb[1]) <= tolerance &&
        Math.abs(b - rgb[2]) <= tolerance) count++
    }
  }
  return count
}

// ---------------------------------------------------------------- record

test('marks are numbered in the order given, from one', () => {
  const base = emptyRecord('a.jpg')
  const first = applyMarkArgs(base, { marks: [{ at: [10, 20] }, { box: [1, 2, 3, 4] }] })
  assert.deepEqual(first.result.marked, [1, 2])
  assert.equal(first.record.marks[0].kind, 'point')
  assert.equal(first.record.marks[0].r, 60, 'default radius')
  assert.equal(first.record.marks[1].kind, 'box')
  const second = applyMarkArgs(first.record, { marks: [{ at: [5, 5] }] })
  assert.deepEqual(second.result.marked, [3])
  assert.equal(base.marks.length, 0, 'the input record is never mutated')
})

test('a box given backwards is straightened, and bad input is refused loudly', () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ box: [90, 80, 10, 20] }] })
  assert.deepEqual(markRect(record.marks[0]), [10, 20, 90, 80])
  assert.throws(() => applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [1, 2], colour: 'purple' }] }),
    /unknown colour "purple"/)
  assert.throws(() => applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [1, 2], r: 0 }] }),
    /radius must be a positive number/)
  assert.throws(() => applyMarkArgs(emptyRecord('a.jpg'), { marks: [] }), /non-empty array/)
  assert.throws(() => applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ kind: 'box', at: [1, 2] }] }),
    /a box needs/)
  assert.throws(() => applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [1, 2], caption: 'x'.repeat(300) }] }),
    /at most 200/)
  const sized = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [1, 2], r: 30 }] })
  assert.equal(sized.record.marks[0].r, 30)
  assert.deepEqual(markPoint(sized.record.marks[0]), [1, 2])
})

test('update moves, recaptions, recolours and removes, and refuses nonsense', () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'),
    { marks: [{ at: [10, 10] }, { box: [0, 0, 5, 5] }] })
  const moved = applyUpdateArgs(record, {
    ops: [
      { id: 1, move: [100, 200], caption: 'half hidden', colour: 'yellow' },
      { id: 2, move: [8, 9, 1, 2] }
    ]
  })
  assert.deepEqual(moved.result.updated[1].move, [100, 200])
  assert.equal(moved.record.marks[0].caption, 'half hidden')
  assert.equal(moved.record.marks[0].colour, 'yellow')
  assert.deepEqual(markRect(moved.record.marks[1]), [1, 2, 8, 9], 'a moved box is straightened')
  assert.throws(() => applyUpdateArgs(record, { ops: [{ id: 9, caption: 'x' }] }), /no mark #9/)
  assert.throws(() => applyUpdateArgs(record, { ops: [{ id: 2, move: [1, 2] }] }), /is a box: move needs/)
  assert.throws(() => applyUpdateArgs(record, { ops: [{ id: 2, r: 10 }] }), /has no radius/)
  assert.throws(() => applyUpdateArgs(record, { ops: [{ id: 1 }] }), /changes nothing/)
  const removed = applyUpdateArgs(record, { ops: [{ id: 1, remove: true }] })
  assert.deepEqual(removed.result.removed, [1])
  assert.equal(removed.record.marks.length, 1)
})

test('addresses read as a stored mark, a point, or a rectangle', () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [30, 40] }] })
  assert.deepEqual(parseAddress(record, '#1').point, [30, 40])
  assert.deepEqual(parseAddress(record, '640,480').rect, [640, 480, 640, 480])
  assert.deepEqual(parseAddress(record, '120,240,360,520').rect, [120, 240, 360, 520])
  assert.throws(() => parseAddress(record, '12'), /cannot read address/)
  assert.throws(() => parseAddress(record, '#42'), /no mark #42/)
})

test('one picture has one identity, whatever way its path was written', () => {
  assert.equal(imageKey('a.jpg', 'D:\\pics'), imageKey('a.jpg', 'D:/pics'))
  assert.equal(imageKey('D:\\pics\\a.jpg', undefined), 'd:/pics/a.jpg')
  assert.equal(imageKey('./sub/../a.jpg', '/root'), '/root/a.jpg')
  assert.notEqual(imageKey('a.jpg', '/one'), imageKey('a.jpg', '/two'))
  // Windows paths are case-insensitive: two spellings of one file must not become
  // two records, each with its own #1.
  assert.equal(imageKey('D:\\work\\A.JPG', undefined), imageKey('d:/WORK/a.jpg', undefined))
  assert.equal(imageKey('A.JPG', 'D:\\work'), imageKey('a.jpg', 'd:\\WORK'))
  // POSIX paths are case-sensitive, and must stay two records.
  assert.notEqual(imageKey('A.JPG', '/work'), imageKey('a.jpg', '/work'))
})

test('a replay of the same calls rebuilds the same record', () => {
  const calls = [
    ['mark', { marks: [{ at: [10, 10] }, { at: [20, 20], colour: 'yellow' }] }],
    ['update', { ops: [{ id: 1, caption: 'half hidden' }, { id: 2, remove: true }] }],
    ['mark', { marks: [{ box: [1, 2, 30, 40], caption: 'pair?' }] }]
  ]
  const replay = () => calls.reduce((record, [kind, args]) =>
    kind === 'mark' ? applyMarkArgs(record, args).record : applyUpdateArgs(record, args).record,
  emptyRecord('a.jpg'))
  const once = replay()
  assert.deepEqual(once, replay())
  // #2 was removed, so the freed number is handed out again — a stale #2 is
  // refused rather than silently meaning something else.
  assert.deepEqual(once.marks.map((m) => m.id), [1, 2])
  assert.equal(once.marks[1].caption, 'pair?')
})

test('a record summary states marks, not what the picture holds', () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [1, 2], caption: 'first one' }] })
  const summary = recordSummary(record)
  assert.equal(summary.marks, 1)
  assert.deepEqual(summary.items[0].at, [1, 2])
  const text = describeResult(summary)
  assert.match(text, /1 mark in the record/)
  assert.doesNotMatch(text, /people|person/i)
})

// ---------------------------------------------------------------- drawing

test('text escaping and truncation keep the document intact', () => {
  assert.equal(escapeXml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; &quot;d&quot;')
  assert.equal(fitText('short', 500, 16), 'short')
  assert.match(fitText('a very long caption indeed', 80, 16), /…$/)
  assert.ok(textWidth(fitText('a very long caption indeed', 80, 16), 16) <= 80)
})

test('a mark is drawn where the record says, in its own colour', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [300, 200], r: 50, colour: 'red' }] })
  // A 1:1 view, so original pixels and view pixels are the same numbers.
  const [view] = await withScene(record, { target: 600 })
  const image = await pixels(view.png)
  assert.equal(image.width, 600)
  assert.equal(image.height, 400)
  const red = (x, y) => {
    const [r, g, b] = image.at(x, y)
    return r > 200 && g < 120 && b < 120
  }
  // The ring passes through the four points one radius away from the centre...
  for (const [x, y] of [[250, 200], [350, 200], [300, 150], [300, 250]]) {
    assert.ok(red(x, y), `expected the ring at ${x},${y}`)
  }
  // ...and nowhere one would not expect it: the centre is still the photograph,
  // and a point outside the ring is untouched.
  assert.ok(!red(300, 200), 'the ring is an outline, not a disc')
  assert.ok(!red(300, 140), 'nothing is drawn outside the ring')
  assert.ok(!red(180, 200), 'and nothing 120 pixels to the left of it')
})

test('two marks keep their own colours and their own places', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), {
    marks: [{ at: [300, 200], r: 30, colour: 'red' }, { at: [60, 60], r: 30, colour: 'blue' }]
  })
  const [view] = await withScene(record, { target: 600 })
  const image = await pixels(view.png)
  // Each sample sits one radius from its own centre, which is where a ring is.
  const blue = image.at(90, 60)
  assert.ok(blue[2] > 180 && blue[0] < 120, `expected blue at 90,60, got ${blue.slice(0, 3).join(',')}`)
  const red = image.at(270, 200)
  assert.ok(red[0] > 180 && red[1] < 120, `expected red at 270,200, got ${red.slice(0, 3).join(',')}`)
  // Neither ring reached the other's centre.
  assert.ok(!(image.at(60, 60)[2] > 180), 'the blue centre is not filled')
  assert.ok(!(image.at(300, 200)[0] > 180), 'the red centre is not filled')
})

test('a zoom magnifies around the address and labels original coordinates', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [300, 200], r: 40, colour: 'green' }] })
  const [zoom] = await withScene(record, { views: ['#1'], pad: 100, target: 400 })
  assert.equal(zoom.kind, 'zoom')
  const image = await pixels(zoom.png)
  assert.equal(image.width, 400)
  assert.equal(image.height, 400)
  // The label on the tile carries the mark's number.
  assert.match(zoom.label, /^#1/)
  // A green ring is present after magnification, so the mark survived the crop.
  assert.ok(countNear(image, COLOURS.green) > 100, 'the mark is visible in its own close-up')
})

test('several addresses come back as one sheet', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'),
    { marks: [{ at: [100, 100] }, { at: [500, 300], caption: 'half hidden' }] })
  const [sheet] = await withScene(record, { views: ['#1', '#2'], tile: 200, pad: 10 })
  assert.equal(sheet.kind, 'sheet')
  assert.equal(sheet.name, 'sheet_2_a.png')
  const image = await pixels(sheet.png)
  assert.equal(image.width, 2 * (200 + 10) + 10)
  assert.equal(image.height, 200 + 10 + Math.max(16, 42) + 10)
  assert.match(sheet.label, /#1, #2 half hidden/, 'each tile carries its own caption')
})

test('cover paints the settled marks out, so what shows is unmarked', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [300, 200], r: 50 }] })
  const [cover] = await withScene(record, { cover: 'green', target: 600 })
  assert.equal(cover.kind, 'cover')
  const image = await pixels(cover.png)
  const centre = image.at(300, 200)
  assert.ok(centre[0] < 60 && centre[1] < 60 && centre[2] < 60,
    `the mark should be painted out, got ${centre.slice(0, 3).join(',')}`)
  // The photograph is still there where no mark sits.
  const away = image.at(20, 380)
  assert.ok(!(away[0] < 60 && away[1] < 60 && away[2] < 60))
  await assert.rejects(() => renderViews({ bytes: null, width: 1, height: 1 }, record, { cover: 'purple' }),
    /unknown colour\(s\) purple/)
})

test('every colour in the palette can be stored and drawn', async () => {
  for (const name of Object.keys(COLOURS)) {
    assert.equal(colourName(name), name)
    const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [50, 50], colour: name }] })
    assert.equal(colourOf(findMark(record, 1)), COLOURS[name])
  }
  const { record } = applyMarkArgs(emptyRecord('a.jpg'),
    { marks: Object.keys(COLOURS).map((colour, i) => ({ at: [40 + i * 20, 60], colour })) })
  const [view] = await withScene(record, { target: 300 })
  assert.ok(view.png.length > 0)
})

test('a label sits on the coordinate it names, not beside it', () => {
  // A label hung to the right of its tick reads as if it marked where the text
  // starts — a few pixels of systematic error in every coordinate taken from it.
  const svg = mapOverlay(emptyRecord('a.jpg'), { x0: 0, y0: 0, sx: 1, sy: 1, width: 600, height: 400 },
    { step: 200 })
  const centred = /<text x="([0-9.]+)"[^>]*text-anchor="middle"[^>]*>200<\/text>/.exec(svg)
  assert.ok(centred, 'the 200 tick carries a centred label')
  assert.equal(Number(centred[1]), 200, 'and it is centred on the tick, not offset from it')
})

test('a close-up marks the address itself, so one position needs no reading', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [300, 200], r: 40 }] })
  const [zoom] = await withScene(record, { views: ['#1'], pad: 100, target: 400 })
  // The crosshair is drawn in magenta and captioned with the original coordinate.
  const { data } = await sharp(zoom.png).raw().toBuffer({ resolveWithObject: true })
  let magenta = 0
  for (let i = 0; i < data.length; i += 3) {
    if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] > 180) magenta++
  }
  assert.ok(magenta > 40, `expected an anchor crosshair, found ${magenta} magenta pixels`)
})

test('the ruler stays readable on any shape, including extreme ones', () => {
  // The step has to satisfy BOTH axes: labels need room across, and consecutive
  // rows need room down. A step chosen from the horizontal scale alone put the y
  // labels 7 pixels apart for 11-pixel text on a 2x20000 picture.
  for (const [width, height] of [[1600, 1200], [6400, 4800], [2, 20000], [20000, 2], [5200, 600]]) {
    const view = fitView(width, height, 1400)
    const svg = mapOverlay(emptyRecord('big.jpg'), view, {})
    const ys = [...svg.matchAll(/<text x="4\.0" y="([0-9.]+)"/g)].map((m) => Number(m[1]))
    assert.ok(ys.length >= 1, `${width}x${height} got no y ruler`)
    for (let i = 1; i < ys.length; i++) {
      const gap = ys[i] - ys[i - 1]
      assert.ok(gap >= 10, `${width}x${height}: y labels ${gap.toFixed(1)}px apart`)
    }
  }
})

test('no view can be asked for a size the caller cannot pay for', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [300, 200], r: 40 }] })
  const bytes = await scene(2400, 1600)
  const source = { bytes, width: 2400, height: 1600, orientation: 1 }
  // A whole-frame crop at an absurd target would otherwise produce a
  // multi-hundred-megapixel PNG.
  const [huge] = await renderViews(source, record, { views: ['0,0,2399,1599'], target: 20000 })
  assert.ok(Math.max(huge.width, huge.height) <= 4096, `zoom was not capped: ${huge.width}x${huge.height}`)
  // A sheet grows with the tile count, so its tile shrinks to fit.
  const many = applyMarkArgs(emptyRecord('a.jpg'), {
    marks: Array.from({ length: 40 }, (_, i) => ({ at: [40 + i * 20, 200] }))
  }).record
  const [sheet] = await renderViews(source, many, {
    views: many.marks.map((m) => `#${m.id}`),
    tile: 1200
  })
  assert.ok(Math.max(sheet.width, sheet.height) <= 4096, `sheet was not capped: ${sheet.width}x${sheet.height}`)
})

// ---------------------------------------------------------------- core

test('a call reports the picture it produced, never a count of the picture', async () => {
  const planned = await planMark({
    record: emptyRecord('a.jpg'),
    args: { marks: [{ at: [100, 200] }, { at: [110, 210], colour: 'yellow' }] },
    loadSource: () => withSource()
  })
  assert.deepEqual(planned.result.marked, [1, 2])
  assert.equal(planned.result.marks, 2)
  assert.equal(planned.result.views.length, 1)
  const text = describeResult(planned.result)
  assert.match(text, /marked #1 #2/)
  assert.match(text, /2 marks in the record/)
  assert.doesNotMatch(text, /people|person/i)
})

async function withSource() {
  return { bytes: await scene(600, 400), width: 600, height: 400, orientation: 1 }
}

test('view:none draws nothing, view:marks shows exactly what was touched', async () => {
  const none = await planMark({
    record: emptyRecord('a.jpg'),
    args: { marks: [{ at: [1, 2] }], view: 'none' },
    loadSource: () => { throw new Error('must not read the picture when no view was asked for') }
  })
  assert.deepEqual(none.views, [])
  const marks = await planMark({
    record: emptyRecord('a.jpg'),
    args: { marks: [{ at: [100, 200] }, { at: [300, 300] }], view: 'marks' },
    loadSource: withSource
  })
  assert.equal(marks.views.length, 1)
  assert.equal(marks.views[0].kind, 'sheet')
  assert.match(describeResult(marks.result), /sheet_2_a\.png/)
})

test('an update shows the marks it changed, and a removal is not shown', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [100, 100] }, { at: [200, 200] }] })
  const planned = await planUpdate({
    record,
    args: { ops: [{ id: 2, remove: true }, { id: 1, caption: 'one of two?' }], view: 'marks' },
    loadSource: withSource
  })
  const text = describeResult(planned.result)
  assert.match(text, /caption "one of two\?"/)
  assert.match(text, /removed #2/)
  assert.match(text, /1 mark in the record/)
  assert.equal(planned.views[0].kind, 'zoom', 'only one mark was touched, so no sheet')
})

test('show can ask for a map and a cover in one call', async () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), { marks: [{ at: [100, 100], colour: 'green' }] })
  const planned = await planShow({ record, args: { map: true, cover: 'green', target: 400 }, loadSource: withSource })
  assert.deepEqual(planned.views.map((v) => v.kind), ['map', 'cover'])
  assert.ok(planned.views.every((v) => v.width <= 400))
})

test('list is the record as text, one line per mark', () => {
  const { record } = applyMarkArgs(emptyRecord('a.jpg'), {
    marks: [{ at: [10, 20], caption: 'half hidden' }, { box: [1, 2, 3, 4], colour: 'yellow' }]
  })
  const text = describeResult(planList({ record }).result)
  assert.match(text, /a\.jpg — 2 marks in the record/)
  assert.match(text, /#1 point 10,20 r60 green "half hidden"/)
  assert.match(text, /#2 box 1,2,3,4 yellow/)
})
