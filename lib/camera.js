/**
 * The camera: a square window on the picture, and the actions that aim it.
 *
 * One shape, always. A caller does not choose what a view looks like — it moves the camera
 * and says how close — so a view can never come back as a strip, and no two results are
 * shaped differently from each other. The picture is drawn inside the square at whatever
 * scale fits; whatever is left over is outside the picture, and black.
 *
 * There is no "look": a camera does not stop seeing, so every action on it returns what it
 * now sees. `camera_move` walks the window grid in reading order or puts the centre on a
 * place, `camera_zoom_in` and `camera_zoom_out` halve and double the window, `camera_reset`
 * points it back at the whole picture.
 *
 * The camera is a fold of those ops, taken from the call's arguments, so it is replayed from
 * the log like everything else here and survives a restart. Resolving it into a window needs
 * the picture's dimensions, which is why that happens where the picture is at hand.
 *
 * @module lib/camera
 */

/** The smallest window, in picture pixels: below this there is nothing left to read. */
export const MIN_SIDE = 64

/** Ops one record keeps. A camera that long has been reset on the way. */
export const CAMERA_LIMIT = 96

/** One step of a zoom in or out. */
const ZOOM_STEP = 2

/** Room left around a batch of marks when the camera is sent to them. */
const FIT_MARGIN = 1.6

const DIRECTIONS = ['left', 'right', 'up', 'down']

const MOVE_HELP = '`"next"`, `"previous"`, `"left"`, `"right"`, `"up"`, `"down"`, or `[x, y]`'

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

function splitAt(text) {
  return String(text).split(',').map(Number)
}

/** The whole picture in one square window: the picture centred, the rest black. */
function wholeOf(width, height) {
  return { side: Math.max(width, height), cx: width / 2, cy: height / 2 }
}

/**
 * How many windows of this size it takes to cover the picture, and where that grid sits.
 *
 * The grid is aligned to the picture's centre rather than its top-left corner, so the widest
 * window — the whole picture in one square — is exactly the first cell of its own sweep
 * instead of a view half a window away from it.
 */
export function sweepGrid(width, height, side) {
  const size = clamp(side, MIN_SIDE, Math.max(width, height))
  const across = Math.max(1, Math.ceil(width / size))
  const down = Math.max(1, Math.ceil(height / size))
  return {
    side: size,
    across,
    down,
    originX: width / 2 - (across / 2) * size,
    originY: height / 2 - (down / 2) * size
  }
}

function cellAt(cx, cy, grid) {
  return {
    i: clamp(Math.floor((cx - grid.originX) / grid.side), 0, grid.across - 1),
    j: clamp(Math.floor((cy - grid.originY) / grid.side), 0, grid.down - 1)
  }
}

function centreOfCell(i, j, grid) {
  return { cx: grid.originX + (i + 0.5) * grid.side, cy: grid.originY + (j + 0.5) * grid.side }
}

/**
 * Where a window that was moved can sit.
 *
 * A window as large as the picture has nowhere to go: it keeps the picture centred, because
 * sliding it would cut the picture off and show black in its place. A smaller one may sit over
 * an edge — the black beyond is part of the drawing — but it stays roughly over the picture
 * rather than leaving it behind entirely.
 */
function clampCentre(value, side, extent) {
  if (side >= extent) return extent / 2
  return clamp(value, 0, extent)
}

/** One cell on in reading order, wrapping at the right edge and at the end of the sweep. */
function stepCell(cell, grid, forward) {
  const total = grid.across * grid.down
  const flat = cell.j * grid.across + cell.i
  const moved = (((flat + (forward ? 1 : -1)) % total) + total) % total
  return { i: moved % grid.across, j: Math.floor(moved / grid.across) }
}

/**
 * The op a `move` value asks for. A word steps one window, in reading order or by direction;
 * a place names where the camera ends up, in the picture's own pixels — a place read off the
 * grid, never an offset to work out.
 */
export function moveOp(value) {
  if (value === undefined || value === null) throw new Error(`move needs a destination: ${MOVE_HELP}`)
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    if (word === 'next' || word === 'previous' || DIRECTIONS.includes(word)) return { op: 'move', by: word }
    throw new Error(`move must be ${MOVE_HELP}, got ${JSON.stringify(value)}`)
  }
  if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n))) {
    return { op: 'move', at: [Math.round(value[0]), Math.round(value[1])].join(',') }
  }
  throw new Error(`move must be ${MOVE_HELP}, got ${JSON.stringify(value)}`)
}

function timesOf(value) {
  if (value === undefined || value === null) return 1
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error(`times must be a whole number of steps from 1 to 8, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The aiming one call asks for, ending with the marker that says the camera stopped here.
 * `seen` is what the sweep counts: a window the camera stopped in, not one it passed over.
 */
export function opsFor(tool, args) {
  if (tool === 'camera_reset') return [{ op: 'reset' }, { op: 'seen' }]
  if (tool === 'camera_move') {
    if (args?.to === undefined && args?.step === undefined) {
      throw new Error('camera_move needs `step` (a direction) or `to` (a place to centre on)')
    }
    const ops = []
    // A place first, then the step: "go there, then one window on" reads the way it is meant.
    if (args?.to !== undefined) ops.push(moveOp(args.to))
    if (args?.step !== undefined) ops.push(moveOp(args.step))
    return [...ops, { op: 'seen' }]
  }
  if (tool === 'camera_zoom_in') return [{ op: 'zoom', by: ZOOM_STEP ** timesOf(args?.times) }, { op: 'seen' }]
  if (tool === 'camera_zoom_out') return [{ op: 'zoom', by: (1 / ZOOM_STEP) ** timesOf(args?.times) }, { op: 'seen' }]
  return []
}

/**
 * Send the camera to a batch of marks: a square wide enough to hold them with room around
 * every one, centred on them. A mark is a judgement about the picture, so the answer to "did
 * it land where I meant" is a view of that place — never a crop of the bounding box, which
 * for a row of marks would be a strip one face tall.
 */
export function fitOp(marks) {
  const points = (marks ?? []).filter((mark) => Number.isFinite(mark?.x) && Number.isFinite(mark?.y))
  const boxes = (marks ?? []).filter((mark) => Number.isFinite(mark?.x0))
  const xs = [...points.map((m) => m.x), ...boxes.map((m) => m.x0), ...boxes.map((m) => m.x1)]
  const ys = [...points.map((m) => m.y), ...boxes.map((m) => m.y0), ...boxes.map((m) => m.y1)]
  if (xs.length === 0) return { op: 'seen' }
  const room = 2 * Math.max(...(marks ?? []).map((m) => Number(m.r ?? 30)))
  const side = Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), room) * FIT_MARGIN)
  const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2)
  const cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2)
  return { op: 'fit', side, at: `${cx},${cy}` }
}

/** The camera after more aiming. A camera that outgrows its limit starts again from the picture. */
export function applyCameraOps(camera, ops) {
  if (ops.length === 0) return camera ?? []
  const next = [...(camera ?? []), ...ops]
  if (next.length <= CAMERA_LIMIT) return next
  return [{ op: 'reset' }, ...next.slice(-(CAMERA_LIMIT - 1))]
}

/** One pass over the ops: where the camera ends up, and where it stopped on the way. */
function walk(camera, width, height) {
  const whole = wholeOf(width, height)
  const state = { side: whole.side, cx: whole.cx, cy: whole.cy }
  const stops = []
  for (const op of camera ?? []) {
    if (op?.op === 'reset') {
      state.side = whole.side
      state.cx = whole.cx
      state.cy = whole.cy
      stops.length = 0
    } else if (op?.op === 'zoom') {
      state.side /= op.by
    } else if (op?.op === 'fit') {
      state.side = op.side
      const [x, y] = splitAt(op.at)
      state.cx = x
      state.cy = y
    } else if (op?.op === 'move') {
      if (op.at !== undefined) {
        const [x, y] = splitAt(op.at)
        state.cx = x
        state.cy = y
      } else {
        const grid = sweepGrid(width, height, state.side)
        if (op.by === 'next' || op.by === 'previous') {
          const cell = stepCell(cellAt(state.cx, state.cy, grid), grid, op.by === 'next')
          const place = centreOfCell(cell.i, cell.j, grid)
          state.cx = place.cx
          state.cy = place.cy
        } else {
          if (op.by === 'left') state.cx -= grid.side
          if (op.by === 'right') state.cx += grid.side
          if (op.by === 'up') state.cy -= grid.side
          if (op.by === 'down') state.cy += grid.side
        }
      }
      // Every move is clamped, whether it named a place or a direction.
      state.cx = clampCentre(state.cx, state.side, width)
      state.cy = clampCentre(state.cy, state.side, height)
    } else if (op?.op === 'seen') {
      stops.push([state.cx, state.cy])
    }
    state.side = clamp(state.side, MIN_SIDE, whole.side)
  }
  return { state, stops }
}

/** Where the camera is pointed: a square window, which may reach past the picture's edge. */
export function resolveCamera(camera, width, height) {
  const { state } = walk(camera, width, height)
  const half = state.side / 2
  return {
    side: Math.round(state.side),
    cx: Math.round(state.cx),
    cy: Math.round(state.cy),
    x0: Math.round(state.cx - half),
    y0: Math.round(state.cy - half),
    x1: Math.round(state.cx + half),
    y1: Math.round(state.cy + half)
  }
}

/**
 * How far the sweep has got: the grid for the camera's current size, the window it is in, and
 * the windows it has stopped in since the last reset.
 */
export function sweepState(camera, width, height) {
  const { state, stops } = walk(camera, width, height)
  const grid = sweepGrid(width, height, state.side)
  const seen = new Set(stops.map(([cx, cy]) => {
    const cell = cellAt(cx, cy, grid)
    return `${cell.i},${cell.j}`
  }))
  const here = cellAt(state.cx, state.cy, grid)
  const missing = []
  for (let j = 0; j < grid.down; j += 1) {
    for (let i = 0; i < grid.across; i += 1) if (!seen.has(`${i},${j}`)) missing.push({ i, j })
  }
  return {
    across: grid.across,
    down: grid.down,
    here,
    side: grid.side,
    seen: grid.across * grid.down - missing.length,
    total: grid.across * grid.down,
    missing
  }
}
