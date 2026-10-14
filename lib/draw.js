/**
 * draw: a view, as SVG, over the picture.
 *
 * Pure string builders. `lib/render.js` composites them with `sharp`, whose
 * librsvg does the drawing; Node has no canvas of its own.
 *
 * Every label is an original-image coordinate or a mark's number, whatever
 * cropping or scaling the view applies:
 *
 *     svg_x = (original_x - view.x0) * view.sx
 *     original_x = svg_x / view.sx + view.x0
 *
 * Two scales rather than one, because a fitted map rounds its two dimensions
 * independently.
 *
 * @module lib/draw
 */

import { DEFAULT_COLOUR, colourOf, markRect } from './record.js'

// The mark vocabulary — the palette and a mark's geometry — belongs to the
// record, not to the drawing code, and is re-exported here because a view is
// where a caller first needs it.
export { COLOURS, DEFAULT_COLOUR, colourOf, markPoint, markRect } from './record.js'

/** Readable tick spacings, coarsest last. */
const STEP_LADDER = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000]

/**
 * Monospace for numbers, so columns line up. A family with a space takes single
 * quotes: this string goes inside a double-quoted XML attribute, where a double
 * quote would end the attribute early and make librsvg reject the document.
 */
const MONO = "ui-monospace, Consolas, Menlo, 'DejaVu Sans Mono', monospace"
const SANS = "system-ui, 'Segoe UI', Roboto, 'DejaVu Sans', sans-serif"

/**
 * Text width, estimated: an SVG string has no font metrics behind it. Only ever
 * used to decide where a label stops, never where a mark is.
 */
export function textWidth(text, fontSize, mono = false) {
  return String(text).length * fontSize * (mono ? 0.6 : 0.55)
}

/** Cut `text` to `maxWidth`, marking the cut with an ellipsis. */
export function fitText(text, maxWidth, fontSize, mono = false) {
  const s = String(text)
  if (textWidth(s, fontSize, mono) <= maxWidth) return s
  let kept = s
  while (kept.length > 1 && textWidth(`${kept}…`, fontSize, mono) > maxWidth) kept = kept.slice(0, -1)
  return `${kept}…`
}

/** SVG is XML: a caption with an `&` in it must not break the document. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A view covering the whole image at 1:1. */
export function identityView(width, height) {
  return { x0: 0, y0: 0, sx: 1, sy: 1, width, height }
}

/** A view fitting an image into `target` on its longest side, never enlarging. */
export function fitView(width, height, target) {
  const scale = Math.min(1, target / Math.max(width, height))
  if (scale >= 1) return identityView(width, height)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  return { x0: 0, y0: 0, sx: w / width, sy: h / height, width: w, height: h }
}

export function toRasterX(view, x) { return (x - view.x0) * view.sx }
export function toRasterY(view, y) { return (y - view.y0) * view.sy }

/** `#rrggbb` for a colour name, or for an rgb triple. */
export function hexOf(colour) {
  const rgb = Array.isArray(colour) ? colour : colourOf({ colour })
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

/** Outline thickness in view pixels, never hairline. */
function strokeWidth(view) {
  return Math.max(2, Math.round(5 * Math.min(2, Math.max(view.sx, view.sy))))
}

/** Label size for a whole-frame view. */
export function labelSize(view) {
  return clamp(Math.round(11 * Math.max(1, Math.min(view.sx, view.sy))), 11, 30)
}

function text(x, y, body, opts = {}) {
  const anchor = opts.anchor ?? 'start'
  const weight = opts.bold === false ? '' : ' font-weight="bold"'
  const stroke = opts.outline === false
    ? ''
    : ` stroke="#000000" stroke-width="${Math.max(2, Math.round((opts.size ?? 16) / 6))}"` +
      ' stroke-linejoin="round" paint-order="stroke"'
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${opts.mono === false ? SANS : MONO}"` +
    ` font-size="${opts.size ?? 16}"${weight} fill="${opts.fill ?? '#ffffff'}"` +
    ` text-anchor="${anchor}"${stroke}>${escapeXml(body)}</text>`
}

/** One mark's outline, in view coordinates. */
function markShape(mark, view, opts) {
  const [x0, y0, x1, y1] = markRect(mark)
  const left = toRasterX(view, x0)
  const top = toRasterY(view, y0)
  const right = toRasterX(view, x1)
  const bottom = toRasterY(view, y1)
  const width = opts.stroke ?? strokeWidth(view)
  const colour = hexOf(colourOf(mark))
  if (mark.kind === 'point') {
    const rx = Math.max(1, (right - left) / 2)
    const ry = Math.max(1, (bottom - top) / 2)
    // An ellipse rather than a circle: a point mark is a square in original
    // pixels, and forcing it round would move it off the place it names.
    return `<ellipse cx="${((left + right) / 2).toFixed(1)}" cy="${((top + bottom) / 2).toFixed(1)}"` +
      ` rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`
  }
  return `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, right - left).toFixed(1)}"` +
    ` height="${Math.max(1, bottom - top).toFixed(1)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`
}

/** Where a mark's number sits: just above its top-left corner, kept inside. */
function markLabelAt(mark, view, size) {
  const [x0, y0] = markRect(mark)
  const left = toRasterX(view, x0)
  const top = toRasterY(view, y0)
  const x = clamp(left + 2, 0, Math.max(0, view.width - textWidth(String(mark.id), size, true) - 2))
  const y = clamp(top - 4, size, view.height - 2)
  return { x, y }
}

/**
 * The whole-frame overlay: every mark, its number, and the ruler. The ruler is
 * what makes a scaled-down map safe: a position has to be read off the labels,
 * not off a proportion of the preview, which is always wrong and never looks
 * wrong.
 */
export function mapOverlay(record, view, opts = {}) {
  const size = opts.size ?? labelSize(view)
  const parts = []
  const marks = record.marks ?? []
  for (const mark of marks) {
    parts.push(markShape(mark, view, opts))
  }
  // Numbers go on after every ring. Where marks cluster, the rings overlap — a
  // number drawn with its own ring would be painted over by the next one, leaving
  // a mark that cannot be named. The number is the address, so it goes on top.
  for (const mark of marks) {
    if (opts.ids === false) break
    const at = markLabelAt(mark, view, size)
    parts.push(text(at.x, at.y, String(mark.id), { size, fill: hexOf(colourOf(mark)) }))
  }
  if (opts.ruler !== false) parts.push(ruler(view, opts))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">` +
    `${parts.join('')}</svg>`
}

/**
 * Original-coordinate ticks along the edges.
 *
 * A fixed step is readable at 1:1 and a smear of digits on a fitted map, so the
 * step is chosen to keep neighbouring labels apart on BOTH axes — their spacing
 * is `step * sx` across and `step * sy` down, which differ by an order of
 * magnitude on an extreme aspect ratio. An unreadable ruler is worse than none,
 * because it still looks authoritative.
 *
 * Each tick is a short line with a label beside it, and the line is the
 * coordinate: a label for the last tick is nudged inwards to stay on the canvas,
 * and the line keeps that from becoming a lie.
 */
export function ruler(view, opts = {}) {
  const size = opts.size ?? clamp(Math.round(labelSize(view) * 0.85), 10, 24)
  const colour = opts.colour ?? '#00ffff'
  const arm = Math.max(4, Math.round(size * 0.5))
  const parts = []
  const right = view.x0 + view.width / view.sx
  const bottom = view.y0 + view.height / view.sy
  const step = Math.max(1, Math.round(opts.step ?? readableStep(view, right, bottom, size)))
  for (let x = Math.ceil(view.x0 / step) * step; x <= right; x += step) {
    const px = toRasterX(view, x)
    if (px < 0 || px > view.width) continue
    const label = String(x)
    const half = textWidth(label, size, true) / 2
    const at = clamp(px, half, view.width - half)
    parts.push(`<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${arm}"` +
      ` stroke="${colour}" stroke-width="1" opacity="0.7"/>`)
    parts.push(`<line x1="${px.toFixed(1)}" y1="${(view.height - arm).toFixed(1)}"` +
      ` x2="${px.toFixed(1)}" y2="${view.height}" stroke="${colour}" stroke-width="1" opacity="0.7"/>`)
    parts.push(text(at, size + 2, label, { size, fill: colour, anchor: 'middle', mono: true }))
    parts.push(text(at, view.height - 4, label, { size, fill: colour, anchor: 'middle', mono: true }))
  }
  for (let y = Math.ceil(view.y0 / step) * step; y <= bottom; y += step) {
    const py = toRasterY(view, y)
    if (py < 0 || py > view.height) continue
    // The baseline sits a third of an em below the line so the DIGITS straddle
    // the coordinate; a baseline on the line would put every y label a half-line
    // low, which is a 14-pixel error on a fitted map.
    parts.push(`<line x1="0" y1="${py.toFixed(1)}" x2="${arm}" y2="${py.toFixed(1)}"` +
      ` stroke="${colour}" stroke-width="1" opacity="0.7"/>`)
    parts.push(text(4, py + size * 0.35, String(y), { size, fill: colour, mono: true }))
  }
  return parts.join('')
}

/**
 * The finest readable tick spacing for this view, on whichever axis needs the
 * coarser one: labels need room across, and consecutive rows need room down.
 */
function readableStep(view, right, bottom, size) {
  const across = (textWidth(String(Math.round(right)), size, true) * 1.5) / Math.max(1e-6, view.sx)
  const down = (size * 1.8) / Math.max(1e-6, view.sy)
  const needed = Math.max(across, down)
  for (const candidate of STEP_LADDER) {
    if (candidate >= needed) return candidate
  }
  return STEP_LADDER[STEP_LADDER.length - 1]
}

/**
 * A zoom's overlay: a labelled coordinate grid, a crosshair on the address the
 * view was asked for, then every mark that touches the view. The crosshair puts
 * one position on the tile beyond reading — a grid read by eye lands tens of
 * pixels off — so a caller can see how far off its own reading was, instead of
 * interpolating between grid lines.
 */
export function zoomOverlay(record, view, opts = {}) {
  const size = opts.size ?? clamp(Math.round(13 * Math.max(1, Math.min(view.sx, view.sy))), 13, 34)
  const step = Math.max(1, Math.round(opts.grid ?? 100))
  const parts = []
  const right = view.x0 + view.width / view.sx
  const bottom = view.y0 + view.height / view.sy
  const grid = []
  for (let x = Math.ceil(view.x0 / step) * step; x <= right; x += step) {
    const px = toRasterX(view, x)
    if (px < 0 || px > view.width) continue
    grid.push(`<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${view.height}"` +
      ' stroke="#00ffff" stroke-width="1" opacity="0.28"/>')
    const label = String(x)
    const half = textWidth(label, Math.round(size * 0.8), true) / 2
    grid.push(text(clamp(px, half, view.width - half), view.height - 4, label,
      { size: Math.round(size * 0.8), fill: '#00ffff', anchor: 'middle', mono: true }))
  }
  for (let y = Math.ceil(view.y0 / step) * step; y <= bottom; y += step) {
    const py = toRasterY(view, y)
    if (py < 0 || py > view.height) continue
    grid.push(`<line x1="0" y1="${py.toFixed(1)}" x2="${view.width}" y2="${py.toFixed(1)}"` +
      ' stroke="#00ffff" stroke-width="1" opacity="0.28"/>')
    grid.push(text(3, py + Math.round(size * 0.8) + 1, String(y),
      { size: Math.round(size * 0.8), fill: '#00ffff', mono: true }))
  }
  parts.push(grid.join(''))

  if (opts.anchor !== undefined && opts.anchor !== null) {
    const [ax, ay] = opts.anchor
    const px = toRasterX(view, ax)
    const py = toRasterY(view, ay)
    if (px >= 0 && px <= view.width && py >= 0 && py <= view.height) {
      const arm = Math.max(10, Math.round(size * 0.9))
      const stroke = 'stroke="#ff00ff" stroke-width="2"'
      parts.push(`<line x1="${(px - arm).toFixed(1)}" y1="${py.toFixed(1)}"` +
        ` x2="${(px + arm).toFixed(1)}" y2="${py.toFixed(1)}" ${stroke}/>`)
      parts.push(`<line x1="${px.toFixed(1)}" y1="${(py - arm).toFixed(1)}"` +
        ` x2="${px.toFixed(1)}" y2="${(py + arm).toFixed(1)}" ${stroke}/>`)
      const label = `${ax},${ay}`
      const lx = clamp(px + arm + 4, 0, view.width - textWidth(label, size, true) - 4)
      const ly = clamp(py - arm - 4, size, view.height - 4)
      parts.push(text(lx, ly, label, { size, fill: '#ff00ff', mono: true }))
    }
  }

  const marks = record.marks ?? []
  for (const mark of marks) {
    const [mx0, my0, mx1, my1] = markRect(mark)
    const left = toRasterX(view, mx0)
    const top = toRasterY(view, my0)
    const shapeRight = toRasterX(view, mx1)
    const shapeBottom = toRasterY(view, my1)
    // A mark entirely outside this view contributes nothing; one that overlaps
    // only the edge is still drawn, because a ring cut off by the border is how
    // the caller learns the mark is there at all.
    if (shapeRight < 0 || shapeBottom < 0 || left > view.width || top > view.height) continue
    parts.push(markShape(mark, view, opts))
    if (opts.ids === false) continue
    const caption = opts.captions === false ? '' : String(mark.caption ?? '').trim()
    const head = caption === '' ? `#${mark.id}` : `#${mark.id} ${caption}`
    const room = Math.max(textWidth(`#${mark.id}`, size, true), view.width - Math.max(0, left) - 6)
    const x = clamp(left + 2, 0, view.width - 4)
    const y = clamp(top - 4, size, view.height - 2)
    parts.push(text(x, y, fitText(head, room, size, true), { size, fill: hexOf(colourOf(mark)) }))
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">` +
    `${parts.join('')}</svg>`
}

/**
 * The cover overlay: paint the given colours out. A mark left on empty background
 * shows up as a black blob, and what has no blob over it was missed. It catches
 * slips in keeping the record, not mistakes in perception.
 */
export function coverOverlay(record, view, colours, opts = {}) {
  const wanted = colours === null || colours === undefined ? null : new Set(colours)
  const opacity = clamp((opts.alpha ?? 235) / 255, 0, 1)
  const parts = []
  for (const mark of record.marks ?? []) {
    if (wanted !== null && !wanted.has(String(mark.colour ?? DEFAULT_COLOUR))) continue
    const [x0, y0, x1, y1] = markRect(mark)
    const left = toRasterX(view, x0)
    const top = toRasterY(view, y0)
    const width = Math.max(1, toRasterX(view, x1) - left)
    const height = Math.max(1, toRasterY(view, y1) - top)
    if (mark.kind === 'point') {
      parts.push(`<ellipse cx="${(left + width / 2).toFixed(1)}" cy="${(top + height / 2).toFixed(1)}"` +
        ` rx="${(width / 2).toFixed(1)}" ry="${(height / 2).toFixed(1)}" fill="#000000" opacity="${opacity}"/>`)
    } else {
      parts.push(`<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}"` +
        ` height="${height.toFixed(1)}" fill="#000000" opacity="${opacity}"/>`)
    }
  }
  if (opts.ruler === true) parts.push(ruler(view, opts))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">` +
    `${parts.join('')}</svg>`
}

/**
 * The sheet overlay: one frame and one caption per tile, over the assembled
 * canvas. A sheet exists because pictures received separately cannot be compared,
 * and a tile is labelled with the mark's own number and caption rather than an
 * index into a list the reader has to hold in their head.
 */
export function sheetOverlay(tiles, layout, opts = {}) {
  const size = opts.size ?? clamp(Math.round(layout.labelHeight * 0.5), 12, 26)
  const parts = []
  for (let i = 0; i < tiles.length; i++) {
    const { x, y, width, height } = layout.tileRect(i)
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none"` +
      ' stroke="#50505a" stroke-width="2"/>')
    parts.push(text(x + 3, y - Math.round(layout.labelHeight * 0.28),
      fitText(tiles[i].label, width - 6, size, false), { size, fill: '#ffeb00' }))
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">` +
    `${parts.join('')}</svg>`
}

