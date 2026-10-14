/**
 * record: one picture's marks, and the only two functions that change them.
 *
 * Both are pure, because the session log is replayed through them: a record
 * rebuilt after a restart has to be the record the live call produced. Both throw
 * on bad input rather than repairing it — a record that absorbed a malformed mark
 * would be wrong in a way nothing else can detect.
 *
 * A record carries no image dimensions: reading a file header is not pure. The
 * views probe it when they need it.
 *
 * @module lib/record
 */

import { gridFor, placeOn, radiusFor, viewRegion } from './views.js'

/** Radius of a point mark in original pixels when the caller does not say. */
export const DEFAULT_RADIUS = 60

/** The palette. What each colour means belongs to the caller. */
export const COLOURS = {
  green: [0, 255, 0],
  yellow: [255, 235, 0],
  red: [255, 60, 60],
  blue: [0, 190, 255],
  orange: [255, 150, 0],
  magenta: [255, 0, 255],
  grey: [205, 205, 205]
}

export const DEFAULT_COLOUR = 'green'

/** Longest caption stored; a tile truncates for display. */
export const MAX_CAPTION = 200

/** Validate a colour name, naming the palette in the error. */
export function colourName(name) {
  const value = String(name)
  if (!Object.hasOwn(COLOURS, value)) {
    throw new Error(`unknown colour ${JSON.stringify(value)}; use one of ${Object.keys(COLOURS).join(', ')}`)
  }
  return value
}

/** A mark's RGB. An unreadable name falls back to the default: this is the drawing
 *  path, where a wrong colour is better than no picture. */
export function colourOf(mark) {
  return COLOURS[String(mark.colour ?? DEFAULT_COLOUR)] ?? COLOURS[DEFAULT_COLOUR]
}

/** A mark's box in ORIGINAL pixels, inclusive on all four sides. */
export function markRect(mark) {
  if (mark.kind === 'point') {
    const r = Number(mark.r ?? DEFAULT_RADIUS)
    return [mark.x - r, mark.y - r, mark.x + r, mark.y + r]
  }
  if (mark.kind === 'box') return [mark.x0, mark.y0, mark.x1, mark.y1]
  throw new Error(`mark ${mark.id} has unknown kind ${JSON.stringify(mark.kind)}`)
}

/** A mark's centre in ORIGINAL pixels. */
export function markPoint(mark) {
  if (mark.kind === 'point') return [mark.x, mark.y]
  const [x0, y0, x1, y1] = markRect(mark)
  return [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]
}

/** An empty record for one picture. */
export function emptyRecord(image) {
  return { image: String(image), marks: [] }
}

/**
 * The next free number: one past the highest in use. A number freed by a removal
 * is handed out again, which costs nothing — `findMark` refuses a stale `#2`
 * anyway — where a counter would be another field to keep in step.
 */
export function nextId(record) {
  return 1 + record.marks.reduce((max, mark) => Math.max(max, mark.id), 0)
}

/**
 * A record's identity: the absolute, normalised image path. Pure on purpose — the
 * fold cannot stat a file — so the live and the replay path resolve it from the
 * same two facts: the string the caller wrote and the session's working directory.
 */
export function imageKey(image, cwd) {
  let p = String(image).trim().replace(/\\/g, '/')
  const written = p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('//')
  if (!written && cwd) p = `${String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`
  // Resolving a relative path against an absolute working directory produces an
  // absolute path: absoluteness is a property of the joined string, not of what
  // the caller happened to type.
  const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('//')
  const out = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') { out.pop(); continue }
    if (part === '..' && isAbsolute) continue
    out.push(part)
  }
  const joined = (isAbsolute ? '/' : '') + out.join('/')
  // A Windows path is case-insensitive, so two spellings of one file must not
  // become two records, each answering to its own `#1`; the whole path is folded
  // there. A POSIX path is case-sensitive and keeps its case.
  const windows = /^\/?[a-zA-Z]:\//.test(joined) || joined.startsWith('//') || String(image).includes('\\')
  const folded = windows ? joined.toLowerCase() : joined
  // `d:/x` is a Windows absolute path; the leading slash the join adds to mark
  // absoluteness is not part of it.
  return folded.replace(/^\/([a-z]):\//, '$1:/')
}

/** Look one mark up by number, with or without the `#` the picture draws. */
export function findMark(record, key) {
  const wanted = String(key).trim().replace(/^#/, '')
  const mark = record.marks.find((m) => String(m.id) === wanted)
  if (!mark) throw new Error(`no mark #${wanted} in this record`)
  return mark
}

/** `12,34` / `12 34` / `12.5,34` -> integers. */
export function splitInts(value) {
  const parts = String(value).replace(/,/g, ' ').trim().split(/\s+/).filter((s) => s !== '')
  if (parts.length === 0) throw new Error(`expected coordinates, got ${JSON.stringify(String(value))}`)
  return parts.map((part) => {
    const n = Number(part)
    if (!Number.isFinite(n)) throw new Error(`coordinate ${JSON.stringify(part)} is not a number`)
    return Math.round(n)
  })
}

/** Resolve `#17`, `640,480` or `120,240,360,520`; the number of coordinates
 *  decides which of the last two it is. */
export function parseAddress(record, spec) {
  const s = String(spec).trim()
  if (s.startsWith('#')) {
    const mark = findMark(record, s.slice(1))
    return { kind: mark.kind, rect: markRect(mark), point: markPoint(mark), mark, spec: s }
  }
  const nums = splitInts(s)
  if (nums.length === 2) {
    return { kind: 'point', rect: [nums[0], nums[1], nums[0], nums[1]], point: [nums[0], nums[1]], mark: null, spec: s }
  }
  if (nums.length === 4) {
    return {
      kind: 'rect',
      rect: nums,
      point: [Math.round((nums[0] + nums[2]) / 2), Math.round((nums[1] + nums[3]) / 2)],
      mark: null,
      spec: s
    }
  }
  throw new Error(`cannot read address ${JSON.stringify(s)}: expected #id, x,y or x0,y0,x1,y1`)
}

function requireArray(value, what) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${what} must be a non-empty array`)
  }
  return value
}

function captionOf(value) {
  if (value === undefined || value === null) return ''
  const text = String(value)
  if (text.length > MAX_CAPTION) {
    throw new Error(`caption is ${text.length} characters; the record keeps at most ${MAX_CAPTION}`)
  }
  return text
}

function radiusOf(value) {
  if (value === undefined || value === null) return DEFAULT_RADIUS
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`radius must be a positive number, got ${JSON.stringify(value)}`)
  return Math.round(n)
}

function markFromInput(input, id) {
  if (input === null || typeof input !== 'object') throw new Error('each mark must be an object')
  const at = input.at === undefined ? null : splitInts2(input.at, 'at')
  const box = input.box === undefined ? null : splitInts2(input.box, 'box')
  const kind = input.kind === undefined ? (box !== null ? 'box' : at !== null ? 'point' : null) : String(input.kind)
  const mark = { id, kind }
  if (kind === 'point') {
    if (at === null || at.length !== 2) {
      throw new Error(`mark ${id}: a point needs "at":[x,y]`)
    }
    mark.x = at[0]
    mark.y = at[1]
    mark.r = radiusOf(input.r)
  } else if (kind === 'box') {
    if (box === null || box.length !== 4) {
      throw new Error(`mark ${id}: a box needs "box":[x0,y0,x1,y1]`)
    }
    mark.x0 = Math.min(box[0], box[2])
    mark.y0 = Math.min(box[1], box[3])
    mark.x1 = Math.max(box[0], box[2])
    mark.y1 = Math.max(box[1], box[3])
    if (input.r !== undefined) throw new Error(`mark ${id}: a box has no radius`)
  } else {
    throw new Error(`mark ${id}: kind must be "point" or "box", got ${JSON.stringify(input.kind)}`)
  }
  mark.caption = captionOf(input.caption)
  mark.colour = colourName(input.colour ?? DEFAULT_COLOUR)
  return mark
}

function splitInts2(value, field) {
  if (!Array.isArray(value)) throw new Error(`"${field}" must be an array of numbers`)
  const nums = value.map((v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`"${field}" contains ${JSON.stringify(v)}, which is not a number`)
    return Math.round(n)
  })
  return nums
}

/**
 * Add marks, numbered in the order given: the numbers a caller is told are the
 * numbers a replay computes.
 *
 * @returns {{record: object, result: {marked: number[]}}}
 */
export function applyMarkArgs(record, args) {
  const inputs = requireArray(args?.marks, 'marks')
  const next = { image: record.image, marks: record.marks.map((m) => ({ ...m })) }
  const marked = []
  for (const input of inputs) {
    const mark = markFromInput(input, nextId(next))
    next.marks.push(mark)
    marked.push(mark.id)
  }
  return { record: next, result: { marked } }
}

/** Move, recaption, recolour or delete marks. One operation may do several of
 *  those, and one call may hold many operations.
 *
 *  @returns {{record: object, result: {updated: object, removed: number[]}}} */
export function applyUpdateArgs(record, args) {
  const ops = requireArray(args?.ops, 'ops')
  const next = { image: record.image, marks: record.marks.map((m) => ({ ...m })) }
  const updated = {}
  const removed = []
  for (const op of ops) {
    if (op === null || typeof op !== 'object') throw new Error('each op must be an object')
    const target = findMark(next, op.id)
    if (op.remove === true) {
      next.marks = next.marks.filter((m) => m !== target)
      removed.push(target.id)
      continue
    }
    const touched = {}
    if (op.move !== undefined) {
      const nums = splitInts2(op.move, 'move')
      if (target.kind === 'point') {
        if (nums.length !== 2) throw new Error(`mark #${target.id} is a point: move needs [x,y]`)
        target.x = nums[0]
        target.y = nums[1]
      } else {
        if (nums.length !== 4) throw new Error(`mark #${target.id} is a box: move needs [x0,y0,x1,y1]`)
        target.x0 = Math.min(nums[0], nums[2])
        target.y0 = Math.min(nums[1], nums[3])
        target.x1 = Math.max(nums[0], nums[2])
        target.y1 = Math.max(nums[1], nums[3])
      }
      touched.move = nums
    }
    if (op.r !== undefined) {
      if (target.kind !== 'point') throw new Error(`mark #${target.id} is a box: it has no radius`)
      target.r = radiusOf(op.r)
      touched.r = target.r
    }
    if (op.caption !== undefined) {
      target.caption = captionOf(op.caption)
      touched.caption = target.caption
    }
    if (op.colour !== undefined) {
      target.colour = colourName(op.colour)
      touched.colour = target.colour
    }
    if (Object.keys(touched).length === 0) {
      throw new Error(`op for mark #${target.id} changes nothing: give move, r, caption, colour or remove`)
    }
    updated[target.id] = touched
  }
  return { record: next, result: { updated, removed } }
}

/** The tools whose arguments change a record; everything else only reads it. */
export const MUTATING_TOOLS = ['vision_mark', 'vision_unmark', 'vision_edit']

/** The update operations that delete these marks. */
export function removeOps(ids) {
  return ids.map((id) => ({ id, remove: true }))
}

/**
 * The marks a `vision_mark` call adds, in the record's own vocabulary.
 *
 * A caller names a place the way it sees it — a cell of the view it is looking at,
 * or a fraction of that view — and the view itself is the handle it copied back
 * from an earlier result. Nothing here needs the picture's dimensions, which is
 * what lets a call be replayed from its arguments alone.
 */
export function marksFromArgs(args) {
  const region = viewRegion(args)
  const grid = gridFor(region)
  return requireArray(args?.marks, 'marks').map((mark) => {
    if (mark === null || typeof mark !== 'object') {
      throw new Error('each mark must be an object like { "cell": "C3" }')
    }
    return {
      at: placeOn(mark.cell, region, grid),
      r: radiusFor(mark.size, region),
      caption: mark.caption,
      colour: mark.colour
    }
  })
}

/**
 * The operations a `vision_edit` call applies. Moving a mark or resizing it names
 * a place or a size the caller can see, so it needs the view; a caption or a
 * colour does not.
 */
export function opsFromArgs(record, args) {
  const ops = requireArray(args?.ops, 'ops')
  let region = null
  const view = () => {
    if (region === null) region = viewRegion(args)
    return region
  }
  return ops.map((op) => {
    if (op === null || typeof op !== 'object') throw new Error('each op must be an object')
    const out = { id: op.id, caption: op.caption, colour: op.colour }
    if (op.move !== undefined) {
      const point = placeOn(op.move, view(), gridFor(view()))
      const mark = findMark(record, op.id)
      if (mark.kind === 'point') {
        out.move = point
      } else {
        // A box keeps its own extent; the place it is sent to is its centre.
        const dx = Math.round(point[0] - (mark.x0 + mark.x1) / 2)
        const dy = Math.round(point[1] - (mark.y0 + mark.y1) / 2)
        out.move = [mark.x0 + dx, mark.y0 + dy, mark.x1 + dx, mark.y1 + dy]
      }
    }
    if (op.size !== undefined) {
      const mark = findMark(record, op.id)
      if (mark.kind !== 'point') throw new Error(`mark #${op.id} is a box: it has no size`)
      out.r = radiusFor(op.size, view())
    }
    return out
  })
}

/**
 * Replay one mutating call onto a record. The live tool and the session-log fold
 * both come through here, so a replayed record is the record the call produced —
 * a call that only deletes included.
 */
export function applyToolArgs(record, tool, args) {
  if (tool === 'vision_mark') return applyMarkArgs(record, { marks: marksFromArgs(args) }).record
  if (tool === 'vision_unmark') return applyUpdateArgs(record, { ops: removeOps(args?.marks ?? []) }).record
  if (tool === 'vision_edit') return applyUpdateArgs(record, { ops: opsFromArgs(record, args) }).record
  throw new Error(`unknown mutating tool ${JSON.stringify(tool)}`)
}

/** One mark as the model should read it: the address, then what is on it. */
export function markSummary(mark) {
  const out = { id: mark.id, kind: mark.kind }
  if (mark.kind === 'point') {
    out.at = [mark.x, mark.y]
    out.r = mark.r ?? DEFAULT_RADIUS
  } else {
    out.box = [mark.x0, mark.y0, mark.x1, mark.y1]
    out.centre = markPoint(mark)
  }
  out.colour = mark.colour ?? DEFAULT_COLOUR
  out.caption = mark.caption ?? ''
  return out
}

/** The record as JSON-safe text: how many numbers have been drawn, never a count
 *  of what the picture shows. */
export function recordSummary(record) {
  return {
    image: record.image,
    marks: record.marks.length,
    items: record.marks.map(markSummary)
  }
}
