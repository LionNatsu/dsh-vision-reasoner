/**
 * dsh-vision-reasoner (Host half).
 *
 * Registers the four tools, keeps each record as a fold of the session log, and
 * stores the rendered views. This file is the wiring; the reasoning is in
 * docs/DESIGN.md.
 *
 * @module dsh-vision-reasoner
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { COLOURS, DEFAULT_COLOUR, MUTATING_TOOLS, applyToolArgs, emptyRecord, imageKey } from './lib/record.js'
import {
  MAX_SHEET_TILES, describe as describeResult, planEdit, planLook, planMark, planUnmark
} from './lib/core.js'
import { probeImageSize } from './lib/render.js'

export const name = 'vision-reasoner'

/**
 * `tools` to register the four tools, `fs` to read the picture through the
 * harness's own sandboxed path. `attachments` and `llm` are consulted when
 * present and never required: a composition without them can still keep the
 * record, it just cannot show the picture.
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

/** The tools the fold replays; everything else only reads the record. */
const MUTATING = new Set(MUTATING_TOOLS)

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
    kind: { type: 'string', enum: ['frame', 'crop', 'compare', 'cover'] },
    name: { type: 'string' },
    label: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' }
  }
}

/** What every call reports: the record it changed, and the rectangle it drew. */
const PICTURE_RESULT_PROPERTIES = {
  picture: { type: 'string', required: true, description: 'The picture\'s size in original pixels, `2600x1831`.' },
  region: {
    type: 'string',
    required: true,
    description: 'The rectangle drawn, `0,0,2600,1831`, in original pixels.'
  },
  step: {
    type: 'integer',
    required: true,
    description: 'The grid step in original pixels (0 when the picture carries no grid).'
  },
  marksShown: { type: 'boolean', required: true },
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

const REGION_PARAMETER = {
  type: 'array',
  items: { type: 'integer' },
  description: 'The rectangle to look at, `[x0, y0, x1, y1]` in original image pixels, read off the labelled ' +
    'grid lines. Leave it out for the whole picture; give a small one to read a face closely.'
}

const AT_PARAMETER = {
  type: 'array',
  items: { type: 'integer' },
  description: 'The place you read off the grid, `[x, y]` in original image pixels, estimated between the ' +
    'labelled lines.'
}

const SIZE_PARAMETER = {
  type: 'string',
  enum: ['s', 'm', 'l'],
  description: 'How big the ring is drawn, in the picture\'s own pixels: s is 60 px across for one face in a ' +
    'crowd and is the default, m is 120 px for a person, l is 240 px for a group or a large area.'
}

const MARK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['at'],
  properties: {
    at: AT_PARAMETER,
    size: SIZE_PARAMETER,
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
    size: SIZE_PARAMETER,
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
      state.images[pending.key] = applyToolArgs(record, pending.tool, pending.args)
    } catch {
      // The call failed validation, so the tool threw the same way and changed
      // nothing. A replay has to agree with that, not guess.
    }
  }

  return function recordFor(session, key, label) {
    const state = stateFor(session)
    if (state.seq < session.seq) {
      for (const event of session.snapshotEvents(state.seq, session.seq)) {
        if (event.type === 'tool/call') {
          const data = event.data
          if (!MUTATING.has(data.name)) continue
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
 * Register the four tools.
 * @param ctx - the plugin's own context, carrying `tools` and `fs`.
 */
export function apply(ctx) {
  const records = createRecordFolder()
  const sources = new Map()

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
    name: 'vision_look',
    description:
      'See the picture, or a part of it, with a grid of the picture\'s own pixel coordinates drawn on ' +
      'it and every line labelled: a number you read is a number you can use, and nothing is scaled. ' +
      'Start here — a place is named from what you have seen. `region` is [x0, y0, x1, y1] read off ' +
      'those labels: leave it out for the whole picture, give a small one to read a face closely, or ' +
      'give `regions` — several rectangles at once — to sweep a picture in a few calls. Read a ' +
      'position by naming the line beside it and judging the gap by eye — there is no scale to work ' +
      'out — and treat this grid as the only ruler: do not crop the picture with another tool, or read ' +
      'a position off another view of it, whose pixels are a different size. The picture is drawn ' +
      'without your marks unless you ask for `marks: true`; `compare` puts marks side by side to ask "is ' +
      'this one thing or two"; `cover` paints a colour out, so whatever still shows has not been ' +
      'marked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: IMAGE_PARAMETER,
        region: REGION_PARAMETER,
        regions: {
          type: 'array',
          items: { type: 'array', items: { type: 'integer' } },
          description: 'Several rectangles in one call, e.g. [[0, 0, 900, 450], [900, 0, 1800, 450]], at ' +
            `most ${MAX_SHEET_TILES}: a picture swept in a few calls. They come back as one sheet of ` +
            'tiles, each labelled with its rectangle and carrying its own grid. Read a tile, mark ' +
            'what is in it, then cover that rectangle to find what you missed.'
        },
        marks: {
          type: 'boolean',
          description: 'Draw every mark placed so far (default false: the picture is what is being read). ' +
            'Marks stay from call to call and are drawn at whatever rectangle and scale you look at.'
        },
        compare: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Mark numbers to put side by side in one picture, for places too close to tell apart.'
        },
        cover: {
          type: 'string',
          description: `Paint these marked colours out (${COLOUR_NAMES.join(', ')}, or "all") over the ` +
            'rectangle you are looking at, or the whole picture; whatever still shows has not been marked. ' +
            'Covering one rectangle at a time is how a part of a picture is finished.'
        }
      }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute: run(planLook),
    presentCall: (args) => ({
      card: 'generic',
      title: args.compare?.length
        ? `Compare ${args.compare.map((id) => `#${id}`).join(' ')}`
        : args.cover !== undefined
          ? `Cover ${args.cover}`
          : Array.isArray(args.regions)
            ? `Look at ${args.regions.length} rectangle(s)`
            : Array.isArray(args.region) ? `Look at ${args.region.join(',')}` : `Look at ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'vision_mark',
    description:
      'Mark what you have decided, as you decide it: a mark STAYS on the picture — every later look ' +
      'draws it, of the whole picture or of any rectangle of it, however closely you look — so the ' +
      'marks you have placed are what you read instead of remembering, and a batch typed at the end is ' +
      'where doubles and misses come from. LOOK FIRST — mark what you can see in a picture you have ' +
      'looked at with vision_look; never a position worked out from anywhere else. `at` is [x, y] in ' +
      'the picture\'s own pixels, read off the labelled lines. The picture comes back around what you ' +
      'just marked — one tile per mark when they are spread across it — and every result lists the ' +
      'whole record, so a ring that missed its face, a double or a wrong one shows at once. A mark ' +
      'that is nearly right is moved by vision_edit, a wrong one is deleted by vision_unmark, and ' +
      'cover shows what is still unmarked. Nothing here counts or judges what the picture holds — ' +
      'that is your statement to make.',
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
    name: 'vision_unmark',
    description:
      'Delete marks by number, e.g. [3, 7]. Use it as soon as a mark is wrong — a number left in the ' +
      'record still reads as a place you have already dealt with, and the mistake becomes invisible in ' +
      'the list. The whole picture comes back, with the record.',
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
    name: 'vision_edit',
    description:
      'Correct marks that are nearly right: move one to the place it belongs in, resize it, recaption or ' +
      'recolour it. `move` is [x, y] in ORIGINAL pixels, read off the labelled grid lines. One call takes ' +
      'many operations, so a round of corrections is one call. The picture comes back around what you ' +
      'changed, with the record. To take a wrong mark out, use vision_unmark.',
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
