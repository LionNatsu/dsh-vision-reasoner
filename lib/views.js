/**
 * views: the grid a caller reads, and the place in the picture a call means.
 *
 * A view is a rectangle of the picture, rendered at some size. Everything here is
 * pure and needs no picture dimensions: a view is its own rectangle, a cell is a
 * fraction of that rectangle, and that fraction maps straight back to the picture.
 * A caller therefore never handles picture coordinates, and a call can be replayed
 * from its arguments alone.
 *
 * @module lib/views
 */

/** Cells a view is cut into; the view's own shape decides the split. */
const CELLS = 70
const MIN_COLUMNS = 2
const MAX_COLUMNS = 26

/**
 * Ring sizes, as a fraction of the view's shorter side, so a ring looks the same
 * size to the reader whatever the view is: `s` for one face in a crowd, `m` for a
 * person, `l` for a group or a large area.
 */
export const SIZES = { s: 0.02, m: 0.05, l: 0.12 }
export const DEFAULT_SIZE = 'm'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A view's rectangle as the caller copies it back, opaque. */
export function regionToken(region) {
  const round = (value) => Math.round(value)
  return `${round(region.x0)},${round(region.y0)},${round(region.x1)},${round(region.y1)}`
}

/** Read back a rectangle a caller copied from an earlier result. */
export function parseRegion(token) {
  const parts = String(token).trim().split(',').map(Number)
  const whole = parts.every((n) => Number.isFinite(n))
  if (parts.length !== 4 || !whole || parts[2] <= parts[0] || parts[3] <= parts[1]) {
    throw new Error(`view must be a rectangle copied from an earlier result, got ${JSON.stringify(String(token))}`)
  }
  return { x0: parts[0], y0: parts[1], x1: parts[2], y1: parts[3] }
}

/**
 * The rectangle a call is looking at: the handle it copied back, or the whole
 * picture when it names none. Without a handle and without dimensions there is
 * nothing to fall back on, and the call is refused rather than guessed.
 */
export function viewRegion(args, width, height) {
  const handle = args?.view
  if (handle === undefined || handle === null || handle === '') {
    if (width === undefined || height === undefined) {
      throw new Error('this call needs "view": the handle from the result you are looking at')
    }
    return { x0: 0, y0: 0, x1: width, y1: height }
  }
  return parseRegion(handle)
}

/**
 * The grid a view carries: cells as square as the view's shape allows, so a cell
 * is read the same way whatever the picture's aspect ratio is.
 */
export function gridFor(region) {
  const width = region.x1 - region.x0
  const height = region.y1 - region.y0
  const ratio = width / Math.max(1, height)
  const cols = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(Math.sqrt(CELLS * ratio))))
  const rows = Math.max(1, Math.round(CELLS / cols))
  return { cols, rows, columns: LETTERS.slice(0, cols) }
}

/** `A1` .. `Z9`, checked against this view's grid. */
export function parseCell(label, grid) {
  const match = /^([A-Za-z])([0-9]{1,2})$/.exec(String(label).trim())
  if (match === null) {
    throw new Error(`at must be a cell like "C3" (this view is ${describeGrid(grid)}), ` +
      `or [across, down] as fractions of the view`)
  }
  const col = LETTERS.indexOf(match[1].toUpperCase())
  const row = Number(match[2]) - 1
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
    throw new Error(`cell ${JSON.stringify(String(label))} is outside this view, which is ${describeGrid(grid)}`)
  }
  return { col, row }
}

/** `10x7 A-J 1-7` — what a caller needs to name a cell. */
export function describeGrid(grid) {
  return `${grid.cols}x${grid.rows} ${grid.columns[0]}-${grid.columns[grid.cols - 1]} 1-${grid.rows}`
}

/** One cell, in picture pixels. Integral, so a handle reproduces it exactly. */
export function cellRegion(region, grid, label) {
  const { col, row } = parseCell(label, grid)
  const width = (region.x1 - region.x0) / grid.cols
  const height = (region.y1 - region.y0) / grid.rows
  const x0 = Math.round(region.x0 + col * width)
  const y0 = Math.round(region.y0 + row * height)
  return {
    x0,
    y0,
    x1: Math.max(x0 + 1, Math.round(region.x0 + (col + 1) * width)),
    y1: Math.max(y0 + 1, Math.round(region.y0 + (row + 1) * height))
  }
}

/** The cell a point falls in, for naming an existing mark in the frame's grid. */
export function cellOf(point, region, grid) {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(((point[0] - region.x0) / (region.x1 - region.x0)) * grid.cols)))
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(((point[1] - region.y0) / (region.y1 - region.y0)) * grid.rows)))
  return `${grid.columns[col]}${row + 1}`
}

/**
 * Where a caller pointed, in picture pixels: the centre of the cell it named.
 *
 * A cell name is a thing the caller can see on the grid it was given, so nothing
 * here needs the picture's dimensions — which is what lets a call be replayed from
 * its arguments alone.
 */
export function placeOn(cell, region, grid) {
  const inside = cellRegion(region, grid, cell)
  return [Math.round((inside.x0 + inside.x1) / 2), Math.round((inside.y0 + inside.y1) / 2)]
}

/** A ring's radius in picture pixels, from a size the caller can see. */
export function radiusFor(size, region) {
  const preset = SIZES[size ?? DEFAULT_SIZE]
  if (preset === undefined) {
    throw new Error(`size must be one of ${Object.keys(SIZES).join(', ')}, got ${JSON.stringify(size)}`)
  }
  const shorter = Math.min(region.x1 - region.x0, region.y1 - region.y0)
  return Math.max(4, Math.round(shorter * preset))
}
