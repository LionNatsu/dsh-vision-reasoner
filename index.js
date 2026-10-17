/**
 * dsh-vision-reasoner (Host half).
 *
 * Registers the seven tools, keeps each record as a fold of the session log, and stores
 * the rendered views. This file is the wiring; the reasoning is in docs/DESIGN.md.
 *
 * @module dsh-vision-reasoner
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COLOURS, DEFAULT_COLOUR, TRACKED_TOOLS, commitCall, emptyRecord, imageKey
} from './lib/record.js'
import { SKILL } from './lib/skill.js'
import { describe as describeResult, planCamera, planEdit, planMark, planUnmark } from './lib/core.js'
import { probeImageSize } from './lib/render.js'

export const name = 'vision-reasoner'

/**
 * `tools` to register the seven tools, `fs` to read the picture through the harness's
 * own sandboxed path. `attachments` and `llm` are consulted when present and never
 * required: a composition without them can still keep the record, it just cannot show the
 * picture.
 */
export const inject = ['tools', 'fs']

/** Bytes one picture may be, matching the harness's own attachment limit. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** How many sessions keep a folded record, and how many pictures stay decoded. */
const SESSION_CACHE_LIMIT = 64
const SOURCE_CACHE_LIMIT = 8

/** Where rendered views are written, relative to the session working directory. */
const VIEW_DIR = '.dsh-vision'
const COLOUR_NAMES = Object.keys(COLOURS)

/** Every tool whose call the fold replays. */
const TRACKED = new Set(TRACKED_TOOLS)

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    path: { type: 'string' }
  }
}

const VIEW_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'width', 'height'],
  properties: {
    kind: { type: 'string', enum: ['picture', 'window'] },
    name: { type: 'string' },
    label: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' }
  }
}

/** What every call reports: the record it changed, and the window it was seen through. */
const PICTURE_RESULT_PROPERTIES = {
  picture: { type: 'string', required: true, description: 'The picture\'s size in original pixels, `2600x1831`.' },
  window: {
    type: 'string',
    required: true,
    description: 'The square the camera looks through, `650,0,1950,1300`, in original pixels. It may reach ' +
      'past the picture\'s edge, and what is outside the picture is black.'
  },
  side: { type: 'integer', required: true, description: 'The window\'s side, in original pixels.' },
  whole: { type: 'boolean', required: true, description: 'True when the window holds the whole picture.' },
  scale: {
    type: 'string',
    required: true,
    description: 'How much bigger the drawing is than the picture, `1.08x`. Every view is drawn square, ' +
      '1400x1400, whatever the window.'
  },
  step: {
    type: 'integer',
    required: true,
    description: 'The grid step in original pixels (0 when the picture carries no grid).'
  },
  marksShown: { type: 'boolean', required: true },
  aimed: {
    type: 'string',
    description: 'The movement this call asked for, empty when it asked for none. Present so the answer ' +
      'can say when the window had nowhere to move.'
  },
  sweep: {
    type: 'string',
    required: true,
    description: 'How far the sweep has got: how many windows have been stopped in, which one this is, ' +
      'and which are left.'
  },
  record: { type: 'array', required: true, items: { type: 'string' } },
  views: { type: 'array', required: true, items: VIEW_VALUE_SCHEMA },
  images: { type: 'array', required: true, items: IMAGE_VALUE_SCHEMA },
  attached: { type: 'boolean', required: true },
  note: { type: 'string' }
}

function recordResultSchema(extra) {
  const properties = {
    image: { type: 'string', required: true },
    marks: { type: 'integer', required: true },
    ...PICTURE_RESULT_PROPERTIES,
    ...extra
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.entries(properties).filter(([, spec]) => spec.required === true).map(([key]) => key),
    properties: Object.fromEntries(Object.entries(properties).map(([key, spec]) => {
      const { required: _required, ...rest } = spec
      return [key, rest]
    }))
  }
}

const IMAGE_PARAMETER = {
  type: 'string',
  description: 'Path to the picture. A relative path resolves against the session working directory.'
}

const TIMES_PARAMETER = {
  type: 'integer',
  description: 'How many steps at once, 1 to 8 (default 1).'
}

const STEP_PARAMETER = {
  type: 'string',
  enum: ['next', 'previous', 'left', 'right', 'up', 'down'],
  description: 'One whole window that way. "next" walks the sweep in reading order — left to right, then ' +
    'the row below — and "previous" steps back.'
}

const TO_PARAMETER = {
  type: 'array',
  items: { type: 'integer' },
  description: 'Where the window\'s centre goes: `[x, y]` in the picture\'s own pixels, read off the grid. ' +
    'A place, never an offset to work out. A window as large as the picture has nowhere to move, so it ' +
    'keeps the picture centred; a smaller one may sit over an edge, and the part past the picture is black.'
}

const MARKS_PARAMETER = {
  type: 'boolean',
  description: 'Draw the marks on the picture. Default true — the picture carries the record, so a mark you ' +
    'placed is in the next view. Pass false for a clean canvas, counting a place again from scratch for ' +
    'instance.'
}

/**
 * Said in every tool that takes or reports a coordinate. Each view is drawn at its own scale, so
 * the label on the picture in front of the caller is the only ruler there is: the same number is a
 * different distance in two views, and a position carried over from another view is wrong.
 */
const RULER_NOTE =
  'Every view is drawn at its own scale — the same number is a different distance in one window than ' +
  'in another — so the labelled grid on the picture in front of you is the only ruler: a number you ' +
  'read is in the picture\'s own pixels, read off that grid, and never converted from another view.'

const AT_PARAMETER = {
  type: 'array',
  items: { type: 'integer' },
  description: 'The place you read off the grid, `[x, y]` in original image pixels, estimated between the ' +
    'labelled lines.'
}

const R_PARAMETER = {
  type: 'integer',
  description: 'The ring radius in original pixels, when the ring has to match something you can see: a face ' +
    'is about 60, a head in a crowd about 30. Default 30.'
}

const MARK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['at'],
  properties: {
    at: AT_PARAMETER,
    r: R_PARAMETER,
    caption: { type: 'string', description: 'A few words drawn beside the number, e.g. "half hidden".' },
    colour: { type: 'string', enum: COLOUR_NAMES, description: `Its meaning is yours. Default ${DEFAULT_COLOUR}.` }
  }
}

const OP_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'integer', description: 'The number drawn on the picture.' },
    move: { ...AT_PARAMETER, description: 'Where the mark belongs: `[x, y]` in original image pixels.' },
    r: R_PARAMETER,
    caption: { type: 'string', description: 'New caption; "" clears it.' },
    colour: { type: 'string', enum: COLOUR_NAMES, description: 'New colour.' }
  }
}

/**
 * Fold each session's mark records out of its own log: `{ images, pending }`,
 * all plain JSON, because the fold has to be reproducible from the log alone.
 */
function createRecordFolder() {
  const sessions = new Map()

  function stateFor(session) {
    const id = String(session.id)
    let state = sessions.get(id)
    if (state === undefined) {
      state = { seq: 0, images: {}, pending: {} }
      sessions.set(id, state)
      if (sessions.size > SESSION_CACHE_LIMIT) sessions.delete(sessions.keys().next().value)
    }
    return state
  }

  function commit(state, pending) {
    const record = state.images[pending.key] ?? emptyRecord(pending.label)
    try {
      // No picture size here: the fold is replayed from the log alone, and every aim a call
      // records is already free of dimensions.
      state.images[pending.key] = commitCall(record, pending.tool, pending.args).record
    } catch {
      // nothing. A replay has to agree with that, not guess.
    }
  }

  return function recordFor(session, key, label) {
    const state = stateFor(session)
    if (state.seq < session.seq) {
      for (const event of session.snapshotEvents(state.seq, session.seq)) {
        if (event.type === 'tool/call') {
          const data = event.data
          if (!TRACKED.has(data.name)) continue
          let args
          try {
            args = JSON.parse(data.arguments)
          } catch {
            continue // Arguments that are not JSON never reached execute either.
          }
          state.pending[data.callId] = {
            tool: data.name,
            key: imageKey(args?.image ?? '', session.header.cwd),
            label: String(args?.image ?? ''),
            args
          }
          continue
        }
        if (event.type === 'tool/result') {
          const callId = event.data?.message?.toolCallId
          const pending = callId === undefined ? undefined : state.pending[callId]
          if (pending === undefined) continue
          delete state.pending[callId]
          const failed = event.data.error !== undefined || event.data?.message?.isError === true
          if (!failed) commit(state, pending)
          continue
        }
        if (event.type === 'turn/end') {
          // A call still pending when its turn ended never produced a result.
          state.pending = {}
        }
      }
      state.seq = session.seq
    }
    return state.images[key] ?? emptyRecord(label)
  }
}

/**
 * The metadata the Web client reads off a result. It must be lossless JSON — the
 * registry rejects a result carrying an `undefined` key — so `path` is omitted
 * when there is no picture.
 */
function presentationMetaOf(value) {
  const first = value.images?.[0]
  return {
    image: value.image,
    marks: value.marks,
    ...first?.path === undefined ? {} : { path: first.path }
  }
}

/** The owning session, or a clear refusal. */
function requireSession(exec) {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('a vision tool needs an owning agent session: the record is kept in that session\'s log')
  }
  return session
}

/**
 * Whether the picture can be attached to this request at all.
 *
 * Only a positive answer blocks it: a model that does not declare image input
 * cannot use the picture, and `read_image` refuses on the same gate. Anything
 * merely unknown — no `llm` service, a throwing `resolveModelInfo`, an
 * unresolvable route — attaches anyway. Unknowable is not the same as incapable,
 * and an adapter hiccup must not replace the picture with a note blaming the
 * route.
 */
async function attachBlocker(ctx, exec, session) {
  if (ctx.get('attachments') === undefined) return 'no attachment service is mounted'
  const llm = ctx.get('llm')
  if (llm === undefined) return null
  const route = session.requestContext()
  if (route === undefined) return null
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      return `model "${route.model}" does not declare image input`
    }
  } catch {
    return null
  }
  return null
}

/**
 * Register the seven tools.
 * @param ctx - the plugin's own context, carrying `tools` and `fs`.
 */
export function apply(ctx) {
  const records = createRecordFolder()
  const sources = new Map()

  // The workflow has to reach the model before the work starts: pointing inside reasoning
  // is a mode it does not enter on its own, and tool descriptions are read while deciding
  // whether to call a tool at all. A skill is read when a task matches one.
  const skills = ctx.get('skills')
  if (skills !== undefined && typeof skills.register === 'function') {
    ctx.effect(() => skills.register(SKILL))
  }

  /** Read one picture through `ctx.fs`, cached by the version it reports. */
  async function loadSource(image, exec) {
    const cwd = exec.agent?.session?.header?.cwd
    const target = await ctx.fs.resolve(image, { cwd, signal: exec.signal })
    const path = ctx.fs.processPath(target)
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) throw new Error(`cannot read "${image}": no such file`)
    const cached = sources.get(path)
    if (cached !== undefined && cached.version === info.version) return cached.source
    const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_IMAGE_BYTES)
    let size
    try {
      size = await probeImageSize(bytes)
    } catch (error) {
      // The image library's own complaint ("Input Buffer is empty", a libvips
      // header dump) names neither the file nor the caller's spelling of it, and
      // the model cannot act on it. Name the input.
      throw new Error(`cannot read "${image}" as an image: ${String(error.message).split('\n')[0]}`)
    }
    const source = {
      bytes,
      width: size.width,
      height: size.height,
      orientation: size.orientation
    }
    sources.set(path, { version: info.version, source })
    if (sources.size > SOURCE_CACHE_LIMIT) sources.delete(sources.keys().next().value)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return source
  }

  /**
   * Store the rendered views so the result can carry image blocks and the Web UI
   * can open them. A storage failure is reported, not thrown: the record has
   * already changed, and failing the call would deny work that happened.
   */
  async function attach(views, exec, session) {
    if (views.length === 0) return { images: [], attached: true }
    const blocker = await attachBlocker(ctx, exec, session)
    if (blocker !== null) return { images: [], attached: false, note: blocker }
    const attachments = ctx.get('attachments')
    const cwd = session.header?.cwd
    const images = []
    const failed = []
    for (const view of views) {
      // The picture the MODEL reads is the attachment. The picture a PERSON can
      // open is a file: the Web UI's preview decides how to render a file from
      // its extension, and an attachment object has none, so a view is also
      // written to `<cwd>/.dsh-vision/<name>.png` and addressed workspace-relative.
      // That is the only thing this plugin ever writes, and only when it has a
      // picture to show.
      let path
      if (cwd !== undefined) {
        try {
          mkdirSync(join(cwd, VIEW_DIR), { recursive: true })
          writeFileSync(join(cwd, VIEW_DIR, view.name), view.png)
          path = `${VIEW_DIR}/${view.name}`
        } catch (error) {
          failed.push(`${view.name}: ${String(error.message).split('\n')[0]}`)
          continue
        }
      }
      let ref
      try {
        ref = await attachments.saveImage({ data: view.png, mediaType: 'image/png', name: view.name })
      } catch (error) {
        failed.push(`${view.name}: ${String(error.message).split('\n')[0]}`)
        continue
      }
      images.push({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: ref.name ?? view.name,
        ...path === undefined ? {} : { path }
      })
    }
    if (failed.length > 0) {
      return {
        images,
        attached: false,
        note: `${failed.length} of ${views.length} picture(s) could not be stored: ${failed.join('; ')}`
      }
    }
    return { images, attached: true }
  }

  function renderContent(value) {
    const note = value.attached === true ? '' : `\n(the picture was not attached: ${value.note})`
    const blocks = [{ type: 'text', text: describeResult(value) + note }]
    for (const image of value.images ?? []) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...image.name === undefined ? {} : { name: image.name }
        }
      })
    }
    return blocks
  }

  /** One call, whatever it changes: the record comes first, then the picture. */
  function run(plan) {
    return async (args, exec) => {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = await plan({ record, args, loadSource: () => loadSource(args.image, exec) })
      const attached = await attach(planned.views, exec, session)
      return { ...planned.result, ...attached }
    }
  }

  ctx.tools.register({
    name: 'camera_reset',
    description:
      'Point the camera at the whole picture and see it: one square window holding all of it. Start here. ' +
      'The window is a square of the picture\'s own pixels and the picture is drawn inside it at ' +
      'the scale that fits; whatever is left over is outside the picture and black. ' +
      'The grid lines are labelled with the picture\'s own pixel coordinates, and a number you read is a ' +
      'number you can use — read positions off the labels, never off the pixels of the image in front of ' +
      'you, which is a rendering at a size this tool chose. Treat this grid as the only ruler: do not crop ' +
      'the picture with another tool, or read a position off another view of it. This window is the first ' +
      'cell of a sweep over the picture; `camera_move` with "next" walks the rest, and every result says ' +
      'how far the sweep has got and which cells are left.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: { image: IMAGE_PARAMETER, marks: MARKS_PARAMETER }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planCamera('camera_reset')),
    presentCall: (args) => ({
      card: 'generic',
      title: `The whole picture: ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'camera_move',
    description:
      'Move the camera and see what it looks at now. `step` moves one whole window — "next" walks the ' +
      'sweep in reading order, left to right and then the row below — and `to` puts the window\'s centre ' +
      'on a place you read off the grid. Give one, or a place and then a step. The windows tile the ' +
      'picture centred on it: as many across and down as it takes at the current size, which ' +
      'every result states, along with which cell the camera is in, how many have been stopped in since ' +
      'the last reset, and which are left. A cell counts as looked at when the camera stopped in it. ' +
      'The window is a square of the picture\'s own pixels and the picture is drawn inside it at ' +
      'the scale that fits; whatever is left over is outside the picture and black. ' +
      RULER_NOTE,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: IMAGE_PARAMETER,
        step: STEP_PARAMETER,
        to: TO_PARAMETER,
        marks: MARKS_PARAMETER
      }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planCamera('camera_move')),
    presentCall: (args) => ({
      card: 'generic',
      title: args.step === undefined ? `Camera to ${args.to?.join(',') ?? args.image}` : `Camera ${args.step}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'camera_zoom_in',
    description:
      'Zoom in: the window halves on each step, about its centre, so nothing drifts away from what you ' +
      'were looking at. `times` takes several steps at once. ' +
      'The window is a square of the picture\'s own pixels and the picture is drawn inside it at ' +
      'the scale that fits; whatever is left over is outside the picture and black. ' +
      'Every result gives the window\'s side and the scale it is drawn at, and a window never gets ' +
      'smaller than 64 original pixels across.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: { image: IMAGE_PARAMETER, times: TIMES_PARAMETER, marks: MARKS_PARAMETER }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planCamera('camera_zoom_in')),
    presentCall: (args) => ({
      card: 'generic',
      title: `Closer${args.times === undefined ? '' : ` x${args.times}`}: ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'camera_zoom_out',
    description:
      'Zoom out: the window doubles on each step, about its centre — the step between this view and the ' +
      'whole picture, which `camera_reset` gives in one go. `times` takes several steps at once. ' +
      'Every result gives the window\'s side and the scale it is drawn at.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: { image: IMAGE_PARAMETER, times: TIMES_PARAMETER, marks: MARKS_PARAMETER }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planCamera('camera_zoom_out')),
    presentCall: (args) => ({
      card: 'generic',
      title: `Further${args.times === undefined ? '' : ` x${args.times}`}: ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'mark_add',
    description:
      'Mark what you have decided, as you decide it. A mark STAYS on the picture — every later view draws ' +
      'it — so the marks you have placed are what you read instead of remembering, and a batch typed at ' +
      'the end is where doubles and misses come from. `at` is [x, y] in the picture\'s own pixels, read ' +
      'off the labelled grid: LOOK FIRST, and mark only what you have seen, never a position worked out ' +
      'from anywhere else. Two or three at a time is the useful size. The answer is the window you are ' +
      'already looking at, with the new marks drawn and a cross at each centre: read it before you go on, ' +
      'and fix what is off in the same breath — a wrong ring misleads every later view, and clearing it ' +
      'costs less than reasoning around it. Nothing moves underneath you: a mark never changes where the ' +
      'camera is, so a sweep in progress stays where it is. `r` is the ring\'s radius in original pixels ' +
      '(default 30; a face is about 60). Every result lists the whole record, so a ring that missed its ' +
      'face, a double or a wrong one shows at once. Nothing here counts or judges what the picture holds — ' +
      'that is your statement to make. ' + RULER_NOTE,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'marks'],
      properties: {
        image: IMAGE_PARAMETER,
        marks: {
          type: 'array',
          items: MARK_ITEM_SCHEMA,
          description: 'The places to mark, in the order to number them.'
        }
      }
    },
    output: {
      schema: recordResultSchema({
        marked: { type: 'array', required: true, items: { type: 'integer' } }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planMark),
    presentCall: (args) => ({
      card: 'generic',
      title: `Mark ${args.marks?.length ?? 0} place(s) on ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'mark_remove',
    description:
      'Delete marks by number, e.g. [3, 7] — as soon as one is wrong, not at the end: a number left in the ' +
      'record still reads as a place you have already dealt with, and the mistake becomes invisible in the ' +
      'list. The answer is the window you are looking at, with the record.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'marks'],
      properties: {
        image: IMAGE_PARAMETER,
        marks: {
          type: 'array',
          items: { type: 'integer' },
          description: 'The numbers to delete, as drawn on the picture; every result lists them.'
        }
      }
    },
    output: {
      schema: recordResultSchema({
        updated: { type: 'object', required: true, additionalProperties: true, properties: {} },
        removed: { type: 'array', required: true, items: { type: 'integer' } }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planUnmark),
    presentCall: (args) => ({
      card: 'generic',
      title: `Remove ${args.marks?.length ?? 0} mark(s) from ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'mark_edit',
    description:
      'Correct marks that are nearly right: move one to the place it belongs in, resize it, recaption or ' +
      'recolour it. `move` is [x, y] in ORIGINAL pixels, read off the labelled grid; `r` is the radius ' +
      'in those pixels. One call takes many operations, so a round of corrections is one call. The answer ' +
      'is the window you are looking at, with what changed drawn on it and the record beside it — read it, ' +
      'because a correction is done only when it is seen to be right. It does not move the camera either: ' +
      'correct a ring in the window you read it in. To take a wrong mark out, use `mark_remove`. ' +
      RULER_NOTE,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'ops'],
      properties: {
        image: IMAGE_PARAMETER,
        ops: { type: 'array', items: OP_ITEM_SCHEMA, description: 'The operations, applied in order.' }
      }
    },
    output: {
      schema: recordResultSchema({
        updated: { type: 'object', required: true, additionalProperties: true, properties: {} },
        removed: { type: 'array', required: true, items: { type: 'integer' } }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planEdit),
    presentCall: (args) => ({
      card: 'generic',
      title: `Edit ${args.ops?.length ?? 0} mark(s) on ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })
}
