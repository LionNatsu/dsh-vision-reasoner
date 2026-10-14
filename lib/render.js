/**
 * render: the picture, plus an SVG overlay, becomes a PNG.
 *
 * This is the only module that touches `sharp` for drawing, and it holds the one
 * piece of knowledge Node does not provide: how to get pixels out of a file, put
 * a crop of them at a size, and draw vector shapes and text over the result.
 * Node has no canvas of its own; sharp carries one, and it is the same library
 * the harness uses for every image a session attaches.
 *
 * Everything a caller can ask for is one of four views:
 *
 *   map     the whole frame, a ruler in original coordinates, every mark
 *   zoom    one address, cropped, scaled up, a labelled coordinate grid
 *   sheet   several zooms in one picture — the only way to compare them
 *   cover   the named colours painted out, so whatever still shows is unmarked
 *
 * @module lib/render
 */

import sharp from 'sharp'

import { coverOverlay, fitView, mapOverlay, sheetOverlay, zoomOverlay } from './draw.js'
import { COLOURS, parseAddress } from './record.js'

/** Longest side any single view may have, whatever the caller asks for. */
export const MAX_VIEW_DIMENSION = 4096

/** Default longest side of a fitted whole-frame view. */
export const MAP_TARGET = 1400

/** Default longest side of a zoom. */
export const ZOOM_TARGET = 1200

/** Default tile size inside a sheet, and the strip above each tile. */
export const SHEET_TILE = 620
export const SHEET_LABEL_HEIGHT = 42

/** The sheet's background: dark, so a photograph's edges are obvious. */
const SHEET_BACKGROUND = { r: 22, g: 22, b: 26 }

/** Do not blow a 12-pixel region up into a blur that costs a fortune in tokens. */
const MAX_ZOOM_SCALE = 6

/**
 * Make the source safe to crop by original coordinates.
 *
 * EXIF orientation is the one thing that can move every coordinate at once: a
 * photograph taken sideways holds a portrait frame in its header and a landscape
 * one on screen. When the file says "sideways", the rotation is
 * materialised once so that every later `extract` is expressed in the frame the
 * viewer — and the record — is talking about.
 */
export async function prepareSource(bytes, orientation) {
  if (orientation === undefined || orientation === 1) return bytes
  return sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().png().toBuffer()
}

function pipelineFrom(bytes) {
  return sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).flatten({ background: { r: 0, g: 0, b: 0 } })
}

/** Composite one SVG overlay at exact size and return PNG bytes plus dimensions. */
async function compose(bytes, width, height, region, svg) {
  const pipeline = pipelineFrom(bytes)
  const cropped = region === null
    ? pipeline.resize(width, height, { fit: 'fill' })
    : pipeline.extract(region).resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
  const png = await cropped
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer()
  return { png, width, height }
}

/** Clamp a requested size to what this package will pay for. */
function bounded(width, height, maxDimension) {
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width: Math.max(1, width), height: Math.max(1, height) }
  const factor = maxDimension / longest
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
}

/**
 * The map: the whole frame, a ruler, every mark.
 *
 * Fitted to `target` on its longest side rather than drawn at 1:1. The harness
 * re-encodes whatever it sends to the model anyway, so a full-size map would
 * cost full price and arrive with hairline rings. The ruler is what makes the fit
 * harmless: every number on it is still an original pixel coordinate.
 */
export async function renderMap(bytes, record, opts = {}) {
  const target = Math.max(256, Math.round(opts.target ?? MAP_TARGET))
  const fit = fitView(opts.sourceWidth, opts.sourceHeight, target)
  const view = bounded(fit.width, fit.height, opts.maxDimension ?? MAX_VIEW_DIMENSION)
  const sized = { ...fit, width: view.width, height: view.height, sx: view.width / opts.sourceWidth, sy: view.height / opts.sourceHeight }
  return compose(bytes, view.width, view.height, null, mapOverlay(record, sized, opts))
}

/** Paint out the named colours; `colours` null means every mark. */
export async function renderCover(bytes, record, colours, opts = {}) {
  const target = Math.max(256, Math.round(opts.target ?? MAP_TARGET))
  const fit = fitView(opts.sourceWidth, opts.sourceHeight, target)
  const view = bounded(fit.width, fit.height, opts.maxDimension ?? MAX_VIEW_DIMENSION)
  const sized = { ...fit, width: view.width, height: view.height, sx: view.width / opts.sourceWidth, sy: view.height / opts.sourceHeight }
  return compose(bytes, view.width, view.height, null, coverOverlay(record, sized, colours, opts))
}

/**
 * Crop around an address, scale it up, and label the coordinates.
 *
 * This is the primitive the whole method rests on: at 1:1 a small detail in a
 * large photograph is a few dozen pixels of a preview the model never sees at
 * full size, and nothing can be decided from it. The grid is what makes the
 * magnification safe — a position read off a zoom is an original coordinate, not
 * a fraction of a crop.
 *
 * `maxWidth`/`maxHeight` rather than one target, because a sheet renders its
 * tiles at their final size directly. Rendering a tile large and shrinking it
 * into the sheet would blur exactly the numbers the sheet exists to make
 * readable.
 */
export async function renderZoom(bytes, record, address, opts = {}) {
  const { sourceWidth, sourceHeight } = opts
  // Surroundings of a close-up are derived from the picture rather than fixed at
  // a constant: 150 original pixels is a comfortable frame around a small subject
  // in a 2000-pixel photograph and a keyhole in a 12000-pixel one. A caller that
  // knows better can still say so.
  const pad = Math.max(0, Math.round(opts.pad ?? Math.min(600, Math.max(60, 0.06 * Math.max(sourceWidth, sourceHeight)))))
  const maxWidth = Math.max(64, Math.round(opts.maxWidth ?? opts.target ?? ZOOM_TARGET))
  const maxHeight = Math.max(64, Math.round(opts.maxHeight ?? opts.target ?? ZOOM_TARGET))
  const maxScale = opts.maxScale ?? MAX_ZOOM_SCALE

  let x0, y0, x1, y1
  if (address.kind === 'point') {
    const [cx, cy] = address.point
    x0 = cx - pad; y0 = cy - pad; x1 = cx + pad; y1 = cy + pad
  } else {
    // A box already carries its own extent, so it needs a quarter of the pad
    // only to keep its outline off the tile edge.
    const p = Math.round(pad * 0.25)
    x0 = address.rect[0] - p; y0 = address.rect[1] - p
    x1 = address.rect[2] + p; y1 = address.rect[3] + p
  }
  x0 = Math.max(0, Math.floor(Math.min(x0, sourceWidth - 1)))
  y0 = Math.max(0, Math.floor(Math.min(y0, sourceHeight - 1)))
  x1 = Math.min(sourceWidth, Math.ceil(Math.max(x1, x0 + 1)))
  y1 = Math.min(sourceHeight, Math.ceil(Math.max(y1, y0 + 1)))
  if (x1 <= x0 || y1 <= y0) throw new Error(`empty view for ${address.spec ?? 'address'}`)

  // The cap is applied to the RESULT, not just to the request: a caller can ask
  // for a 1200x1200 crop at 20000 pixels and would otherwise get a 400-megapixel
  // PNG that takes half a minute and half a gigabyte to make. A view's longest
  // side is bounded whatever anybody asks for.
  const cap = Math.max(64, Math.round(opts.maxDimension ?? MAX_VIEW_DIMENSION))
  let scale = Math.min(maxScale, maxWidth / (x1 - x0), maxHeight / (y1 - y0))
  scale = Math.min(scale, cap / (x1 - x0), cap / (y1 - y0))
  const width = Math.max(1, Math.round((x1 - x0) * scale))
  const height = Math.max(1, Math.round((y1 - y0) * scale))
  const view = { x0, y0, sx: width / (x1 - x0), sy: height / (y1 - y0), width, height }
  // The address itself is marked on the tile: the one position on it that needs
  // no reading. For a box that is its centre, which is the coordinate the record
  // keeps for it.
  const png = await compose(bytes, width, height, { left: x0, top: y0, width: x1 - x0, height: y1 - y0 },
    zoomOverlay(record, view, { ...opts, anchor: address.point }))
  return { ...png, rect: [x0, y0, x1, y1], view }
}

/** Where each tile of a sheet goes on the assembled canvas. */
export function sheetLayout(count, opts = {}) {
  const pad = Math.max(2, Math.round(opts.pad ?? 10))
  const labelHeight = Math.max(16, Math.round(opts.labelHeight ?? SHEET_LABEL_HEIGHT))
  const columns = Math.max(1, Math.round(opts.cols ?? Math.ceil(Math.sqrt(Math.max(1, count)))))
  const rows = Math.ceil(Math.max(1, count) / columns)
  const cap = Math.max(64, Math.round(opts.maxDimension ?? MAX_VIEW_DIMENSION))
  const requested = Math.max(64, Math.round(opts.tile ?? SHEET_TILE))
  // A sheet is the one view whose size grows with the number of tiles, so its tile
  // is shrunk until the whole canvas fits the cap: a few dozen tiles at the
  // default size already exceed it, and the caller asked to LOOK at something,
  // not to be handed an unpayable picture.
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
      // The label strip belongs to the tile, so the image starts below it.
      const x = pad + (index % columns) * (tile + pad)
      const y = pad + Math.floor(index / columns) * (tile + pad + labelHeight) + labelHeight
      return { x, y, width: tile, height: tile }
    }
  }
}

/**
 * One picture holding several views, so comparing doubtful places costs one look
 * instead of four. A model reading four separate images cannot see them side by
 * side, and the judgement being made — "is this one thing or two" — is a
 * comparison.
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
  composites.push({ input: Buffer.from(sheetOverlay(tiles, layout, opts)) })
  const png = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: SHEET_BACKGROUND }
  }).composite(composites).png({ compressionLevel: 6 }).toBuffer()
  return { png, width: layout.width, height: layout.height }
}

// ---------------------------------------------------------------- image info

/** Widest frame this package will decode, matching the harness's own default. */
export const MAX_IMAGE_PIXELS = 64e6

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

/** A file-name-safe rendition of an address, for `zoom_<addr>.png`. */
function addressName(spec) {
  return String(spec).replace(/^#/, 'id').replace(/[^0-9a-zA-Z]+/g, '_').replace(/^_+|_+$/g, '')
}

function stemOf(image) {
  const base = String(image).replace(/\\/g, '/').split('/').pop() ?? 'image'
  return base.replace(/\.[^.]+$/, '') || 'image'
}

/**
 * The caption over a tile: the mark's own number and caption when the address
 * names a mark, otherwise the address as written. A tile labelled with a raw
 * coordinate is still useful — it is a view of a place not yet marked.
 */
function labelFor(record, spec) {
  const s = String(spec).trim()
  if (s.startsWith('#')) {
    const mark = record.marks.find((m) => String(m.id) === s.slice(1).trim())
    if (mark) {
      const caption = String(mark.caption ?? '').trim()
      return caption === '' ? `#${mark.id}` : `#${mark.id} ${caption}`
    }
  }
  return s
}

/**
 * Turn a look request into rendered views.
 *
 * @param {{bytes: Buffer|Uint8Array, width: number, height: number, orientation?: number}} source
 *   the decoded frame's dimensions and the original bytes; the pixels are never
 *   materialised here, because the renderer reads them itself.
 * @param {object} record the mark record for that picture
 * @param {object} request `{ views, map, cover, tile, cols, pad, grid, target,
 *   ruler, alpha, ids, captions, maxDimension }`
 * @returns {Promise<{kind: string, name: string, label: string, png: Buffer, width: number, height: number}[]>}
 */
export async function renderViews(source, record, request = {}) {
  const bytes = await prepareSource(source.bytes, source.orientation)
  const frame = { sourceWidth: source.width, sourceHeight: source.height }
  const maxDimension = Math.max(256, Math.round(request.maxDimension ?? MAX_VIEW_DIMENSION))
  const target = Math.max(256, Math.round(request.target ?? MAP_TARGET))
  const stem = stemOf(record.image)
  const addresses = Array.isArray(request.views)
    ? request.views.map((v) => String(v).trim()).filter((v) => v !== '')
    : []
  const cover = request.cover === undefined || request.cover === null ? null : String(request.cover)
  const out = []

  if (request.map === true || (addresses.length === 0 && cover === null)) {
    const drawn = await renderMap(bytes, record, { ...frame, ...request, target, maxDimension })
    out.push({ kind: 'map', name: `map_${stem}.png`, label: 'map', ...drawn })
  }

  if (cover !== null) {
    const colours = cover === 'all' || cover === '' ? null : cover.split(',').map((c) => c.trim()).filter(Boolean)
    const bad = (colours ?? []).filter((c) => !Object.hasOwn(COLOURS, c))
    if (bad.length > 0) {
      throw new Error(`unknown colour(s) ${bad.join(', ')} to cover; use ${Object.keys(COLOURS).join(', ')}, or all`)
    }
    const drawn = await renderCover(bytes, record, colours, { ...frame, ...request, target, maxDimension })
    const label = (colours ?? ['all']).join('_')
    out.push({ kind: 'cover', name: `cover_${label}_${stem}.png`, label: `cover ${label}`, ...drawn })
  }

  if (addresses.length > 0) {
    const tile = Math.max(64, Math.round(request.tile ?? 620))
    const single = addresses.length === 1
    // One address gets the full zoom budget. Several are tiles in a sheet, and a
    // tile is read at a glance beside its neighbours, so it is rendered at its
    // final size rather than large and then shrunk — shrinking would blur the
    // very numbers the sheet exists to make readable.
    const size = single ? Math.max(256, Math.round(request.target ?? ZOOM_TARGET)) : tile
    const tiles = []
    for (const spec of addresses) {
      const address = parseAddress(record, spec)
      const drawn = await renderZoom(bytes, record, address, {
        ...frame,
        ...request,
        maxWidth: size,
        maxHeight: size,
        maxDimension
      })
      tiles.push({ ...drawn, label: labelFor(record, spec), rect: drawn.rect })
    }
    if (single) {
      out.push({
        kind: 'zoom',
        name: `zoom_${addressName(addresses[0])}_${stem}.png`,
        label: tiles[0].label,
        png: tiles[0].png,
        width: tiles[0].width,
        height: tiles[0].height
      })
    } else {
      const drawn = await renderSheet(tiles, {
        tile,
        cols: request.cols,
        maxDimension
      })
      out.push({
        kind: 'sheet',
        name: `sheet_${tiles.length}_${stem}.png`,
        label: tiles.map((t) => t.label).join(', '),
        ...drawn
      })
    }
  }

  return out
}
