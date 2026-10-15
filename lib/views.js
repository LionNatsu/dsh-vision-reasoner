/**
 * views: the grid a caller reads, and the place in the picture it names.
 *
 * A grid is drawn at round steps of the picture's own pixels — 100, 200, 500 — and
 * every line is labelled with that number. A caller estimates between two labelled
 * lines and says the number it sees; nothing here, and nothing on the caller's side,
 * converts a scale.
 *
 * @module lib/views
 */

/**
 * Ring radii in the picture's own pixels: `s` a small ring for one face in a crowd,
 * `m` a face or a person, `l` a group. Pixels rather than a fraction of anything, so
 * a size means the same thing however the picture is looked at — and so a call can
 * be replayed without knowing how big the picture is.
 */
export const SIZES = { s: 30, m: 60, l: 120 }
export const DEFAULT_SIZE = 's'

/** Round steps a grid may use, coarsest last. */
const STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]

/**
 * How far apart two labelled lines have to be to be read one from the other.
 *
 * Set for a caller that estimates a fraction of the gap, not for a human eye: at a
 * hundred view pixels a face sat between two lines, so a session calibrated the
 * scale from the labels and interpolated — the arithmetic this grid exists to
 * remove — and another built its own ruler in Python. Nearer sixty, a face spans
 * two or three lines and is read off them.
 */
const MIN_LABEL_SPACING = 55

/** The whole picture, as a rectangle. */
export function frameRegion(width, height) {
  return { x0: 0, y0: 0, x1: width, y1: height }
}

function whole(value) {
  return Number.isFinite(value) ? Math.round(value) : Number.NaN
}

/**
 * The rectangle a caller asked to look at, in the picture's own pixels, trimmed to
 * the picture. No rectangle means the whole picture.
 */
export function regionOf(value, width, height) {
  if (value === undefined || value === null) return frameRegion(width, height)
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('region must be [x0, y0, x1, y1] in original pixels, or left out for the whole picture')
  }
  const [x0, y0, x1, y1] = value.map(whole)
  if ([x0, y0, x1, y1].some((n) => Number.isNaN(n))) {
    throw new Error(`region must be four numbers in original pixels, got ${JSON.stringify(value)}`)
  }
  const left = Math.max(0, Math.min(width - 1, Math.min(x0, x1)))
  const top = Math.max(0, Math.min(height - 1, Math.min(y0, y1)))
  return {
    x0: left,
    y0: top,
    x1: Math.max(left + 1, Math.min(width, Math.max(x0, x1))),
    y1: Math.max(top + 1, Math.min(height, Math.max(y0, y1)))
  }
}

/** `0,0,2600,1831` — how a result names the rectangle it drew. */
export function regionText(region) {
  return [region.x0, region.y0, region.x1, region.y1].map((n) => Math.round(n)).join(',')
}

/**
 * The step a grid uses on this view: the coarsest round number whose lines are still
 * far enough apart to carry a label.
 */
export function gridStep(region, view) {
  const scale = Math.max(1e-6, Math.min(view.sx, view.sy))
  const needed = MIN_LABEL_SPACING / scale
  for (const step of STEPS) {
    if (step >= needed) return step
  }
  return STEPS[STEPS.length - 1]
}

/** The labelled positions a grid draws on this view, on both axes. */
export function gridLines(region, view) {
  const step = gridStep(region, view)
  const across = []
  for (let x = Math.ceil(region.x0 / step) * step; x <= region.x1; x += step) across.push(x)
  const down = []
  for (let y = Math.ceil(region.y0 / step) * step; y <= region.y1; y += step) down.push(y)
  return { step, across, down }
}

/**
 * Where a caller pointed, in the picture's own pixels: the pair it read off the
 * grid. It has to be inside the picture, because a mark outside it names nothing.
 * `field` is the argument it came from, so a refusal says which one to fix.
 */
export function placeAt(value, width, height, field = 'at') {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${field} must be [x, y] in original pixels, read off the grid labels`)
  }
  const [x, y] = value.map(whole)
  if ([x, y].some((n) => Number.isNaN(n))) {
    throw new Error(`${field} must be two numbers in original pixels, got ${JSON.stringify(value)}`)
  }
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error(`${field} ${x},${y} is outside the picture, which is ${width}x${height} original pixels`)
  }
  return [x, y]
}

/**
 * The rectangle a caller asked for, as `x0,y0,x1,y1`, from the arguments alone: the
 * ledger of where a picture has been looked at is folded from the log, so it cannot
 * depend on the picture's dimensions.
 */
export function askedRegionText(value) {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const numbers = value.map((n) => (Number.isFinite(n) ? Math.round(n) : Number.NaN))
  if (numbers.some((n) => Number.isNaN(n))) return undefined
  const [x0, y0, x1, y1] = numbers
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)].join(',')
}

/** A ring's radius in picture pixels, from a size the caller judged by eye. */
/** A ring's radius in picture pixels, from a size the caller judged by eye. */
export function radiusFor(size) {
  const preset = SIZES[size ?? DEFAULT_SIZE]
  if (preset === undefined) {
    throw new Error(`size must be one of ${Object.keys(SIZES).join(', ')}, got ${JSON.stringify(size)}`)
  }
  return preset
}

/** The rectangle around a set of places, with room to see what is near them. */
export function regionAround(points, margin = 0.85) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const padX = Math.max(40, Math.round((x1 - x0) * margin))
  const padY = Math.max(40, Math.round((y1 - y0) * margin))
  return { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY }
}
