/**
 * core: what a call means, with no I/O.
 *
 * `plan*` returns `{ record, result, views }`. Views stay out of `result` because
 * `result` is logged and has to be lossless JSON, and a view carries PNG bytes.
 *
 * Every place a caller names is in the picture's own pixels, read off the labelled
 * grid lines. Nothing here, and nothing on the caller's side, converts a scale.
 *
 * @module lib/core
 */

import {
  DEFAULT_COLOUR, applyMarkArgs, applyUpdateArgs, findMark, markPoint, markRect, marksFromArgs,
  applyLookArgs, marksInside, opsFromArgs, removeOps
} from './record.js'
import { TILE, VIEW_TARGET, prepareSource, renderRegion, renderSheet } from './render.js'
import { frameRegion, regionAround, regionOf, regionText } from './views.js'

/** Marks one result lists before it says how many more there are. */
const LIST_LIMIT = 60

/** Rectangles the ledger line names before it counts the rest. */
const LOOK_LINE_LIMIT = 6

/** Rectangles one sheet may hold, so the sheet is not downscaled on its way out. */
export const MAX_SHEET_TILES = 9

/** The shape a sheet's cells should take, from the tiles it will hold. */
const aspectOf = (tiles) =>
  tiles.reduce((sum, tile) => sum + tile.width / tile.height, 0) / Math.max(1, tiles.length)

function stemOf(image) {
  const base = String(image).replace(/\\/g, '/').split('/').pop() ?? 'image'
  return base.replace(/\.[^.]+$/, '') || 'image'
}

function isWhole(region, width, height) {
  return region.x0 <= 0 && region.y0 <= 0 && region.x1 >= width && region.y1 >= height
}

/** `frame-<stem>.png`, or `crop-<x>-<y>-<stem>.png` for a rectangle of the picture. */
function pictureName(kind, region, width, height, image) {
  const stem = stemOf(image)
  if (isWhole(region, width, height)) return `${kind}-${stem}.png`
  return `${kind}-${region.x0}-${region.y0}-${stem}.png`
}

/**
 * The rectangle to draw back after a change: around the places it touched, so the
 * caller sees what it just did without asking to look closer, or the whole picture
 * when those places are spread across it.
 */
function focusRegion(points, source) {
  const whole = frameRegion(source.width, source.height)
  if (points.length === 0) return whole
  const around = regionAround(points)
  const region = regionOf([around.x0, around.y0, around.x1, around.y1], source.width, source.height)
  const spread = (region.x1 - region.x0) > source.width * 0.75 ||
    (region.y1 - region.y0) > source.height * 0.75
  return spread ? whole : region
}

const centresOf = (record, ids) => ids
  .map((id) => (record.marks ?? []).find((mark) => mark.id === id))
  .filter((mark) => mark !== undefined)
  .map((mark) => markPoint(mark))

/**
 * The record, one line per mark: its number, the coordinates it was placed at, its
 * colour and its caption. It states what has been drawn — `marks` never counts what
 * the picture holds — and it is the caller's own record to check.
 */
export function recordLines(record, limit = LIST_LIMIT) {
  const marks = record.marks ?? []
  const lines = marks.slice(0, limit).map((mark) => {
    const [x, y] = markPoint(mark)
    const caption = String(mark.caption ?? '').trim()
    return `#${mark.id} ${x},${y} ${mark.colour ?? DEFAULT_COLOUR}${caption === '' ? '' : ` ${JSON.stringify(caption)}`}`
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

/** The rectangles this picture has been looked at in, with the marks inside each. */
function lookedInside(record) {
  return (record.looks ?? []).map((region) => ({ region, marks: marksInside(record, region) }))
}

/** What every call reports: the picture's size, the rectangle drawn, and the record. */
function baseResult({ record, region, marksShown, width, height, step }) {
  return {
    image: record.image,
    picture: `${width}x${height}`,
    region: regionText(region),
    step: step ?? 0,
    marksShown,
    marks: (record.marks ?? []).length,
    looked: lookedInside(record),
    record: recordLines(record)
  }
}

/** One tile per mark, each drawn around that mark, for a sheet. */
async function tilesFor({ bytes, record, ids, source, bounds }) {
  const tiles = []
  for (const id of ids) {
    const mark = findMark(record, id)
    const rect = markRect(mark)
    const around = regionAround([[rect[0], rect[1]], [rect[2], rect[3]]], 0.8)
    const region = regionOf([around.x0, around.y0, around.x1, around.y1], source.width, source.height)
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
  return tiles
}

/**
 * What a change reports: the places it touched, drawn close enough to check.
 *
 * One rectangle around them when they fit in one. When they are spread across the
 * picture, a tile per mark instead — the whole picture is too coarse to see whether a
 * ring is on its face, and a row of marks across a photograph is exactly that case:
 * one such row came back as a 1400-wide picture, sat 10% off every face, and nothing
 * in the answer said so.
 */
async function feedbackFor({ bytes, record, ids, source, bounds }) {
  const points = centresOf(record, ids)
  const region = focusRegion(points, source)
  if (points.length > 1 && isWhole(region, source.width, source.height)) {
    const tiles = await tilesFor({ bytes, record, ids, source, bounds })
    const sheet = await renderSheet(tiles, { aspect: aspectOf(tiles) })
    const whole = frameRegion(source.width, source.height)
    return {
      region: whole,
      step: 0,
      views: [{
        kind: 'compare',
        name: `check-${tiles.length}-${stemOf(record.image)}.png`,
        label: tiles.map((tile) => tile.label).join(', '),
        png: sheet.png,
        width: sheet.width,
        height: sheet.height,
        region: whole
      }]
    }
  }
  const drawn = await renderRegion(bytes, record, region, { target: VIEW_TARGET, showMarks: true, bounds })
  const kind = isWhole(region, source.width, source.height) ? 'frame' : 'crop'
  return {
    region,
    step: drawn.grid?.step,
    views: [makeView(kind, pictureName(kind, region, source.width, source.height, record.image), drawn)]
  }
}

/** Add marks at the coordinates the caller read off the grid. */
export async function planMark({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const { record: next, result } = applyMarkArgs(record, { marks: marksFromArgs(args, source) })
  const feedback = await feedbackFor({ bytes, record: next, ids: result.marked, source, bounds })
  return {
    record: next,
    views: feedback.views,
    result: {
      ...baseResult({
        record: next,
        region: feedback.region,
        marksShown: true,
        width: source.width,
        height: source.height,
        step: feedback.step
      }),
      marked: result.marked,
      views: viewMeta(feedback.views)
    }
  }
}

/** Move, resize, recaption or recolour marks. */
export async function planEdit({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const { record: next, result } = applyUpdateArgs(record, { ops: opsFromArgs(record, args, source) })
  const touched = Object.keys(result.updated).map(Number)
  const feedback = await feedbackFor({ bytes, record: next, ids: touched, source, bounds })
  return {
    record: next,
    views: feedback.views,
    result: {
      ...baseResult({
        record: next,
        region: feedback.region,
        marksShown: true,
        width: source.width,
        height: source.height,
        step: feedback.step
      }),
      updated: result.updated,
      removed: result.removed,
      views: viewMeta(feedback.views)
    }
  }
}

/** Delete marks by number; the whole picture comes back, so what is left is visible. */
export async function planUnmark({ record, args, loadSource }) {
  const ids = Array.isArray(args?.marks) ? args.marks : []
  if (ids.length === 0) throw new Error('marks must be a non-empty array of mark numbers to delete')
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const region = frameRegion(source.width, source.height)
  const { record: next, result } = applyUpdateArgs(record, { ops: removeOps(ids) })
  const drawn = await renderRegion(bytes, next, region, {
    target: VIEW_TARGET,
    showMarks: true,
    bounds: { width: source.width, height: source.height }
  })
  const views = [makeView('frame', pictureName('frame', region, source.width, source.height, next.image), drawn)]
  return {
    record: next,
    views,
    result: {
      ...baseResult({
        record: next,
        region,
        marksShown: true,
        width: source.width,
        height: source.height,
        step: drawn.grid?.step
      }),
      updated: result.updated,
      removed: result.removed,
      views: viewMeta(views)
    }
  }
}

/**
 * Look: the whole picture, a rectangle of it read off the grid, several marks side
 * by side, or the marks of a colour painted out. The picture comes back without
 * marks unless the caller asks for them, because the picture is what is being read.
 */
export async function planLook({ record, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const bounds = { width: source.width, height: source.height }
  const frame = frameRegion(source.width, source.height)

  // This call's own rectangles belong in its own answer: the ledger the fold will hold
  // once the call commits. Marking behaves the same way — a mark call sees its own marks.
  const noted = applyLookArgs(record, args)
  const base = (region, marksShown, step) => baseResult({
    record: noted, region, marksShown, width: source.width, height: source.height, step
  })

  if (args?.cover !== undefined && args?.cover !== null) {
    // Covering one rectangle at a time is how a caller finishes a band: at the whole
    // picture's size a face that was missed is a few pixels across.
    const region = regionOf(args?.region, source.width, source.height)
    const drawn = await renderRegion(bytes, record, region, { target: VIEW_TARGET, cover: args.cover, bounds })
    const colours = args.cover === 'all' || args.cover === '' ? 'all' : String(args.cover)
    const name = pictureName(`cover-${colours.replace(/[^a-z,]+/gi, '')}`, region,
      source.width, source.height, record.image)
    const views = [makeView('cover', name, drawn)]
    return { record, views, result: { ...base(region, false, drawn.grid?.step), views: viewMeta(views) } }
  }

  // Several rectangles at once: one sheet, each tile labelled with where it came
  // from. This is how a whole picture is swept in a few calls instead of twenty.
  const regions = Array.isArray(args?.regions) ? args.regions : []
  if (regions.length > 0) {
    if (regions.length > MAX_SHEET_TILES) {
      throw new Error(`regions holds at most ${MAX_SHEET_TILES} rectangles, got ${regions.length}: ` +
        'ask for two sheets')
    }
    const marksShown = args?.marks === true
    const tiles = []
    for (const [index, value] of regions.entries()) {
      const region = regionOf(value, source.width, source.height)
      const drawn = await renderRegion(bytes, record, region, { target: TILE, showMarks: marksShown, bounds })
      tiles.push({ ...drawn, label: `#${index + 1} ${regionText(region)}` })
    }
    if (tiles.length === 1) {
      const region = tiles[0].region
      const views = [makeView('crop', pictureName('crop', region, source.width, source.height, record.image), tiles[0])]
      return { record, views, result: { ...base(region, marksShown, tiles[0].grid?.step), views: viewMeta(views) } }
    }
    const sheet = await renderSheet(tiles, { aspect: aspectOf(tiles) })
    const views = [{
      kind: 'compare',
      name: `sheet-${tiles.length}-${stemOf(record.image)}.png`,
      label: tiles.map((tile) => tile.label).join(', '),
      png: sheet.png,
      width: sheet.width,
      height: sheet.height,
      region: frame
    }]
    return { record, views, result: { ...base(frame, marksShown, 0), views: viewMeta(views) } }
  }

  const compare = Array.isArray(args?.compare) ? args.compare : []
  if (compare.length > 0) {
    const tiles = await tilesFor({ bytes, record, ids: compare, source, bounds })
    if (tiles.length === 1) {
      const views = [makeView('compare', `compare-1-${stemOf(record.image)}.png`, tiles[0])]
      return { record, views, result: { ...base(tiles[0].region, true, 0), views: viewMeta(views) } }
    }
    const sheet = await renderSheet(tiles, { aspect: aspectOf(tiles) })
    const views = [{
      kind: 'compare',
      name: `compare-${tiles.length}-${stemOf(record.image)}.png`,
      label: tiles.map((tile) => tile.label).join(', '),
      png: sheet.png,
      width: sheet.width,
      height: sheet.height,
      region: frame
    }]
    return { record, views, result: { ...base(frame, true, 0), views: viewMeta(views) } }
  }

  const region = regionOf(args?.region, source.width, source.height)
  const marksShown = args?.marks === true
  const drawn = await renderRegion(bytes, record, region, { target: VIEW_TARGET, showMarks: marksShown, bounds })
  const kind = isWhole(region, source.width, source.height) ? 'frame' : 'crop'
  const views = [makeView(kind, pictureName(kind, region, source.width, source.height, record.image), drawn)]
  return {
    record,
    views,
    result: { ...base(region, marksShown, drawn.grid?.step), views: viewMeta(views) }
  }
}

/**
 * How the picture in front of the caller relates to the picture's own pixels.
 *
 * The model sees a rendering, and its own sense of size is that rendering: a session
 * read "1540x1084 preview" off the image it was given while every number in the text was
 * in the 2600-pixel space, and concluded the mapping was ambiguous. Saying the ratio costs
 * a few words and removes the guess.
 */
function drawnText(result, view) {
  if (view === undefined) return ''
  const size = `drawn ${view.width}x${view.height}`
  if (view.kind === 'compare') return `${size} as a sheet of tiles, `
  const [x0, , x1] = String(result.region).split(',').map(Number)
  const width = x1 - x0
  if (!Number.isFinite(width) || width <= 0) return `${size}, `
  const scale = view.width / width
  const shown = scale >= 10 ? scale.toFixed(0) : scale.toFixed(scale >= 1 ? 1 : 2)
  return `${size} (${shown}x of the picture), `
}

/** One line for the text beside the picture. */
/** One line for the text beside the picture. */
function tally(result) {
  return `${result.marks} ${result.marks === 1 ? 'mark' : 'marks'} in the record`
}

/**
 * The text the caller reads next to the pictures: what the call changed, the record
 * it changed, and the rectangle it is looking at. It never states a count of what
 * the picture holds, because this package cannot know one.
 */
export function describe(result) {
  const changes = []
  if (Array.isArray(result.marked) && result.marked.length > 0) {
    changes.push(`marked ${result.marked.map((id) => `#${id}`).join(' ')}`)
  }
  if (result.updated && Object.keys(result.updated).length > 0) {
    const what = Object.entries(result.updated).map(([id, touched]) => {
      const parts = []
      // The place it moved to is in the record below, as coordinates.
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

  const lines = [`${result.image} (${result.picture}) — ${changes.length > 0 ? `${changes.join('; ')}; ` : ''}${tally(result)}`]
  const record = result.record ?? []
  if (record.length === 0) lines.push('(no marks yet)')
  else lines.push(...record)
  const grid = result.step > 0 ? `grid every ${result.step} original pixels` : 'no grid'
  const view = (result.views ?? [])[0]
  lines.push(`view ${result.region} — ${drawnText(result, view)}${grid}` +
    `${result.marksShown === true ? ', marks drawn' : ', no marks drawn'}`)
  const looked = result.looked ?? []
  if (looked.length > 0) {
    const shown = looked.slice(0, LOOK_LINE_LIMIT)
    const more = looked.length > shown.length ? ` · +${looked.length - shown.length} more` : ''
    lines.push(`looked: ${shown.map((entry) => `${entry.region} (${entry.marks})`).join(' · ')}${more}`)
    // The checklist a caller cannot keep in its head: a rectangle it has been through
    // and left empty is either finished or forgotten.
    const empty = looked.filter((entry) => entry.marks === 0)
    if (empty.length > 0 && (result.marks ?? 0) > 0) {
      const named = empty.slice(0, 4).map((entry) => entry.region)
      lines.push(`nothing marked inside ${named.join(', ')}` +
        `${empty.length > named.length ? ` and ${empty.length - named.length} more` : ''} yet`)
    }
  }
  // A mark is not in this picture, but it is on the picture: say so, or a caller that
  // never sees its own record drawn concludes the marks were only ever a report.
  if (result.marksShown !== true && (result.marks ?? 0) > 0) {
    const many = result.marks === 1 ? 'mark is' : 'marks are'
    lines.push(`${result.marks} ${many} not drawn here — \`marks: true\` draws them at this scale`)
  }
  // Before anything is marked the loop has not started, and this is the only wording
  // that reaches the moment of decision: sessions that had read the description still
  // looked a dozen times, deciding positions as they went and writing them down last.
  if ((result.marks ?? 0) === 0) {
    lines.push('nothing marked yet — mark a place as you decide it; a mark stays on the picture')
  }

  const paths = new Map((result.images ?? []).map((image) => [image.name, image.path]))
  const pictures = (result.views ?? []).map((view) => {
    const path = paths.get(view.name)
    return `${path ?? view.name} (${view.width}x${view.height})`
  })
  if (pictures.length > 0) lines.push(`saved as ${pictures.join(', ')}`)
  return lines.join('\n')
}
