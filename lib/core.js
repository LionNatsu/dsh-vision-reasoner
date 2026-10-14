/**
 * core: what a call means, with no I/O.
 *
 * `plan*` returns `{ record, result, views }`. Views stay out of `result`
 * because `result` is logged and has to be lossless JSON, and a view carries PNG
 * bytes.
 *
 * @module lib/core
 */

import { applyMarkArgs, applyUpdateArgs, recordSummary } from './record.js'
import { renderViews } from './render.js'

/** Ways a mutating call can show its own result. */
export const VIEW_MODES = ['map', 'marks', 'none']

/**
 * The default view per call: the whole frame after adding marks — seeing it is how
 * a caller notices a mark that landed on nothing — and a sheet of the marks an
 * update touched, which is cheaper than redrawing the map.
 */
export const DEFAULT_VIEW_MODES = { mark: 'map', update: 'marks' }

function viewMode(value, fallback = 'map') {
  const mode = value === undefined || value === null || value === '' ? fallback : String(value)
  if (!VIEW_MODES.includes(mode)) {
    throw new Error(`view must be one of ${VIEW_MODES.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return mode
}

/** `marks` mode shows exactly the marks this call touched, as one sheet. */
function requestForMode(mode, ids, args) {
  if (mode === 'marks') {
    return {
      views: ids.map((id) => `#${id}`),
      tile: args.tile,
      cols: args.cols,
      pad: args.pad,
      grid: args.grid,
      ids: args.ids,
      captions: args.captions,
      target: args.target,
      maxDimension: args.maxDimension
    }
  }
  return {
    map: true,
    target: args.target,
    maxDimension: args.maxDimension,
    step: args.step,
    ids: args.ids,
    captions: args.captions
  }
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

/**
 * Add marks. `loadSource` is called only when a view was asked for, so batching
 * twenty marks into one call does not decode the picture twenty times.
 *
 * @param {{record: object, args: object, loadSource: () => Promise<object>}} input
 */
export async function planMark({ record, args, loadSource }) {
  const { record: next, result } = applyMarkArgs(record, args)
  const mode = viewMode(args?.view, DEFAULT_VIEW_MODES.mark)
  const views = mode === 'none'
    ? []
    : await renderViews(await loadSource(), next, requestForMode(mode, result.marked, args ?? {}))
  return {
    record: next,
    views,
    result: {
      image: next.image,
      marked: result.marked,
      marks: next.marks.length,
      viewMode: mode,
      views: viewMeta(views)
    }
  }
}

/** Move, recaption, recolour or delete marks. */
export async function planUpdate({ record, args, loadSource }) {
  const { record: next, result } = applyUpdateArgs(record, args)
  const mode = viewMode(args?.view, DEFAULT_VIEW_MODES.update)
  // A removed mark has no address left to zoom, so only survivors are shown.
  const touched = Object.keys(result.updated)
    .map(Number)
    .filter((id) => next.marks.some((mark) => mark.id === id))
  const views = mode === 'none' || touched.length === 0
    ? []
    : await renderViews(await loadSource(), next, requestForMode(mode, touched, args ?? {}))
  return {
    record: next,
    views,
    result: {
      image: next.image,
      updated: result.updated,
      removed: result.removed,
      marks: next.marks.length,
      viewMode: mode,
      views: viewMeta(views)
    }
  }
}

/** Look: a map, zooms, a sheet, a cover — or nothing but the record's count. */
export async function planShow({ record, args, loadSource }) {
  const request = {
    views: args?.views,
    map: args?.map,
    cover: args?.cover,
    tile: args?.tile,
    cols: args?.cols,
    pad: args?.pad,
    grid: args?.grid,
    target: args?.target,
    step: args?.step,
    ruler: args?.ruler,
    alpha: args?.alpha,
    ids: args?.ids,
    captions: args?.captions,
    maxDimension: args?.maxDimension
  }
  const views = await renderViews(await loadSource(), record, request)
  return {
    record,
    views,
    result: {
      image: record.image,
      marks: record.marks.length,
      views: viewMeta(views)
    }
  }
}

/**
 * The record as text — the only call that returns no picture. `marks` counts the
 * record, never the picture; the two are allowed to differ, and noticing when
 * they do is the point of being able to read the record back.
 */
export function planList({ record }) {
  return { record, views: [], result: recordSummary(record) }
}

/** One line for the text beside the picture. */
function tally(result) {
  return `${result.marks} ${result.marks === 1 ? 'mark' : 'marks'} in the record`
}

/**
 * The text the model reads next to the pictures: what the call changed, and where
 * each view can be found again. It never states a count of what the picture holds,
 * because this package cannot know one.
 */
export function describe(result) {
  if (Array.isArray(result.items)) {
    const lines = [`${result.image} — ${tally(result)}`]
    for (const item of result.items) {
      const where = item.kind === 'point'
        ? `point ${item.at[0]},${item.at[1]} r${item.r}`
        : `box ${item.box.join(',')}`
      const caption = item.caption ? ` ${JSON.stringify(item.caption)}` : ''
      lines.push(`#${item.id} ${where} ${item.colour}${caption}`)
    }
    if (result.items.length === 0) lines.push('(no marks yet)')
    return lines.join('\n')
  }

  const parts = []
  if (Array.isArray(result.marked) && result.marked.length > 0) {
    parts.push(`marked ${result.marked.map((id) => `#${id}`).join(' ')}`)
  }
  if (result.updated && Object.keys(result.updated).length > 0) {
    const changes = Object.entries(result.updated).map(([id, touched]) => {
      const what = []
      if (touched.move) what.push(`moved to ${touched.move.join(',')}`)
      if (touched.r !== undefined) what.push(`radius ${touched.r}`)
      if (touched.caption !== undefined) what.push(`caption ${JSON.stringify(touched.caption)}`)
      if (touched.colour !== undefined) what.push(`colour ${touched.colour}`)
      return `#${id} ${what.join(', ')}`
    })
    parts.push(`updated ${changes.join('; ')}`)
  }
  if (Array.isArray(result.removed) && result.removed.length > 0) {
    parts.push(`removed ${result.removed.map((id) => `#${id}`).join(' ')}`)
  }
  parts.push(tally(result))

  const where = new Map((result.images ?? []).map((image) => [image.name, image.path]))
  const pictures = (result.views ?? []).map((view) => {
    const path = where.get(view.name)
    return `${view.name} (${view.width}x${view.height})${path === undefined ? '' : ` at ${path}`}`
  })
  parts.push(pictures.length > 0 ? `picture: ${pictures.join(', ')}` : 'no picture')
  return parts.join('; ')
}
