/**
 * render: a region of the picture, plus its grid, as a PNG.
 *
 * The only module that uses `sharp`: Node has no canvas, and sharp carries one
 * (librsvg), the same library the harness uses for every image a session attaches.
 *
 * A view is a rectangle of the picture. It is rendered at a size this module
 * chooses — never one the caller asks for — and it carries the grid that names its
 * cells, which is the only instrument a caller reads a place off.
 *
 * @module lib/render
 */

import sharp from 'sharp'

import { coordGridOverlay, coverOverlay, markOverlay, sheetOverlay, svgOf } from './draw.js'
import { COLOURS } from './record.js'
import { gridLines } from './views.js'

/** Longest side any single view may have. */
export const MAX_VIEW_DIMENSION = 4096

/**
 * Longest side of a view, whatever it covers.
 *
 * One size for every view is what keeps a closer look from being worse than the
 * whole picture: a block that spans most of the frame comes back at the frame's
 * own resolution, and a single cell comes back magnified until MAX_CLOSE_SCALE.
 */
export const VIEW_TARGET = 1400

/** A close-up of a tiny cell is capped, so a blur is never rendered as detail. */
export const MAX_CLOSE_SCALE = 6

/** Default tile size inside a comparison sheet, and the strip above each tile. */
export const TILE = 620
export const SHEET_LABEL_HEIGHT = 42

/** The sheet's background: dark, so a picture's edges are obvious. */
const SHEET_BACKGROUND = { r: 22, g: 22, b: 26 }

/** Widest frame this package will decode, matching the harness's own default. */
export const MAX_IMAGE_PIXELS = 64e6

/**
 * Apply an EXIF rotation once, so every later `extract` works in the frame the
 * viewer — and the record — is talking about: a photograph taken sideways holds a
 * portrait frame in its header and a landscape one on screen.
 */
export async function prepareSource(bytes, orientation) {
  if (orientation === undefined || orientation === 1) return bytes
  return sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().png().toBuffer()
}

/** Clamp a rendered size to what this package will pay for. */
function bounded(width, height, maxDimension) {
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width: Math.max(1, width), height: Math.max(1, height) }
  const factor = maxDimension / longest
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
}

/**
 * The transform that puts a region on a raster: the region's longest side becomes
 * `target`, unless that would enlarge a small region past what carries information.
 */
export function viewOf(region, target, maxScale = MAX_CLOSE_SCALE) {
  const width = region.x1 - region.x0
  const height = region.y1 - region.y0
  const scale = Math.min(maxScale, target / Math.max(width, height))
  const raster = bounded(Math.round(width * scale), Math.round(height * scale), MAX_VIEW_DIMENSION)
  return {
    x0: region.x0,
    y0: region.y0,
    sx: raster.width / width,
    sy: raster.height / height,
    width: raster.width,
    height: raster.height
  }
}

/**
 * Keep a region inside the picture: a handle copied from anywhere still draws, and
 * a region that runs off the edge is trimmed rather than refused.
 */
export function clampRegion(region, bounds) {
  if (bounds === undefined) return region
  const x0 = Math.max(0, Math.min(bounds.width - 1, Math.round(region.x0)))
  const y0 = Math.max(0, Math.min(bounds.height - 1, Math.round(region.y0)))
  return {
    x0,
    y0,
    x1: Math.max(x0 + 1, Math.min(bounds.width, Math.round(region.x1))),
    y1: Math.max(y0 + 1, Math.min(bounds.height, Math.round(region.y1)))
  }
}

/** Composite one SVG overlay at exact size and return PNG bytes. */
async function compose(bytes, region, view, svg) {
  const png = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .extract({ left: region.x0, top: region.y0, width: region.x1 - region.x0, height: region.y1 - region.y0 })
    .resize(view.width, view.height, { fit: 'fill', kernel: 'lanczos3' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer()
  return png
}

/**
 * One view: the region, its grid, and — when asked for — the marks.
 *
 * @returns {Promise<{png: Buffer, width: number, height: number, region: object,
 *   grid: object|null, label: string}>}
 */
export async function renderRegion(bytes, record, region, opts = {}) {
  const inside = clampRegion(region, opts.bounds)
  const view = opts.view ?? viewOf(inside, opts.target ?? VIEW_TARGET, opts.maxScale)
  const grid = opts.grid === false ? null : gridLines(inside, view)
  const parts = []
  if (opts.cover !== undefined && opts.cover !== null) {
    const colours = opts.cover === 'all' || opts.cover === ''
      ? null
      : String(opts.cover).split(',').map((c) => c.trim()).filter(Boolean)
    const bad = (colours ?? []).filter((c) => !Object.hasOwn(COLOURS, c))
    if (bad.length > 0) {
      throw new Error(`unknown colour(s) ${bad.join(', ')} to cover; use ${Object.keys(COLOURS).join(', ')}, or all`)
    }
    parts.push(coverOverlay(record, view, colours, opts))
  }
  if (opts.showMarks === true) parts.push(markOverlay(record, view, opts))
  if (grid !== null) parts.push(coordGridOverlay(view, inside, opts))
  return {
    png: await compose(bytes, inside, view, svgOf(view, parts)),
    width: view.width,
    height: view.height,
    region: inside,
    grid,
    label: opts.label ?? ''
  }
}

/** Where each tile of a sheet goes on the assembled canvas. */
export function sheetLayout(count, opts = {}) {
  const pad = Math.max(2, Math.round(opts.pad ?? 10))
  const labelHeight = Math.max(16, Math.round(opts.labelHeight ?? SHEET_LABEL_HEIGHT))
  const columns = Math.max(1, Math.round(opts.cols ?? Math.ceil(Math.sqrt(Math.max(1, count)))))
  const rows = Math.ceil(Math.max(1, count) / columns)
  const cap = Math.max(64, Math.round(opts.maxDimension ?? MAX_VIEW_DIMENSION))
  const requested = Math.max(64, Math.round(opts.tile ?? TILE))
  // A sheet's size grows with the tile count, so the tile shrinks until the canvas
  // fits the cap: a few dozen tiles at the default size already exceed it.
  const byWidth = Math.floor((cap - pad) / columns) - pad
  const byHeight = Math.floor((cap - pad) / rows) - pad - labelHeight
  const tile = Math.max(48, Math.min(requested, byWidth, byHeight))
  const width = columns * (tile + pad) + pad
  const height = rows * (tile + pad + labelHeight) + pad
  return {
    width,
    height,
    tile,
    pad,
    labelHeight,
    columns,
    rows,
    tileRect(index) {
      // The label strip belongs to the tile, so the picture starts below it.
      const x = pad + (index % columns) * (tile + pad)
      const y = pad + Math.floor(index / columns) * (tile + pad + labelHeight) + labelHeight
      return { x, y, width: tile, height: tile }
    }
  }
}

/**
 * One picture holding several views: a reader cannot compare pictures it receives
 * separately, so doubtful places are put side by side.
 *
 * @param {{png: Buffer, width: number, height: number, label: string}[]} tiles
 */
export async function renderSheet(tiles, opts = {}) {
  const layout = sheetLayout(tiles.length, opts)
  const composites = []
  for (let i = 0; i < tiles.length; i++) {
    const box = layout.tileRect(i)
    const tile = tiles[i]
    // `inside` keeps a tall tile from being squashed by a square box, and the
    // tile is centred in its cell so the grid of cells stays even.
    const fitted = await sharp(tile.png)
      .resize(box.width, box.height, { fit: 'inside' })
      .png()
      .toBuffer({ resolveWithObject: true })
    composites.push({
      input: fitted.data,
      left: box.x + Math.round((box.width - fitted.info.width) / 2),
      top: box.y + Math.round((box.height - fitted.info.height) / 2)
    })
  }
  composites.push({
    input: Buffer.from(svgOf({ width: layout.width, height: layout.height }, [sheetOverlay(tiles, layout, opts)]))
  })
  const png = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: SHEET_BACKGROUND }
  }).composite(composites).png({ compressionLevel: 6 }).toBuffer()
  return { png, width: layout.width, height: layout.height }
}

// ---------------------------------------------------------------- image info

/** Dimensions after an EXIF orientation is applied: 5..8 swap the axes. */
export function orientedSize(orientation, width, height) {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height }
}

/**
 * Header-only dimensions, in the orientation a decode will produce.
 *
 * @param {string|Buffer|Uint8Array} source a path, or the file's bytes
 */
export async function probeImageSize(source) {
  const metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error('cannot read the image: its header reports no dimensions')
  }
  const orientation = metadata.orientation ?? 1
  const frame = orientedSize(orientation, metadata.width, metadata.height)
  if (frame.width * frame.height > MAX_IMAGE_PIXELS) {
    throw new Error(`cannot read the image: ${frame.width}x${frame.height} is past this package's ` +
      `${MAX_IMAGE_PIXELS}-pixel limit`)
  }
  return {
    ...frame,
    orientation,
    format: metadata.format,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height
  }
}

