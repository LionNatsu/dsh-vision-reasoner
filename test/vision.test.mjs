/**
 * The record, the views and the shared call layer.
 *
 * About invariants, not snapshots: a place is named by a cell of the view a caller
 * was shown, a call replays from its own arguments alone, and no result states a
 * count of what the picture holds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import sharp from 'sharp'

import { applyMarkArgs, applyToolArgs, emptyRecord, markRect } from '../lib/record.js'
import {
  SIZES, cellOf, cellRegion, cellsRegion, cellsSpec, describeGrid, gridFor, parseCell, parseRegion,
  placeOn, radiusFor, regionToken, viewRegion
} from '../lib/views.js'
import { VIEW_TARGET, clampRegion, frameRegion, renderRegion, viewOf } from '../lib/render.js'
import {
  describe as describeResult, planEdit, planLook, planMark, planUnmark, recordLines
} from '../lib/core.js'

const WIDTH = 1200
const HEIGHT = 800

/** A flat, dark scene: anything drawn over it stands out. */
async function scene(width = WIDTH, height = HEIGHT) {
  const channels = 3
  const data = Buffer.alloc(width * height * channels)
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 40
    data[i + 1] = 44
    data[i + 2] = 52
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer()
}

async function source(width = WIDTH, height = HEIGHT) {
  return { bytes: await scene(width, height), width, height, orientation: 1 }
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

const frame = () => frameRegion(WIDTH, HEIGHT)
const token = () => regionToken(frame())

// ---------------------------------------------------------------- geometry

test('the grid follows the shape of the view instead of assuming one', () => {
  const wide = gridFor({ x0: 0, y0: 0, x1: 1200, y1: 800 })
  const tall = gridFor({ x0: 0, y0: 0, x1: 800, y1: 1200 })
  assert.ok(wide.cols > wide.rows, 'a wide view gets more columns than rows')
  assert.ok(tall.rows > tall.cols, 'a tall view gets more rows than columns')
  assert.equal(describeGrid(wide), '10x7 A-J 1-7')
  assert.equal(describeGrid(tall), '7x10 A-G 1-10')
  // Cells stay close to square whatever the view's shape.
  for (const region of [
    { x0: 0, y0: 0, x1: 1200, y1: 800 },
    { x0: 0, y0: 0, x1: 800, y1: 1200 },
    { x0: 0, y0: 0, x1: 3000, y1: 200 },
    { x0: 0, y0: 0, x1: 200, y1: 3000 },
    { x0: 200, y0: 100, x1: 460, y1: 356 }
  ]) {
    const grid = gridFor(region)
    const across = (region.x1 - region.x0) / grid.cols
    const down = (region.y1 - region.y0) / grid.rows
    const ratio = Math.max(across, down) / Math.min(across, down)
    assert.ok(ratio < 3, `${describeGrid(grid)} has cells ${ratio.toFixed(2)}:1`)
  }
})

test('a cell is named, checked, and turned into a place', () => {
  const region = frame()
  const grid = gridFor(region)
  const cell = cellRegion(region, grid, 'C3')
  assert.ok(Number.isInteger(cell.x0) && Number.isInteger(cell.y0), 'a cell is whole pixels')
  assert.ok(Number.isInteger(cell.x1) && Number.isInteger(cell.y1))
  assert.ok(cell.x0 >= 0 && cell.x1 <= WIDTH && cell.y0 >= 0 && cell.y1 <= HEIGHT)
  assert.deepEqual(placeOn('C3', region, grid), [
    Math.round((cell.x0 + cell.x1) / 2),
    Math.round((cell.y0 + cell.y1) / 2)
  ])
  assert.equal(cellOf(placeOn('C3', region, grid), region, grid), 'C3', 'a cell centre names that cell')
  assert.equal(cellOf(placeOn('c3', region, grid), region, grid), 'C3', 'the name is read as written')
  assert.throws(() => parseCell('Z9', grid), /outside this view, which is 10x7 A-J 1-7/)
  assert.throws(() => parseCell('C3!', grid), /cell must be a name like "C3"/)
})

test('a block of cells is a region named off the same grid', () => {
  const region = frame()
  const grid = gridFor(region)
  assert.deepEqual(cellsRegion(region, grid, 'C3'), cellRegion(region, grid, 'C3'))
  // A1-C4 on a 10x7 grid over 1200x800: three columns, four rows.
  assert.deepEqual(cellsRegion(region, grid, 'A1-C4'), { x0: 0, y0: 0, x1: 360, y1: 457 })
  assert.deepEqual(cellsRegion(region, grid, 'A1-C4'), cellsRegion(region, grid, 'C4-A1'),
    'either corner may be named first')
  assert.equal(cellsSpec('a1-c4', grid), 'A1-C4')
  assert.equal(cellsSpec('c3', grid), 'C3')
  assert.throws(() => cellsSpec('A1-B2-C3', grid), /cell must be a name like "C3" or a block like "A1-C4"/)
  assert.throws(() => cellsSpec('A1-Z9', grid), /outside this view/)
  // A block is for looking at, not for placing: a mark is one cell.
  assert.throws(() => placeOn('A1-C4', region, grid), /cell must be a name like "C3"/)
})

test('a handle reproduces the region exactly, and holds no letters', () => {
  const region = cellRegion(frame(), gridFor(frame()), 'C3')
  const handle = regionToken(region)
  assert.match(handle, /^[0-9]+,[0-9]+,[0-9]+,[0-9]+$/)
  assert.deepEqual(parseRegion(handle), region)
  assert.deepEqual(parseRegion(regionToken(frame())), frame())
  assert.throws(() => parseRegion('0,0'), /view must be a rectangle copied from an earlier result/)
  assert.throws(() => parseRegion('0,0,0,0'), /view must be a rectangle copied from an earlier result/)
})

test('a view is what a call is looking at, or it is refused', () => {
  assert.deepEqual(viewRegion({ view: '240,229,360,343' }), { x0: 240, y0: 229, x1: 360, y1: 343 })
  assert.deepEqual(viewRegion({}, 1200, 800), frame(), 'no handle, known picture: the whole picture')
  assert.throws(() => viewRegion({}), /this call needs "view"/)
})

test('a ring size is something the caller can see, not a radius', () => {
  const region = frame()
  const small = radiusFor('s', region)
  const medium = radiusFor('m', region)
  const large = radiusFor('l', region)
  assert.ok(small < medium && medium < large)
  assert.equal(medium, Math.round(HEIGHT * SIZES.m))
  assert.equal(radiusFor(undefined, region), medium, 'medium is the default')
  assert.throws(() => radiusFor('xl', region), /size must be one of s, m, l/)
})

// ---------------------------------------------------------------- record from args

test('a mark is placed by the cell of the view it was shown', () => {
  const grid = gridFor(frame())
  const marked = applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    image: 'a.png',
    view: token(),
    marks: [{ cell: 'C3', caption: 'one' }]
  })
  assert.equal(marked.marks.length, 1)
  assert.deepEqual([marked.marks[0].x, marked.marks[0].y], placeOn('C3', frame(), grid))
  assert.equal(marked.marks[0].r, radiusFor(undefined, frame()))
  assert.equal(marked.marks[0].caption, 'one')
})

test('a call replays from its arguments alone', () => {
  const args = {
    image: 'a.png',
    view: regionToken(cellRegion(frame(), gridFor(frame()), 'C3')),
    marks: [{ cell: 'B2', size: 'l', colour: 'yellow' }, { cell: 'D4', caption: 'two' }]
  }
  assert.deepEqual(
    applyToolArgs(emptyRecord('a.png'), 'vision_mark', args),
    applyToolArgs(emptyRecord('a.png'), 'vision_mark', args)
  )
  // The same call shape is what the log replays, so a mark on a closer view lands
  // where that closer view's own grid said.
  const closer = parseRegion(args.view)
  const marked = applyToolArgs(emptyRecord('a.png'), 'vision_mark', args)
  assert.deepEqual([marked.marks[0].x, marked.marks[0].y], placeOn('B2', closer, gridFor(closer)))
})

test('a call without the view it was shown is refused', () => {
  assert.throws(() => applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    image: 'a.png',
    marks: [{ cell: 'C3' }]
  }), /this call needs "view"/)
  assert.throws(() => applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    image: 'a.png',
    view: token(),
    marks: [{ cell: 'Z9' }]
  }), /outside this view/)
  assert.throws(() => applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    image: 'a.png',
    view: token(),
    marks: [{ size: 'm' }]
  }), /cell must be a name like "C3"/)
})

test('a move names a cell; a box keeps its own extent', () => {
  const grid = gridFor(frame())
  const point = applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    view: token(),
    marks: [{ cell: 'A1' }]
  })
  const moved = applyToolArgs(point, 'vision_edit', { view: token(), ops: [{ id: 1, move: 'G6' }] })
  assert.deepEqual([moved.marks[0].x, moved.marks[0].y], placeOn('G6', frame(), grid))

  const boxed = applyMarkArgs(emptyRecord('a.png'), { marks: [{ box: [100, 100, 200, 200] }] }).record
  const shifted = applyToolArgs(boxed, 'vision_edit', { view: token(), ops: [{ id: 1, move: 'G6' }] })
  const rect = markRect(shifted.marks[0])
  assert.deepEqual(
    [Math.round((rect[0] + rect[2]) / 2), Math.round((rect[1] + rect[3]) / 2)],
    placeOn('G6', frame(), grid),
    'the box moved so that its centre is the cell'
  )
  assert.equal(rect[2] - rect[0], 100, 'and it kept its extent')

  const edited = applyToolArgs(point, 'vision_edit', { ops: [{ id: 1, caption: 'no view needed' }] })
  assert.equal(edited.marks[0].caption, 'no view needed')
  assert.throws(() => applyToolArgs(point, 'vision_edit', { ops: [{ id: 1, move: 'A1' }] }), /needs "view"/)
})

test('the record is listed by the cell of the whole picture', () => {
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    view: token(),
    marks: [{ cell: 'A1' }, { cell: 'J7', colour: 'red', caption: 'last' }]
  })
  assert.deepEqual(recordLines(record, WIDTH, HEIGHT), ['#1 A1 green', '#2 J7 red "last"'])
  assert.deepEqual(recordLines(record, WIDTH, HEIGHT, 1), ['#1 A1 green', '…and 1 more'])
  assert.deepEqual(recordLines(emptyRecord('a.png'), WIDTH, HEIGHT), [])
})

// ---------------------------------------------------------------- drawing

test('a region that runs off the picture is trimmed, not refused', () => {
  const trimmed = clampRegion({ x0: -50, y0: 700, x1: 300, y1: 1100 }, { width: WIDTH, height: HEIGHT })
  assert.deepEqual(trimmed, { x0: 0, y0: 700, x1: 300, y1: HEIGHT })
  assert.deepEqual(clampRegion({ x0: 10, y0: 10, x1: 20, y1: 20 }, { width: WIDTH, height: HEIGHT }),
    { x0: 10, y0: 10, x1: 20, y1: 20 })
})

test('a closer look magnifies, and carries its own grid', async () => {
  const src = await source()
  const cell = cellRegion(frame(), gridFor(frame()), 'C3')
  const frameView = viewOf(frame(), VIEW_TARGET)
  const cellView = viewOf(cell, VIEW_TARGET)
  assert.ok(cellView.sx > frameView.sx * 3,
    `the closer view is only ${(cellView.sx / frameView.sx).toFixed(1)}x the frame`)
  // A block that spans most of the picture is never coarser than the picture.
  const blockView = viewOf(cellsRegion(frame(), gridFor(frame()), 'B1-I3'), VIEW_TARGET)
  assert.ok(blockView.sx >= frameView.sx,
    `a block came back at ${(blockView.sx / frameView.sx).toFixed(2)}x the frame`)

  const drawn = await renderRegion(src.bytes, emptyRecord('a.png'), cell, { target: 900, bounds: src })
  assert.deepEqual(drawn.region, cell, 'the drawn region is what the handle names')
  const grid = gridFor(cell)
  assert.equal(drawn.grid.cols, grid.cols)
  const image = await pixels(drawn.png)
  // The first cell boundary is drawn; eight pixels away is plain picture.
  const at = Math.round(drawn.width / grid.cols)
  const middle = Math.round(drawn.height / 2)
  const boundary = image.at(at, middle)
  const away = image.at(at + 8, middle)
  assert.ok(boundary[1] > away[1] + 20 && boundary[2] > away[2] + 20,
    `no cell line at ${at}: ${boundary.slice(0, 3)} against ${away.slice(0, 3)}`)
})

test('the picture is drawn without the marks unless they are asked for', async () => {
  const src = await source()
  const record = applyMarkArgs(emptyRecord('a.png'), { marks: [{ at: [300, 200], r: 60, colour: 'red' }] }).record
  const reds = async (png) => {
    const image = await pixels(png)
    let count = 0
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const [r, g, b] = image.at(x, y)
        if (r > 170 && g < 120 && b < 120) count++
      }
    }
    return count
  }
  const plain = await renderRegion(src.bytes, record, frame(), { target: 600, bounds: src })
  const shown = await renderRegion(src.bytes, record, frame(), { target: 600, bounds: src, showMarks: true })
  assert.equal(await reds(plain.png), 0, 'nothing is drawn over the picture by default')
  assert.ok(await reds(shown.png) > 100, 'the ring is there when it is asked for')
})

// ---------------------------------------------------------------- calls

test('looking returns the handle, the grid and the record', async () => {
  const src = await source()
  const looked = await planLook({ record: emptyRecord('a.png'), args: { image: 'a.png' }, loadSource: async () => src })
  assert.equal(looked.result.view, token())
  assert.equal(looked.result.grid, '10x7 A-J 1-7')
  assert.equal(looked.result.marksShown, false)
  assert.deepEqual(looked.result.record, [])
  assert.equal(looked.views[0].name, 'frame-a.png')
  const text = describeResult(looked.result)
  assert.match(text, /\(no marks yet\)/)
  assert.match(text, new RegExp(`view ${token()} — grid 10x7 A-J 1-7, no marks drawn`))
})

test('looking closer keeps that cell as the handle', async () => {
  const src = await source()
  const looked = await planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', view: token(), cell: 'C3' },
    loadSource: async () => src
  })
  assert.deepEqual(parseRegion(looked.result.view), cellRegion(frame(), gridFor(frame()), 'C3'))
  assert.equal(looked.result.grid, '9x8 A-I 1-8')
  assert.equal(looked.views[0].name, 'cell-C3-a.png')

  // A cell of that closer view can be looked at in turn.
  const deeper = await planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', view: looked.result.view, cell: 'A1' },
    loadSource: async () => src
  })
  const closer = parseRegion(looked.result.view)
  assert.deepEqual(parseRegion(deeper.result.view), cellRegion(closer, gridFor(closer), 'A1'))
})

test('a block of cells comes back as one view of that block', async () => {
  const src = await source()
  const looked = await planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', view: token(), cell: 'a1-c4' },
    loadSource: async () => src
  })
  assert.deepEqual(parseRegion(looked.result.view), cellsRegion(frame(), gridFor(frame()), 'A1-C4'))
  assert.equal(looked.views[0].name, 'block-A1-C4-a.png')
  assert.equal(looked.views[0].label, 'A1-C4')
  assert.match(looked.result.grid, /^[0-9]+x[0-9]+ [A-Z]+-[A-Z]+ 1-[0-9]+$/)
})

test('marking needs the view it was shown, and comes back with the record', async () => {
  const src = await source()
  const marked = await planMark({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', view: token(), marks: [{ cell: 'C3', caption: 'one' }] },
    loadSource: async () => src
  })
  assert.deepEqual(marked.result.marked, [1])
  assert.deepEqual(marked.result.record, ['#1 C3 green "one"'])
  assert.equal(marked.result.marksShown, true)
  assert.equal(marked.result.view, token(), 'a mark comes back with the view it was placed on')
  const text = describeResult(marked.result)
  assert.match(text, /marked #1; 1 mark in the record/)
  assert.doesNotMatch(text, /people|person/i)

  await assert.rejects(() => planMark({
    record: emptyRecord('a.png'),
    args: { image: 'a.png', marks: [{ cell: 'C3' }] },
    loadSource: async () => src
  }), /this call needs "view"/)
})

test('an edit and a removal come back with the picture and the record', async () => {
  const src = await source()
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    view: token(),
    marks: [{ cell: 'A1', caption: 'one' }, { cell: 'J7', caption: 'two' }]
  })
  const edited = await planEdit({
    record,
    args: { image: 'a.png', view: token(), ops: [{ id: 1, move: 'C3', colour: 'yellow' }] },
    loadSource: async () => src
  })
  assert.equal(edited.record.marks[0].colour, 'yellow')
  const text = describeResult(edited.result)
  assert.match(text, /edited #1 moved, colour yellow/)
  assert.match(text, /#1 C3 yellow "one"/)
  assert.doesNotMatch(text, /moved to [0-9]/, 'the caller is never shown coordinates')

  const unmarked = await planUnmark({
    record: edited.record,
    args: { image: 'a.png', marks: [2] },
    loadSource: async () => src
  })
  assert.deepEqual(unmarked.result.removed, [2])
  assert.deepEqual(unmarked.result.record, ['#1 C3 yellow "one"'])
  assert.equal(unmarked.result.view, token(), 'a removal comes back with the whole picture')
  await assert.rejects(() => planUnmark({
    record: edited.record,
    args: { image: 'a.png', marks: [] },
    loadSource: async () => src
  }), /non-empty array/)
  await assert.rejects(() => planUnmark({
    record: edited.record,
    args: { image: 'a.png', marks: [9] },
    loadSource: async () => src
  }), /no mark #9/)
})

test('a comparison puts marks side by side, and cover paints a colour out', async () => {
  const src = await source()
  const record = applyToolArgs(emptyRecord('a.png'), 'vision_mark', {
    view: token(),
    marks: [{ cell: 'C3', colour: 'green' }, { cell: 'G5', colour: 'red' }]
  })
  const compare = await planLook({ record, args: { image: 'a.png', compare: [1, 2] }, loadSource: async () => src })
  assert.equal(compare.views[0].kind, 'compare')
  assert.equal(compare.views[0].name, 'compare-2-a.png')
  assert.match(compare.views[0].label, /#1.*#2/)
  assert.match(describeResult(compare.result), /compare-2-a\.png/)

  const cover = await planLook({ record, args: { image: 'a.png', cover: 'green' }, loadSource: async () => src })
  assert.equal(cover.views[0].kind, 'cover')
  assert.equal(cover.result.marksShown, false)
  assert.equal(cover.views[0].name, 'cover-green-a.png')
  await assert.rejects(() => planLook({
    record,
    args: { image: 'a.png', cover: 'purple' },
    loadSource: async () => src
  }), /unknown colour\(s\) purple/)
})

test('a picture that is not there fails on the name it was given', async () => {
  await assert.rejects(() => planLook({
    record: emptyRecord('a.png'),
    args: { image: 'a.png' },
    loadSource: async () => { throw new Error('cannot read "a.png": no such file') }
  }), /cannot read "a\.png"/)
})
