/**
 * core: what a call means, with no I/O.
 *
 * `plan*` returns `{ record, result, views }`. Views stay out of `result` because
 * `result` is logged and has to be lossless JSON, and a view carries PNG bytes.
 *
 * Everything a caller says about a place is said in the terms of the view it was
 * last shown — a cell name, or a fraction of that view — so nothing here makes a
 * caller convert between picture coordinates and what it sees.
 *
 * @module lib/core
 */

import {
  DEFAULT_COLOUR, applyMarkArgs, applyUpdateArgs, findMark, markPoint, markRect, marksFromArgs,
  opsFromArgs, removeOps
} from './record.js'
import {
  TILE, VIEW_TARGET, frameRegion, prepareSource, regionAround, renderRegion, renderSheet
} from './render.js'
import {
  cellOf, cellRegion, cellsRegion, cellsSpec, describeGrid, gridFor, regionToken, viewRegion
} from './views.js'

/** Marks one result lists before it says how many more there are. */
const LIST_LIMIT = 60

function stemOf(image) {
  const base = String(image).replace(/\\/g, '/').split('/').pop() ?? 'image'
  return base.replace(/\.[^.]+$/, '') || 'image'
}

function isFrame(region, width, height) {
  return region.x0 <= 0 && region.y0 <= 0 && region.x1 >= width && region.y1 >= height
}

function kindOf(region, width, height) {
  return isFrame(region, width, height) ? 'frame' : 'cell'
}

/** `frame-<stem>.png`, or `cell-C3-<stem>.png` when the region is exactly a cell. */
function pictureName(prefix, region, width, height, image) {
  const stem = stemOf(image)
  if (isFrame(region, width, height)) return `${prefix}-${stem}.png`
  const frame = frameRegion(width, height)
  const grid = gridFor(frame)
  for (let col = 0; col < grid.cols; col++) {
    for (let row = 0; row < grid.rows; row++) {
      const label = `${grid.columns[col]}${row + 1}`
      const cell = cellRegion(frame, grid, label)
      if (Math.abs(cell.x0 - region.x0) < 1 && Math.abs(cell.y0 - region.y0) < 1 &&
        Math.abs(cell.x1 - region.x1) < 1 && Math.abs(cell.y1 - region.y1) < 1) {
        return `${prefix}-${label}-${stem}.png`
      }
    }
  }
  return `${prefix}-${stem}.png`
}

/**
 * The cell or block a caller points at, named in the grid of the view it was shown
 * and checked against that grid before anything is drawn.
 */
function cellsAt(spec, region) {
  return cellsSpec(spec, gridFor(region))
}

/**
 * The record, one line per mark, each named by the cell of the whole picture's
 * grid it falls in. It states what has been drawn: `marks` never counts what the
 * picture holds, and the two numbers are allowed to differ.
 */
export function recordLines(record, width, height, limit = LIST_LIMIT) {
  const region = frameRegion(width, height)
  const grid = gridFor(region)
  const marks = record.marks ?? []
  const lines = marks.slice(0, limit).map((mark) => {
    const caption = String(mark.caption ?? '').trim()
    const cell = cellOf(markPoint(mark), region, grid)
    return `#${mark.id} ${cell} ${mark.colour ?? DEFAULT_COLOUR}${caption === '' ? '' : ` ${JSON.stringify(caption)}`}`
  })
  if (marks.length > limit) lines.push(`…and ${marks.length - limit} more`)
  return lines
}

function viewMeta(views) {
  return views.map((view) => ({
    kind: view.kind,
    name: view.name,
    label: view.label ?? '',
    width: view.width,
    height: view.height
  }))
}

function makeView(kind, name, drawn, label = '') {
  return {
    kind,
    name,
    label,
    png: drawn.png,
    width: drawn.width,
    height: drawn.height,
    region: drawn.region
  }
}

/** What every call reports: the record, the handle, and the name of its grid. */
function baseResult({ record, region, marksShown, width, height }) {
  return {
    image: record.image,
    marks: record.marks.length,
    view: regionToken(region),
    grid: describeGrid(gridFor(region)),
    marksShown,
    record: recordLines(record, width, height)
  }
}

/** Add marks to the view the caller is looking at. */
export async function planMark({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const region = viewRegion(args, source.width, source.height)
  const { record: next, result } = applyMarkArgs(record, { marks: marksFromArgs(args) })
  const drawn = await renderRegion(bytes, next, region, {
    target: VIEW_TARGET,
    showMarks: true,
    bounds
  })
  const kind = kindOf(region, source.width, source.height)
  const views = [makeView(kind, pictureName(kind, region, source.width, source.height, next.image), drawn)]
  return {
    record: next,
    views,
    result: {
      ...baseResult({ record: next, region, marksShown: true, width: source.width, height: source.height }),
      marked: result.marked,
      views: viewMeta(views)
    }
  }
}

/** Move, recaption, recolour or resize marks. */
export async function planEdit({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const region = viewRegion(args, source.width, source.height)
  const { record: next, result } = applyUpdateArgs(record, { ops: opsFromArgs(record, args) })
  const drawn = await renderRegion(bytes, next, region, {
    target: VIEW_TARGET,
    showMarks: true,
    bounds
  })
  const kind = kindOf(region, source.width, source.height)
  const views = [makeView(kind, pictureName(kind, region, source.width, source.height, next.image), drawn)]
  return {
    record: next,
    views,
    result: {
      ...baseResult({ record: next, region, marksShown: true, width: source.width, height: source.height }),
      updated: result.updated,
      removed: result.removed,
      views: viewMeta(views)
    }
  }
}

/** Delete marks by number; the whole picture comes back, so what is left is visible. */
export async function planUnmark({ record, args, loadSource }) {
  const ids = Array.isArray(args?.marks) ? args.marks : []
  if (ids.length === 0) throw new Error('marks must be a non-empty array of mark numbers to delete')
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const region = frameRegion(source.width, source.height)
  const { record: next, result } = applyUpdateArgs(record, { ops: removeOps(ids) })
  const drawn = await renderRegion(bytes, next, region, { target: VIEW_TARGET, showMarks: true, bounds })
  const views = [makeView('frame', pictureName('frame', region, source.width, source.height, next.image), drawn)]
  return {
    record: next,
    views,
    result: {
      ...baseResult({ record: next, region, marksShown: true, width: source.width, height: source.height }),
      updated: result.updated,
      removed: result.removed,
      views: viewMeta(views)
    }
  }
}

/**
 * Look: the whole picture, one cell of it closer, several marks side by side, or
 * the marks of a colour painted out. The picture comes back without marks unless
 * the caller asks for them, because what is being read is the picture.
 */
export async function planLook({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const frame = frameRegion(source.width, source.height)

  const base = (region, marksShown) => baseResult({
    record, region, marksShown, width: source.width, height: source.height
  })

  if (args?.cover !== undefined && args?.cover !== null) {
    const drawn = await renderRegion(bytes, record, frame, { target: VIEW_TARGET, cover: args.cover, bounds })
    const colours = args.cover === 'all' || args.cover === '' ? 'all' : String(args.cover)
    const views = [makeView('cover', `cover-${colours.replace(/[^a-z,]+/gi, '')}-${stemOf(record.image)}.png`, drawn)]
    return { record, views, result: { ...base(frame, false), views: viewMeta(views) } }
  }

  const compare = Array.isArray(args?.compare) ? args.compare : []
  if (compare.length > 0) {
    const tiles = []
    for (const id of compare) {
      const mark = findMark(record, id)
      const region = regionAround(markRect(mark), 1.8)
      const drawn = await renderRegion(bytes, record, region, {
        target: TILE,
        showMarks: true,
        grid: false,
        skipLabelFor: mark.id,
        bounds
      })
      const caption = String(mark.caption ?? '').trim()
      tiles.push({ ...drawn, label: caption === '' ? `#${mark.id}` : `#${mark.id} ${caption}` })
    }
    if (tiles.length === 1) {
      const views = [makeView('compare', `compare-1-${stemOf(record.image)}.png`, tiles[0])]
      return { record, views, result: { ...base(tiles[0].region, true), views: viewMeta(views) } }
    }
    const sheet = await renderSheet(tiles)
    const views = [{
      kind: 'compare',
      name: `compare-${tiles.length}-${stemOf(record.image)}.png`,
      label: tiles.map((tile) => tile.label).join(', '),
      png: sheet.png,
      width: sheet.width,
      height: sheet.height,
      region: frame
    }]
    return { record, views, result: { ...base(frame, true), views: viewMeta(views) } }
  }

  const region = viewRegion(args, source.width, source.height)
  const marksShown = args?.marks === true
  if (args?.cell !== undefined && args?.cell !== null) {
    const cell = cellsAt(args.cell, region)
    const closer = cellsRegion(region, gridFor(region), cell)
    const drawn = await renderRegion(bytes, record, closer, {
      target: VIEW_TARGET,
      showMarks: marksShown,
      label: cell,
      bounds
    })
    const kind = cell.includes('-') ? 'block' : 'cell'
    const name = kind === 'block'
      ? `block-${cell}-${stemOf(record.image)}.png`
      : pictureName(kind, closer, source.width, source.height, record.image)
    const views = [makeView(kind, name, drawn, cell)]
    return { record, views, result: { ...base(closer, marksShown), views: viewMeta(views) } }
  }

  const kind = kindOf(region, source.width, source.height)
  const drawn = await renderRegion(bytes, record, region, {
    target: VIEW_TARGET,
    showMarks: marksShown,
    bounds
  })
  const views = [makeView(kind, pictureName(kind, region, source.width, source.height, record.image), drawn)]
  return { record, views, result: { ...base(region, marksShown), views: viewMeta(views) } }
}

/** One line for the text beside the picture. */
function tally(result) {
  return `${result.marks} ${result.marks === 1 ? 'mark' : 'marks'} in the record`
}

/**
 * The text the caller reads next to the pictures: what the call changed, the
 * record it changed, and the handle of the view it is looking at. It never states
 * a count of what the picture holds, because this package cannot know one.
 */
export function describe(result) {
  const changes = []
  if (Array.isArray(result.marked) && result.marked.length > 0) {
    changes.push(`marked ${result.marked.map((id) => `#${id}`).join(' ')}`)
  }
  if (result.updated && Object.keys(result.updated).length > 0) {
    const what = Object.entries(result.updated).map(([id, touched]) => {
      const parts = []
      // The place it moved to is in the record below, as a cell; a caller that
      // never handles coordinates is not shown any.
      if (touched.move) parts.push('moved')
      if (touched.r !== undefined) parts.push('resized')
      if (touched.caption !== undefined) parts.push(`caption ${JSON.stringify(touched.caption)}`)
      if (touched.colour !== undefined) parts.push(`colour ${touched.colour}`)
      return `#${id} ${parts.join(', ')}`
    })
    changes.push(`edited ${what.join('; ')}`)
  }
  if (Array.isArray(result.removed) && result.removed.length > 0) {
    changes.push(`removed ${result.removed.map((id) => `#${id}`).join(' ')}`)
  }

  const lines = [`${result.image} — ${changes.length > 0 ? `${changes.join('; ')}; ` : ''}${tally(result)}`]
  const record = result.record ?? []
  if (record.length === 0) lines.push('(no marks yet)')
  else lines.push(...record)
  lines.push(`view ${result.view} (copy this as "view") — grid ${result.grid}` +
    `${result.marksShown === true ? ', marks drawn' : ', no marks drawn'}`)

  const paths = new Map((result.images ?? []).map((image) => [image.name, image.path]))
  // Named as a file for the reader, never as a handle: "picture: frame-…png" once
  // had a caller pass the file name back as its view.
  const pictures = (result.views ?? []).map((view) => {
    const path = paths.get(view.name)
    return `${path ?? view.name} (${view.width}x${view.height})`
  })
  if (pictures.length > 0) lines.push(`saved as ${pictures.join(', ')}`)
  return lines.join('\n')
}
