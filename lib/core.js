/**
 * core: what a call means, with no I/O.
 *
 * `plan*` returns `{ record, result, views }`. Views stay out of `result` because `result`
 * is logged and has to be lossless JSON, and a view carries PNG bytes.
 *
 * There is one view shape: a square window on the picture. Every place a caller names is in
 * the picture's own pixels, read off the labelled grid lines. Nothing here, and nothing on
 * the caller's side, converts a scale.
 *
 * @module lib/core
 */

import {
  DEFAULT_COLOUR, commitCall, markPoint
} from './record.js'
import { resolveCamera, sweepState } from './camera.js'
import { prepareSource, renderWindow, VIEW_SIDE } from './render.js'

/** Marks one result lists before it says how many more there are. */
const LIST_LIMIT = 60

function stemOf(image) {
  const base = String(image).replace(/\\/g, '/').split('/').pop() ?? 'image'
  return base.replace(/\.[^.]+$/, '') || 'image'
}

/** `picture-<stem>.png` for a window holding the whole picture, `window-<x>-<y>-<side>-<stem>.png`
 *  otherwise — the side is in the name because two windows over one corner are two pictures. */
function pictureName(window, width, height, image, whole) {
  const stem = stemOf(image)
  if (whole) return `picture-${stem}.png`
  return `window-${window.x0}-${window.y0}-${window.side}-${stem}.png`
}

/**
 * The record, one line per mark: its number, the coordinates it was placed at, its colour
 * and its caption. It states what has been drawn — `marks` never counts what the picture
 * holds — and it is the caller's own record to check.
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

function makeView(kind, name, drawn, window, label = '') {
  return {
    kind,
    name,
    label,
    png: drawn.png,
    width: drawn.width,
    height: drawn.height,
    region: { x0: window.x0, y0: window.y0, x1: window.x1, y1: window.y1 }
  }
}

/** "bottom right", "middle left", or a plain count when the grid is a long one. */
function cellWords(cell, across, down) {
  const column = across === 1 ? null
    : across === 2 ? (cell.i === 0 ? 'left' : 'right')
      : across === 3 ? ['left', 'middle', 'right'][cell.i]
        : `column ${cell.i + 1} of ${across}`
  const row = down === 1 ? null
    : down === 2 ? (cell.j === 0 ? 'top' : 'bottom')
      : down === 3 ? ['top', 'middle', 'bottom'][cell.j]
        : `row ${cell.j + 1} of ${down}`
  return [row, column].filter(Boolean).join(' ') || 'the only window'
}

/** The sweep, in words: how much is done, where the camera is in it, and what is left. */
export function sweepLine(sweep) {
  if (sweep.total === 1) {
    return 'the whole picture is one window · `camera_zoom_in` to sweep it in windows'
  }
  const parts = [`${sweep.seen} of ${sweep.total} windows looked at`]
  parts.push(`this one is ${cellWords(sweep.here, sweep.across, sweep.down)}`)
  if (sweep.missing.length > 0) {
    const named = sweep.missing.slice(0, 3).map((cell) => cellWords(cell, sweep.across, sweep.down))
    const more = sweep.missing.length > named.length ? ` and ${sweep.missing.length - named.length} more` : ''
    parts.push(`not yet: ${named.join(', ')}${more}`)
  }
  return parts.join(' · ')
}

/**
 * What every call reports: the picture's size, the window it was seen through, the sweep,
 * and the record. `scale` is stated because a caller that guesses it from a rendering goes
 * wrong: one session read "1540x1084 preview" off a downscaled copy while every number in
 * the text was in the 2600-pixel space, and concluded the mapping was ambiguous.
 */
function baseResult({ record, window, whole, width, height, step, sweep, marksShown }) {
  const scale = window.side > 0 ? VIEW_SIDE / window.side : 1
  const shown = scale >= 10 ? scale.toFixed(0) : scale.toFixed(scale >= 1 ? 1 : 2)
  return {
    image: record.image,
    picture: `${width}x${height}`,
    window: `${window.x0},${window.y0},${window.x1},${window.y1}`,
    side: window.side,
    whole,
    scale: `${shown}x`,
    step: step ?? 0,
    marksShown,
    marks: (record.marks ?? []).length,
    sweep: sweepLine(sweep),
    record: recordLines(record)
  }
}

/**
 * The one plan every tool uses: commit the call, resolve the camera where the call left it,
 * and render that window. A camera call and a mark call differ only in what they commit, so
 * what the caller sees afterwards is decided in one place.
 */
async function plan({ record, tool, args, loadSource }) {
  const source = await loadSource()
  const bytes = await prepareSource(source.bytes, source.orientation)
  const size = { width: source.width, height: source.height }
  const committed = commitCall(record, tool, args, size)
  const camera = committed.record.camera ?? []
  const window = resolveCamera(camera, size.width, size.height)
  const whole = window.side >= Math.max(size.width, size.height)
  const marksShown = args?.marks !== false
  const drawn = await renderWindow(bytes, committed.record, window, { picture: size, marks: marksShown })
  const sweep = sweepState(camera, size.width, size.height)
  const view = makeView(whole ? 'picture' : 'window',
    pictureName(window, size.width, size.height, record.image, whole), drawn, window)
  return {
    record: committed.record,
    views: [view],
    result: {
      ...baseResult({
        record: committed.record, window, whole, width: size.width, height: size.height,
        step: drawn.grid?.step, sweep, marksShown
      }),
      ...committed.result,
      views: viewMeta([view])
    }
  }
}

/** A camera action: the window it leaves the camera on, with the grid and the sweep. */
export const planCamera = (tool) => ({ record, args, loadSource }) =>
  plan({ record, tool, args, loadSource })

export const planMark = ({ record, args, loadSource }) =>
  plan({ record, tool: 'mark_add', args, loadSource })

export const planEdit = ({ record, args, loadSource }) =>
  plan({ record, tool: 'mark_edit', args, loadSource })

export const planUnmark = ({ record, args, loadSource }) =>
  plan({ record, tool: 'mark_remove', args, loadSource })

/** One line for the text beside the picture. */
function tally(result) {
  return `${result.marks} ${result.marks === 1 ? 'mark' : 'marks'} in the record`
}

/** How the window relates to the picture, and the grid drawn on it. */
function windowText(result) {
  const drawn = `drawn ${VIEW_SIDE}x${VIEW_SIDE} (${result.scale} of the picture)`
  const grid = result.step > 0 ? `grid every ${result.step} original pixels` : 'no grid'
  const edge = result.whole === true
    ? `the whole picture, ${pictureInside(result)}`
    : `the picture is ${pictureInside(result)}, the rest is black`
  return `${drawn}, ${grid}, ${edge}`
}

/** How much of the square the picture fills. */
function pictureInside(result) {
  const [x0, y0, x1, y1] = String(result.window).split(',').map(Number)
  const [width, height] = String(result.picture).split('x').map(Number)
  const left = Math.max(x0, 0)
  const top = Math.max(y0, 0)
  const right = Math.min(x1, width)
  const bottom = Math.min(y1, height)
  const scale = VIEW_SIDE / (x1 - x0)
  const w = Math.round((right - left) * scale)
  const h = Math.round((bottom - top) * scale)
  return `${w}x${h} inside it`
}

/**
 * The text the caller reads next to the picture: what the call changed, the record it
 * changed, where the camera is, and how far the sweep has got. It never states a count of
 * what the picture holds, because this package cannot know one.
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
  lines.push(`window ${result.window} — ${windowText(result)}` +
    `${result.marksShown === true ? ', marks drawn' : ', no marks drawn'}`)
  lines.push(`sweep: ${result.sweep}`)
  // A mark is not drawn in a clean view, but it is on the picture: say so, or a caller that
  // never sees its own record drawn concludes the marks were only ever a report.
  if (result.marksShown !== true && (result.marks ?? 0) > 0) {
    const many = result.marks === 1 ? 'mark is' : 'marks are'
    lines.push(`${result.marks} ${many} not drawn here — leave \`marks\` out to see them`)
  }
  // Before anything is marked the loop has not started, and this is the only wording that
  // reaches the moment of decision: sessions that had read the description still looked a
  // dozen times, deciding positions as they went and writing them down last.
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
