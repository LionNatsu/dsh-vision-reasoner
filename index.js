/**
 * dsh-vision-reasoner (Host half).
 *
 * Registers the five tools, keeps each record as a fold of the session log, and
 * stores the rendered views. This file is the wiring; the reasoning is in
 * docs/DESIGN.md.
 *
 * @module dsh-vision-reasoner
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { COLOURS, DEFAULT_COLOUR, MUTATING_TOOLS, applyToolArgs, emptyRecord, imageKey } from './lib/record.js'
import { planList, planMark, planShow, planUnmark, planUpdate, describe as describeResult } from './lib/core.js'
import { probeImageSize } from './lib/render.js'

export const name = 'vision-reasoner'

/**
 * `tools` to register the five tools, `fs` to read the picture through the
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

const VIEW_MODES = ['map', 'marks']

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
    kind: { type: 'string', enum: ['map', 'zoom', 'sheet', 'cover'] },
    name: { type: 'string' },
    label: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' }
  }
}

/** What the model gets back about the picture itself, on every call. */
const PICTURE_RESULT_PROPERTIES = {
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

const MARK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['point', 'box'],
      description: 'point (the default when `at` is given) or box (the default when `box` is given).'
    },
    at: { type: 'array', items: { type: 'number' }, description: 'A point: [x, y] in ORIGINAL image pixels.' },
    box: {
      type: 'array',
      items: { type: 'number' },
      description: 'A box: [x0, y0, x1, y1] in ORIGINAL image pixels.'
    },
    r: { type: 'number', description: 'Radius of a point, in original pixels. Default 60.' },
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
    move: {
      type: 'array',
      items: { type: 'number' },
      description: 'New position: [x, y] for a point, [x0, y0, x1, y1] for a box, in ORIGINAL pixels.'
    },
    r: { type: 'number', description: 'New radius for a point.' },
    caption: { type: 'string', description: 'New caption; "" clears it.' },
    colour: { type: 'string', enum: COLOUR_NAMES, description: 'New colour.' },
    remove: { type: 'boolean', description: 'true deletes the mark.' }
  }
}

/** Switches that keep the marks from covering what is being read. */
const MARK_VISIBILITY_PARAMETERS = {
  ids: {
    type: 'boolean',
    description: 'Draw each mark\'s number (default true). Turn it off in a dense cluster: a number sits ' +
      'above its ring, and in a dense cluster the numbers cover what you are trying to read.'
  },
  captions: {
    type: 'boolean',
    description: 'Draw each mark\'s caption beside its number (default true). Turn it off to see the ' +
      'picture under the marks.'
  }
}

const VIEW_MODE_PARAMETER = {
  type: 'string',
  enum: VIEW_MODES,
  description: 'map (the whole frame; the default, and what every call that changes the record comes ' +
    'back with) or marks (a sheet of close-ups of exactly what this call touched).'
}

/**
 * What a look can be asked for. Every parameter here reaches the model on every
 * request, so it gets the short list; `lib/render.js` accepts the rest.
 */
const LOOK_PARAMETERS = {
  views: {
    type: 'array',
    items: { type: 'string' },
    description: 'What to look at, each entry one of: "#17" (a stored mark), "640,480" (a point), or ' +
      '"120,240,360,520" (a rectangle). ONE entry is a close-up with a labelled coordinate grid; ' +
      'SEVERAL entries come back as a SINGLE sheet, which is how doubtful places get compared for the ' +
      'price of one look.'
  },
  cover: {
    type: 'string',
    description: `Paint these colours out instead of outlining them (${COLOUR_NAMES.join(', ')}, or ` +
      '"all"). Whatever still shows has not been marked.'
  },
  map: { type: 'boolean', description: 'Draw the whole frame with the ruler and every mark.' },
  target: {
    type: 'integer',
    description: 'Longest side of a single view, in pixels (1400 for a map, 1200 for a close-up). Lower ' +
      'it to spend fewer tokens on a picture, raise it to read a small detail.'
  },
  ...MARK_VISIBILITY_PARAMETERS
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
 * Register the five tools.
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

  ctx.tools.register({
    name: 'vision_mark',
    description:
      'Put numbered marks on a picture. A mark is a position, a number, a caption and a colour, and the ' +
      'number is drawn ON the picture — so the number is the address you use afterwards (#17). Nothing ' +
      'here counts or judges: counting what the picture holds is your statement to make, and this tool ' +
      'only says how many numbers you have drawn. Give every mark of one round in ONE call. Coordinates ' +
      'are pixels in the ORIGINAL image: read them off a view\'s ruler or coordinate grid, never off a ' +
      'scaled preview — a preview\'s pixel is not the picture\'s pixel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'marks'],
      properties: {
        image: IMAGE_PARAMETER,
        marks: { type: 'array', items: MARK_ITEM_SCHEMA, description: 'The marks to add, in the order to number them.' },
        view: VIEW_MODE_PARAMETER,
        ...MARK_VISIBILITY_PARAMETERS
      }
    },
    output: {
      schema: recordResultSchema({
        marked: { type: 'array', required: true, items: { type: 'integer' } },
        viewMode: { type: 'string', required: true, enum: VIEW_MODES }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    async execute(args, exec) {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = await planMark({
        record,
        args,
        loadSource: () => loadSource(args.image, exec)
      })
      const attached = await attach(planned.views, exec, session)
      return { ...planned.result, ...attached }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Mark ${args.marks?.length ?? 0} place(s) on ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'vision_update',
    description:
      'Move, recaption, recolour or delete marked places by their number. One call takes many operations, ' +
      'so a round of corrections is one call: 17=yellow, 21 "half hidden", 16 removed. Use it when a ' +
      'close-up shows a mark is off the thing it names, or that two numbers sit on the same place.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'ops'],
      properties: {
        image: IMAGE_PARAMETER,
        ops: { type: 'array', items: OP_ITEM_SCHEMA, description: 'The operations, applied in order.' },
        view: VIEW_MODE_PARAMETER,
        ...MARK_VISIBILITY_PARAMETERS
      }
    },
    output: {
      schema: recordResultSchema({
        updated: {
          type: 'object',
          required: true,
          additionalProperties: true,
          properties: {}
        },
        removed: { type: 'array', required: true, items: { type: 'integer' } },
        viewMode: { type: 'string', required: true, enum: VIEW_MODES }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    async execute(args, exec) {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = await planUpdate({
        record,
        args,
        loadSource: () => loadSource(args.image, exec)
      })
      const attached = await attach(planned.views, exec, session)
      return { ...planned.result, ...attached }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Update ${args.ops?.length ?? 0} mark(s) on ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'vision_show',
    description:
      'Look at the picture. No address draws the whole frame with a ruler and every mark; ONE address ' +
      'draws a close-up with a labelled coordinate grid; SEVERAL addresses come back as ONE sheet, which ' +
      'is how doubtful places get compared side by side for the price of a single look — use a sheet to ' +
      'ask "is this one thing or two", never four separate looks. `cover` paints the settled colours ' +
      'out, so whatever still shows has not been marked yet: that is how a missed one is found. Every ' +
      'number printed on a view is an ORIGINAL-image coordinate or a mark number.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: { image: IMAGE_PARAMETER, ...LOOK_PARAMETERS }
    },
    output: {
      schema: recordResultSchema({}),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    async execute(args, exec) {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = await planShow({
        record,
        args,
        loadSource: () => loadSource(args.image, exec)
      })
      const attached = await attach(planned.views, exec, session)
      return { ...planned.result, ...attached }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.views?.length
        ? `Look at ${args.views.join(' ')}`
        : args.cover !== undefined ? `Cover ${args.cover}` : `Look at ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'vision_unmark',
    description:
      'Delete marks by number, e.g. [3, 7]. Use it as soon as a mark is in the wrong place: a number ' +
      'left in the record still reads as a place you have already dealt with, so the mistake becomes ' +
      'invisible. Give every number of one round in ONE call. The whole frame comes back redrawn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'marks'],
      properties: {
        image: IMAGE_PARAMETER,
        marks: {
          type: 'array',
          items: { type: 'integer' },
          description: 'The numbers to delete, as drawn on the picture; vision_list prints them.'
        },
        view: VIEW_MODE_PARAMETER,
        ...MARK_VISIBILITY_PARAMETERS
      }
    },
    output: {
      schema: recordResultSchema({
        updated: {
          type: 'object',
          required: true,
          additionalProperties: true,
          properties: {}
        },
        removed: { type: 'array', required: true, items: { type: 'integer' } },
        viewMode: { type: 'string', required: true, enum: VIEW_MODES }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    async execute(args, exec) {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = await planUnmark({
        record,
        args,
        loadSource: () => loadSource(args.image, exec)
      })
      const attached = await attach(planned.views, exec, session)
      return { ...planned.result, ...attached }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Remove ${args.marks?.length ?? 0} mark(s) from ${args.image}`,
      kind: 'other',
      locations: [{ path: args.image }]
    })
  })

  ctx.tools.register({
    name: 'vision_list',
    description:
      'Read the mark record back as text: one line per number, with its position, colour and caption. ' +
      'Use it to check what you have written down: one mark missing from a scene you believe holds ' +
      'more is a difference worth seeing. It describes the RECORD, not the picture: it cannot ' +
      'count what is in the picture for you, and it is no substitute for looking.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: { image: IMAGE_PARAMETER }
    },
    output: {
      schema: recordResultSchema({
        items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } }
      }),
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => presentationMetaOf(value)
    },
    execute(args, exec) {
      const session = requireSession(exec)
      const record = records(session, imageKey(args.image, session.header.cwd), args.image)
      const planned = planList({ record })
      // `views` and `images` are empty rather than absent: the registry checks a
      // tool's value against its declared output schema, and a missing required
      // key is rejected as an invalid result.
      return Promise.resolve({ ...planned.result, views: [], images: [], attached: true })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read the mark record for ${args.image}`,
      kind: 'read',
      locations: [{ path: args.image }]
    })
  })
}
