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

import { colourOf, markRect } from './record.js'
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
 * that number along all four edges. A caller estimates between two labelled lines and
 * says the number it sees; the numbers are original-image pixels whatever the view's
 * size, so no scale is ever converted.
 *
 * The axes are told apart by colour — the columns that run down are cyan, the rows that
 * run across are amber — because a caller that takes one axis for the other is wrong in
 * a way no number reveals. A row label is kept out of the band where the column labels
 * write, so a corner is not a fight between two numbers.
 */
export function coordGridOverlay(view, region, opts = {}) {
  const size = opts.size ?? edgeLabelSize(view)
  const across = opts.across ?? '#22d3ee'
  const down = opts.down ?? '#f5b942'
  const width = guideWidth(view)
  const opacity = opts.opacity ?? 0.32
  const band = Math.round(size * 1.8)
  const lines = gridLines(region, view)
  // The picture's rectangle on this raster. A window may reach past the picture, and the
  // space outside it is black: a grid line or a coordinate floating out there measures
  // nothing, so every line and every label is kept inside the picture.
  const left = clamp(toRasterX(view, region.x0), 0, view.width)
  const right = clamp(toRasterX(view, region.x1), 0, view.width)
  const top = clamp(toRasterY(view, region.y0), 0, view.height)
  const bottom = clamp(toRasterY(view, region.y1), 0, view.height)
  const parts = []
  for (const x of lines.across) {
    const px = toRasterX(view, x)
    if (px < left || px > right) continue
    parts.push(`<line x1="${px.toFixed(1)}" y1="${top.toFixed(1)}" x2="${px.toFixed(1)}" y2="${bottom.toFixed(1)}"` +
      ` stroke="${across}" stroke-width="${width}" opacity="${opacity}"/>`)
    const label = String(x)
    const half = textWidth(label, size, true) / 2
    const at = clamp(px, Math.max(left, half), Math.min(right, view.width - half))
    parts.push(text(at, top + size + 2, label, { size, fill: across, anchor: 'middle', mono: true }))
    parts.push(text(at, bottom - 4, label, { size, fill: across, anchor: 'middle', mono: true }))
  }
  for (const y of lines.down) {
    const py = toRasterY(view, y)
    if (py < top || py > bottom) continue
    parts.push(`<line x1="${left.toFixed(1)}" y1="${py.toFixed(1)}" x2="${right.toFixed(1)}" y2="${py.toFixed(1)}"` +
      ` stroke="${down}" stroke-width="${width}" opacity="${opacity}"/>`)
    // The band at the top and the bottom belongs to the column labels.
    if (py < top + band || py > bottom - band) continue
    // The baseline sits a third of an em below the line so the digits straddle the
    // coordinate rather than hang under it.
    parts.push(text(left + 4, py + size * 0.35, String(y), { size, fill: down, mono: true }))
    parts.push(text(right - 4, py + size * 0.35, String(y), { size, fill: down, anchor: 'end', mono: true }))
  }
  return parts.join('')
}

/**
 * Label boxes are measured in view pixels with the module's own width estimate —
 * an SVG string has no font metrics behind it — and every box a view has already
 * drawn is kept, so a second label is never laid over the first. Two numbers in
 * one place are worse than a mark with no number: a reader that takes ring 8's
 * number for ring 1's is wrong about where a mark is, and the picture cannot
 * repair that.
 */
const LABEL_GAP = 2
const LABEL_PAD = 3

/** The box one label occupies: one em above its baseline, a quarter of one below. */
function labelBox(x, baseline, width, size) {
  return { x0: x, y0: baseline - size, x1: x + width, y1: baseline + Math.round(size * 0.25) }
}

/** True where two label boxes are drawn over each other, or closer than `gap`. */
function boxesCollide(a, b, gap = LABEL_GAP) {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap
}

/**
 * The four places a label is tried for one mark, in the order fixed here: above
 * the ring and left-aligned to it, above it and shifted clear of it to the right,
 * below it, and last inside the top of the ring. `clear` is measured from the
 * ring's outline rather than from its geometric edge, because that outline is
 * stroked several pixels wide.
 */
function labelPlaces(rect, size, width, clear) {
  const desc = Math.round(size * 0.25)
  const cx = (rect.left + rect.right) / 2
  return [
    { x: rect.left + LABEL_PAD, y: rect.top - desc - clear },
    { x: rect.right + clear, y: rect.top - desc - clear },
    { x: rect.left + LABEL_PAD, y: rect.bottom + size + clear },
    { x: Math.round(cx - width / 2), y: rect.top + size + LABEL_PAD }
  ]
}

/**
 * Put `body` beside one mark, or return null. A place is taken only if its whole
 * box fits inside the view and meets none of the boxes already drawn; a place that
 * runs off an edge is slid back inside, and one that collides is passed over. The
 * same box geometry is used to draw and to test, so what is checked is what lands
 * on the picture.
 */
function placeLabel(body, rect, size, view, drawn, clear) {
  const width = textWidth(body, size, true)
  if (width > view.width) return null
  const maxX = view.width - width
  const maxY = Math.max(size, view.height - 2 - Math.round(size * 0.25))
  for (const place of labelPlaces(rect, size, width, clear)) {
    const x = clamp(place.x, 0, maxX)
    const y = clamp(place.y, size, maxY)
    const box = labelBox(x, y, width, size)
    if (drawn.some((other) => boxesCollide(box, other))) continue
    return { x, y, body, box }
  }
  return null
}

/**
 * Every mark that touches the view, in the caller's own colours.
 *
 * Numbers go on after every ring: where marks cluster the rings overlap, and a
 * number drawn with its own ring would be painted over by the next one, leaving a
 * mark that cannot be named. The number is the address, so it goes on top.
 *
 * A label that fits nowhere without meeting another label loses its caption first
 * and then, failing that, is not drawn at all: the result text carries every
 * mark's number and caption, so a missing label costs a reader nothing while a
 * label read under the wrong ring costs them the picture.
 */
export function markOverlay(record, view, opts = {}) {
  const size = opts.size ?? labelSize(view)
  const parts = []
  const drawn = []
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
  // A label clears the ring's drawn outline, not the box that outline is centred on.
  const clear = LABEL_PAD + Math.round((opts.stroke ?? strokeWidth(view)) / 2)
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
    const alone = `#${mark.id}`
    const head = caption === '' ? alone : `${alone} ${caption}`
    const rect = { left, top, right, bottom }
    const placed = placeLabel(head, rect, size, view, drawn, clear) ??
      (head === alone ? null : placeLabel(alone, rect, size, view, drawn, clear))
    if (placed === null) continue
    parts.push(text(placed.x, placed.y, placed.body, { size, fill: hexOf(colourOf(mark)) }))
    drawn.push(placed.box)
  }
  return parts.join('')
}

/**
 * The sheet's overlay: one frame and one caption per tile, over the assembled canvas. A
 * sheet exists because pictures received separately cannot be lined up side by side, and a
 * tile is labelled with where it came from rather than an index into a list the reader has
 * to hold in their head.
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
