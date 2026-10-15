/**
 * render: the camera's square window on the picture, plus its grid, as a PNG.
 *
 * The only module that uses `sharp`: Node has no canvas, and sharp carries one
 * (librsvg), the same library the harness uses for every image a session attaches.
 *
 * There is one shape. The camera is a square window in the picture's own pixels, and
 * it may reach past the picture's edge; the raster is that same square at VIEW_SIDE,
 * whatever the window covers, with everything outside the picture black. A caller
 * never chooses a raster size, and no two results are shaped differently from each
 * other, so a view can be compared with the one before it.
 *
 * The one instrument a view carries is its grid: round positions in the picture's own
 * pixels, labelled along the edges. A caller reads a place off that grid and never
 * handles a scale.
 *
 * @module lib/render
 */

import sharp from 'sharp'

import { coordGridOverlay, markOverlay, svgOf } from './draw.js'
import { gridLines } from './views.js'

/** Longest side any raster this package builds may have. */
export const MAX_VIEW_DIMENSION = 4096

/** Longest side of a view, whatever it covers. */
export const VIEW_TARGET = 1400

/**
 * The raster every camera window is drawn at: the square window's side, in view pixels.
 * A constant, so a closer look is only ever a smaller window shown larger — never a
 * differently shaped picture.
 */
export const VIEW_SIDE = 1400

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

/**
 * The transform that puts a camera window on its raster.
 *
 * One scale for both axes — `window.side` becomes `side`, so the picture keeps its
 * shape — and the window's own origin becomes the raster's, which is where a negative
 * `x0` (the window reaching past the left edge) turns into a picture placed to the
 * right of the frame's edge.
 *
 * @param {{side: number, x0: number, y0: number}} window from `resolveCamera`
 * @param {number} [side] the raster's side; defaults to VIEW_SIDE
 */
export function viewOf(window, side = VIEW_SIDE) {
  const span = Math.max(1, window.side)
  const scale = side / span
  return {
    x0: window.x0,
    y0: window.y0,
    sx: scale,
    sy: scale,
    width: side,
    height: side
  }
}

/**
 * Composite one overlay — and, under it, the picture at its place — at exact size.
 *
 * The canvas is exactly the overlay's size, so nothing is resampled on the way out and
 * the pixels a caller samples are the pixels this drew.
 */
async function compose(view, parts) {
  const canvas = await sharp({
    create: {
      width: view.width,
      height: view.height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .composite([{ input: Buffer.from(svgOf(view, parts)), top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer()
  return canvas
}

/**
 * One camera window: the picture where the window falls on it, the rest of the square
 * black, the picture's grid over the picture, and — when asked for — the marks.
 *
 * @param {Buffer|Uint8Array} bytes the picture, already EXIF-rotated by `prepareSource`
 * @param {object} record the session's record, for its marks
 * @param {{side: number, x0: number, y0: number, x1: number, y1: number}} window
 *   from `resolveCamera`
 * @param {{picture?: {width: number, height: number}, marks?: boolean, grid?: boolean}} [opts]
 *   `picture` is the picture's own size in pixels and is required: it is what the extract
 *   is clamped to and what the grid's labels count in picture pixels. `grid: false` leaves
 *   the grid off; `marks: true` draws the record's marks, which nothing does by default.
 * @returns {Promise<{png: Buffer, width: number, height: number, grid: object|null}>}
 */
export async function renderWindow(bytes, record, window, opts = {}) {
  const picture = opts.picture
  if (!picture || !(picture.width > 0) || !(picture.height > 0)) {
    throw new Error('renderWindow needs opts.picture {width, height} to place the window on the picture')
  }
  if (!window || !(window.side > 0) || !Number.isFinite(window.x0) || !Number.isFinite(window.y0)) {
    throw new Error('renderWindow needs a window {side, x0, y0} from resolveCamera')
  }
  const view = viewOf(window, VIEW_SIDE)
  // Where the picture's top-left corner falls on the raster. Either can be negative, for a
  // window that reaches past that edge of the picture, and either can be past the raster,
  // for a window aimed off the picture altogether.
  const left = Math.round((0 - window.x0) * view.sx)
  const top = Math.round((0 - window.y0) * view.sy)
  // The part of the picture this raster can show: the intersection of the picture's
  // rectangle with the frame, on all four edges, in view pixels. A negative corner stays
  // negative here, because an `<image>` placed off the top or the left of an SVG is slid
  // back into the frame rather than clipped, and one placed past the bottom of a
  // `preserveAspectRatio: none` frame comes back stretched over it — so the picture is
  // cropped to the part that is actually visible and placed at that part's own origin.
  const visible = (from, span) => ({
    start: Math.min(span, Math.max(0, Math.round(Math.max(0, -from)))),
    end: Math.min(span, Math.max(0, Math.round(view.width - from)))
  })
  const across = visible(left, Math.round(picture.width * view.sx))
  const down = visible(top, Math.round(picture.height * view.sy))
  if (process.env.DSH_RENDER_DEBUG === '1') {
    console.log('renderWindow', JSON.stringify({ window, view, left, top, across, down }))
  }
  // A window aimed off the picture entirely: there is nothing to extract, and the frame is
  // the black square with its grid.
  const reachedPicture = across.end > across.start && down.end > down.start
  const grid = gridLines({ x0: 0, y0: 0, x1: picture.width, y1: picture.height }, view)
  const parts = []
  if (reachedPicture) {
    // The picture is decoded, cropped to the part of it this window reached and placed
    // where the window says it is. Outside it the canvas is black: the caller sees the
    // picture's edge as an edge, not as the end of the frame. The `<image>` is placed in
    // view pixels, but `extract` works in the picture's own pixels, so the crop is divided
    // back by the scale — at 2x, a 1400-view-pixel raster is only 700 picture pixels of
    // picture, and asking for 1400 of them is what "bad extract area" means.
    const crop = {
      left: Math.round(across.start / view.sx),
      top: Math.round(down.start / view.sy),
      width: Math.max(1, Math.round((across.end - across.start) / view.sx)),
      height: Math.max(1, Math.round((down.end - down.start) / view.sy))
    }
    const raster = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .extract(crop)
      .png()
      .toBuffer()
    // The picture itself is an `<image>`: the mechanism the previous renderer used, kept
    // because it puts the picture and the overlay through one raster pass. The data URI
    // has to decode before `compose` runs, so the buffer is already a PNG here.
    parts.push(`<image x="${left + across.start}" y="${top + down.start}"` +
      ` width="${across.end - across.start}" height="${down.end - down.start}"` +
      ` preserveAspectRatio="none" href="data:image/png;base64,${raster.toString('base64')}"/>`)
  }
  if (opts.grid !== false) parts.push(coordGridOverlay(view, { x0: 0, y0: 0, x1: picture.width, y1: picture.height }, opts))
  // Marks are in the picture's own pixels like everything else here, so the same view
  // places them; the overlay already drops the ones this window does not touch.
  if (opts.marks === true || opts.showMarks === true) parts.push(markOverlay(record, view, opts))
  return {
    png: await compose(view, parts),
    width: view.width,
    height: view.height,
    grid
  }
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
