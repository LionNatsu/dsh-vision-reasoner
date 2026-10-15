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
  // The part of the picture this window can show, in the picture's own pixels: the window's
  // rectangle, clipped to the picture. A window that reaches past an edge keeps the rest of
  // it, and a window aimed off the picture entirely keeps nothing. This is the crop, and it
  // is also what says where the picture goes on the raster: the corner of the crop is the
  // picture pixel that lands on the frame's own corner.
  const crop = {
    left: Math.max(0, Math.round(window.x0)),
    top: Math.max(0, Math.round(window.y0))
  }
  crop.right = Math.min(picture.width, Math.round(window.x1))
  crop.bottom = Math.min(picture.height, Math.round(window.y1))
  const reachedPicture = crop.right > crop.left && crop.bottom > crop.top
  // Where that crop lands: an `<image>` placed off the top or the left of an SVG is slid back
  // into the frame rather than clipped, and one placed past the far edge of a
  // `preserveAspectRatio: none` frame is stretched back over it, so the picture is placed at
  // the crop's own corner in view pixels and sized to the crop's own size, never larger.
  const place = {
    x: Math.round((crop.left - window.x0) * view.sx),
    y: Math.round((crop.top - window.y0) * view.sy),
    width: Math.max(1, Math.round((crop.right - crop.left) * view.sx)),
    height: Math.max(1, Math.round((crop.bottom - crop.top) * view.sy))
  }
  const grid = gridLines({ x0: 0, y0: 0, x1: picture.width, y1: picture.height }, view)
  const parts = []
  if (reachedPicture) {
    // The picture is decoded, cropped to the part of it this window reached and placed where
    // the window says it is. Outside it the canvas is black: the caller sees the picture's
    // edge as an edge, not as the end of the frame.
    const raster = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .extract({ left: crop.left, top: crop.top, width: crop.right - crop.left, height: crop.bottom - crop.top })
      .png()
      .toBuffer()
    // The picture itself is an `<image>`: the mechanism the previous renderer used, kept
    // because it puts the picture and the overlay through one raster pass. The data URI
    // has to decode before `compose` runs, so the buffer is already a PNG here.
    parts.push(`<image x="${place.x}" y="${place.y}" width="${place.width}" height="${place.height}"` +
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
