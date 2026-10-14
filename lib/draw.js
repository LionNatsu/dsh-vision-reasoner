/**
 * draw: a view, as SVG, over the picture.
 *
 * Pure string builders. `lib/render.js` composites them with `sharp`, whose
 * librsvg does the drawing; Node has no canvas of its own.
 *
 * The one instrument a view carries is its grid: cell lines, with the letters and
 * numbers that name them along the edges. A caller reads a place off that grid —
 * `C3` — and never handles picture coordinates.
 *
 *     svg_x = (original_x - view.x0) * view.sx
 *     original_x = svg_x / view.sx + view.x0
 *
 * Two scales rather than one, because a fitted view rounds its two dimensions
 * independently.
 *
 * @module lib/draw
 */

import { DEFAULT_COLOUR, colourOf, markRect } from './record.js'
import { gridLines } from './views.js'

// The mark vocabulary — the palette and a mark's geometry — belongs to the
// record, not to the drawing code, and is re-exported here because a view is
// where a caller first needs it.
export { COLOURS, DEFAULT_COLOUR, colourOf, markPoint, markRect } from './record.js'

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

/** A view covering the whole picture at 1:1. */
export function identityView(width, height) {
  return { x0: 0, y0: 0, sx: 1, sy: 1, width, height }
}

/** A view fitting a region into `target` on its longest side, never enlarging. */
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

/**
 * Outline thickness in view pixels. The attachment pipeline re-encodes a view
 * before the reader sees it and a 1px line does not survive that, so everything
 * drawn has a floor of 2-3 pixels and grows with the view.
 */
function strokeWidth(view) {
  return Math.max(3, Math.round(5 * Math.min(2, Math.max(view.sx, view.sy))))
}

/** Guide-line thickness, on the same rule: grid lines are never hairlines. */
function guideWidth(view) {
  return Math.max(2, Math.round(2 * Math.min(2, Math.max(view.sx, view.sy))))
}

/** Label size for a whole-picture view. */
export function labelSize(view) {
  return clamp(Math.round(11 * Math.max(1, Math.min(view.sx, view.sy))), 11, 30)
}

/** The size of the letters and numbers a grid puts on the edges. */
export function edgeLabelSize(view) {
  return clamp(Math.round(Math.min(view.width, view.height) / 38), 11, 22)
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
    // An ellipse rather than a circle: a point mark is a square in picture
    // pixels, and forcing it round would move it off the place it names.
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    // A ring says roughly where; the cross says exactly where. Without it a caller
    // cannot tell a mark five pixels off a face from one on it — a session wrote its
    // own crosshair overlay in Python rather than judge by the ring.
    const arm = clamp(Math.round(Math.min(rx, ry) * 0.5), 5, 30)
    const cross = `<line x1="${(cx - arm).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + arm).toFixed(1)}"` +
      ` y2="${cy.toFixed(1)}" stroke="${colour}" stroke-width="${width}"/>` +
      `<line x1="${cx.toFixed(1)}" y1="${(cy - arm).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(cy + arm).toFixed(1)}"` +
      ` stroke="${colour}" stroke-width="${width}"/>`
    return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}"` +
      ` rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${colour}" stroke-width="${width}"/>` +
      cross
  }
  return `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, right - left).toFixed(1)}"` +
    ` height="${Math.max(1, bottom - top).toFixed(1)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`
}

/** Wrap overlay fragments into one SVG document. */
export function svgOf(view, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">` +
    `${parts.join('')}</svg>`
}

/**
 * The grid: lines at round positions in the picture's own pixels, each labelled with
 * that number along all four edges. A caller estimates between two labelled lines
 * and says the number it sees; the numbers are original-image pixels whatever the
 * view's size, so no scale is ever converted.
 */
export function coordGridOverlay(view, region, opts = {}) {
  const size = opts.size ?? edgeLabelSize(view)
  const colour = opts.colour ?? '#00ffff'
  const width = guideWidth(view)
  const opacity = opts.opacity ?? 0.32
  const { across, down } = gridLines(region, view)
  const parts = []
  for (const x of across) {
    const px = toRasterX(view, x)
    if (px < 0 || px > view.width) continue
    parts.push(`<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${view.height}"` +
      ` stroke="${colour}" stroke-width="${width}" opacity="${opacity}"/>`)
    const label = String(x)
    const half = textWidth(label, size, true) / 2
    const at = clamp(px, half, view.width - half)
    parts.push(text(at, size + 2, label, { size, fill: colour, anchor: 'middle', mono: true }))
    parts.push(text(at, view.height - 4, label, { size, fill: colour, anchor: 'middle', mono: true }))
  }
  for (const y of down) {
    const py = toRasterY(view, y)
    if (py < 0 || py > view.height) continue
    parts.push(`<line x1="0" y1="${py.toFixed(1)}" x2="${view.width}" y2="${py.toFixed(1)}"` +
      ` stroke="${colour}" stroke-width="${width}" opacity="${opacity}"/>`)
    // The baseline sits a third of an em below the line so the digits straddle the
    // coordinate rather than hang under it.
    parts.push(text(4, py + size * 0.35, String(y), { size, fill: colour, mono: true }))
    parts.push(text(view.width - 4, py + size * 0.35, String(y), { size, fill: colour, anchor: 'end', mono: true }))
  }
  return parts.join('')
}

/**
 * Every mark that touches the view, in the caller's own colours.
 *
 * Numbers go on after every ring: where marks cluster the rings overlap, and a
 * number drawn with its own ring would be painted over by the next one, leaving a
 * mark that cannot be named. The number is the address, so it goes on top.
 */
export function markOverlay(record, view, opts = {}) {
  const size = opts.size ?? labelSize(view)
  const parts = []
  const marks = record.marks ?? []
  for (const mark of marks) {
    const [, my0, , my1] = markRect(mark)
    const top = toRasterY(view, my0)
    const bottom = toRasterY(view, my1)
    const left = toRasterX(view, markRect(mark)[0])
    const right = toRasterX(view, markRect(mark)[2])
    // A mark entirely outside this view contributes nothing; one that overlaps
    // only the edge is still drawn, because a ring cut off by the border is how
    // the caller learns the mark is there at all.
    if (right < 0 || bottom < 0 || left > view.width || top > view.height) continue
    parts.push(markShape(mark, view, opts))
  }
  for (const mark of marks) {
    const [x0, y0, x1, y1] = markRect(mark)
    const left = toRasterX(view, x0)
    const top = toRasterY(view, y0)
    const right = toRasterX(view, x1)
    const bottom = toRasterY(view, y1)
    if (right < 0 || bottom < 0 || left > view.width || top > view.height) continue
    // A comparison tile is already captioned above, so the mark it shows does not
    // need its number drawn a second time inside the tile.
    if (mark.id === opts.skipLabelFor) continue
    const caption = opts.captions === false ? '' : String(mark.caption ?? '').trim()
    const head = caption === '' ? `#${mark.id}` : `#${mark.id} ${caption}`
    const room = Math.max(textWidth(`#${mark.id}`, size, true), view.width - Math.max(0, left) - 6)
    const x = clamp(left + 2, 0, view.width - 4)
    const y = clamp(top - 4, size, view.height - 2)
    parts.push(text(x, y, fitText(head, room, size, true), { size, fill: hexOf(colourOf(mark)) }))
  }
  return parts.join('')
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
  return parts.join('')
}

/**
 * The comparison sheet's overlay: one frame and one caption per tile, over the
 * assembled canvas. A sheet exists because pictures received separately cannot be
 * compared, and a tile is labelled with the mark's own number and caption rather
 * than an index into a list the reader has to hold in their head.
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
  return parts.join('')
}
