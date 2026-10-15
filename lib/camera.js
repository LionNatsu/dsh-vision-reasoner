/**
 * The camera: where a caller is looking, and how it has been aimed.
 *
 * A caller does not take pictures from nowhere — it is always looking somewhere, and
 * `vision_look` shows it what is in front of the lens. Aiming is therefore an argument to
 * looking rather than an action of its own: `zoom` by a factor, `move` by a few pixels,
 * `reset` back to the whole picture, or a `region` that names where to point directly.
 *
 * The camera is a fold of those ops, taken from the arguments, so it is replayed from the
 * log like everything else here and survives a restart. Resolving it into a rectangle needs
 * the picture's dimensions, which is why that happens where the picture is at hand.
 *
 * @module lib/camera
 */

import { askedRegionText, frameRegion, regionOf } from './views.js'

/** Ops one record keeps. A camera that long is collapsed onto a reset. */
export const CAMERA_LIMIT = 64

/** One zoom step, in and out. */
const DEFAULT_ZOOM = 2

/**
 * A view never gets smaller than this share of the picture's longer side: below it there is
 * nothing left to see, and a caller that keeps zooming would be reading interpolation.
 */
const MIN_VIEW_FRACTION = 1 / 12

function zoomFactor(value) {
  if (value === undefined || value === null) return undefined
  if (value === 'in') return DEFAULT_ZOOM
  if (value === 'out') return 1 / DEFAULT_ZOOM
  const numeric = typeof value === 'string' ? Number(value) : value
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  throw new Error(`zoom must be "in", "out" or a factor above 0, got ${JSON.stringify(value)}`)
}

/** The ops one call aims with, from the arguments alone. */
export function cameraOps(args) {
  const ops = []
  // One rectangle points the camera at it; several are a sweep, which starts from the whole
  // picture because a sweep is an overview of it.
  const regions = Array.isArray(args?.regions) ? args.regions : []
  if (regions.length === 1) {
    const at = askedRegionText(regions[0])
    if (at !== undefined) ops.push({ op: 'region', at })
  } else if (regions.length > 1) {
    ops.push({ op: 'reset' })
  } else if (args?.reset === true) {
    ops.push({ op: 'reset' })
  }
  const by = zoomFactor(args?.zoom)
  if (by !== undefined) ops.push({ op: 'zoom', by })
  const move = args?.move
  if (move !== undefined && move !== null) {
    if (!Array.isArray(move) || move.length !== 2 || !move.every((n) => Number.isFinite(n))) {
      throw new Error(`move must be [dx, dy] in original pixels, got ${JSON.stringify(move)}`)
    }
    ops.push({ op: 'move', by: [Math.round(move[0]), Math.round(move[1])] })
  }
  return ops
}

/** The camera after more aiming. A camera that outgrows its limit starts again from the frame. */
export function applyCameraOps(camera, ops) {
  if (ops.length === 0) return camera ?? []
  const next = [...(camera ?? []), ...ops]
  if (next.length <= CAMERA_LIMIT) return next
  return [{ op: 'reset' }, ...next.slice(-(CAMERA_LIMIT - 1))]
}

function scaledAbout(view, by) {
  const cx = (view.x0 + view.x1) / 2
  const cy = (view.y0 + view.y1) / 2
  const halfWidth = (view.x1 - view.x0) / 2 / by
  const halfHeight = (view.y1 - view.y0) / 2 / by
  return {
    x0: Math.round(cx - halfWidth),
    y0: Math.round(cy - halfHeight),
    x1: Math.round(cx + halfWidth),
    y1: Math.round(cy + halfHeight)
  }
}

function movedAbout(view, by) {
  return { x0: view.x0 + by[0], y0: view.y0 + by[1], x1: view.x1 + by[0], y1: view.y1 + by[1] }
}

/** A view inside the picture, and no smaller than the smallest thing worth reading. */
function clampView(view, frame, minSide) {
  const frameWidth = frame.x1 - frame.x0
  const frameHeight = frame.y1 - frame.y0
  const width = Math.min(frameWidth, Math.max(minSide, view.x1 - view.x0))
  const height = Math.min(frameHeight, Math.max(minSide, view.y1 - view.y0))
  const cx = (view.x0 + view.x1) / 2
  const cy = (view.y0 + view.y1) / 2
  const x0 = Math.round(Math.min(Math.max(cx - width / 2, frame.x0), frame.x1 - width))
  const y0 = Math.round(Math.min(Math.max(cy - height / 2, frame.y0), frame.y1 - height))
  return { x0, y0, x1: Math.round(x0 + width), y1: Math.round(y0 + height) }
}

/** Where the camera is pointed, in the picture's own pixels. */
export function resolveCamera(camera, width, height) {
  const frame = frameRegion(width, height)
  const minSide = Math.max(48, Math.round(Math.max(width, height) * MIN_VIEW_FRACTION))
  let view = frame
  for (const op of camera ?? []) {
    if (op?.op === 'reset') view = frame
    else if (op?.op === 'region') view = regionOf(String(op.at).split(',').map(Number), width, height)
    else if (op?.op === 'zoom') view = scaledAbout(view, op.by)
    else if (op?.op === 'move') view = movedAbout(view, op.by)
    view = clampView(view, frame, minSide)
  }
  return view
}
