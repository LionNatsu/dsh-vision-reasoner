/**
 * The Host half, against a stand-in harness.
 *
 * Checks what needs no running DSH process: every returned value satisfies its
 * declared output schema (the registry rejects a mismatch at dispatch), the record
 * really is a fold, a place is named in the picture's own pixels, and the failure
 * paths report rather than throw.
 *
 * The stand-in is deliberately literal — a session is a list of events, the
 * filesystem reads one file — so a test fails when the plugin's assumptions about
 * the harness change, not when a mock drifts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'

import { apply, inject, name } from '../index.js'

const CWD = 'D:\\work'

async function photo(width = 800, height = 600) {
  const channels = 3
  const data = Buffer.alloc(width * height * channels)
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 40
    data[i + 1] = 44
    data[i + 2] = 52
  }
  return sharp(data, { raw: { width, height, channels } }).jpeg({ quality: 80 }).toBuffer()
}

/** A session that is exactly what the fold reads: id, header, seq, events. */
function fakeSession(cwd = CWD) {
  const events = []
  return {
    id: 'session-1',
    header: { cwd },
    get seq() { return events.length },
    snapshotEvents(fromSeq = 0, toSeqExclusive = events.length) {
      return events.slice(fromSeq, toSeqExclusive)
    },
    requestContext() { return { provider: 'fake', model: 'fake-model' } },
    /** Append as the harness would, in sequence. */
    append(type, data) {
      events.push({ type, seq: events.length, time: Date.now(), data })
      return events[events.length - 1]
    },
    events
  }
}

/** A stand-in harness: tools, fs, attachments, llm, and a way to drive a call. */
function fakeHarness({
  imagePath,
  bytes,
  modalities = ['text', 'image'],
  attachments = true,
  storeFails = false
} = {}) {
  const tools = new Map()
  const saved = []
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    fs: {
      async resolve(path) { return { path } },
      processPath(target) { return target.path },
      async stat() { return { version: 'v1' } },
      async readBytes() { return bytes ?? readFileSync(imagePath) }
    },
    emit() {},
    get(service) {
      if (service === 'attachments') {
        return attachments
          ? {
              async saveImage(input) {
                if (storeFails) throw new Error('IMAGE_TOO_LARGE: past the deployment limit')
                saved.push(input)
                return {
                  attachmentId: `attachment-${saved.length}`,
                  mediaType: input.mediaType,
                  bytes: input.data.length,
                  width: 0,
                  height: 0,
                  name: input.name
                }
              },
              imageHostPath(ref) { return `C:\\objects\\${ref.attachmentId}` }
            }
          : undefined
      }
      if (service === 'llm') {
        return { async resolveModelInfo() { return { inputModalities: modalities } } }
      }
      return undefined
    }
  }
  apply(ctx)
  return { tools, saved, ctx }
}

/**
 * Run one tool as the registry does: execute it, then render its content.
 */
async function call(harness, toolName, args, session, signal) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `${toolName} was not registered`)
  const value = await tool.execute(args, { agent: { session }, signal })
  const content = tool.output.render(args, value)
  return { tool, value, content }
}

/**
 * Run one tool as the harness runs it: commit the `tool/call`, dispatch, then
 * commit the `tool/result` — the two events the record is folded from.
 */
async function committedCall(harness, toolName, args, session, callId) {
  session.append('tool/call', {
    turn: session.events.filter((e) => e.type === 'tool/call').length + 1,
    step: 1,
    callId,
    name: toolName,
    arguments: JSON.stringify(args)
  })
  const result = await call(harness, toolName, args, session)
  session.append('tool/result', {
    turn: session.events.filter((e) => e.type === 'tool/call').length,
    step: 1,
    message: { role: 'tool', toolCallId: callId, isError: false }
  })
  return result
}

/**
 * Does a value satisfy a schema, for the subset these tools declare? Required
 * keys, declared types and `additionalProperties: false`, failing the way the
 * registry fails rather than implementing all of JSON Schema.
 */
function schemaViolations(schema, value, path = 'value') {
  const problems = []
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`]
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}.${key} is required but missing`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue
      problems.push(...schemaViolations(sub, value[key], `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) problems.push(`${path}.${key} is not declared`)
      }
    }
    return problems
  }
  if (value === undefined) return problems
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    for (const [i, item] of value.entries()) problems.push(...schemaViolations(schema.items, item, `${path}[${i}]`))
    return problems
  }
  if (schema.type === 'string' && typeof value !== 'string') problems.push(`${path} must be a string`)
  if (schema.type === 'integer' && !Number.isInteger(value)) problems.push(`${path} must be an integer`)
  if (schema.type === 'number' && typeof value !== 'number') problems.push(`${path} must be a number`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') problems.push(`${path} must be a boolean`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return problems
}

/** A directory holding one picture, removed when the test finishes. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vision-reasoner-tools-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const imagePath = join(dir, 'photo.jpg')
  writeFileSync(imagePath, await photo())
  return { dir, imagePath }
}

test('the plugin declares what the harness needs to mount it', () => {
  assert.equal(name, 'vision-reasoner')
  assert.deepEqual(inject, ['tools', 'fs'])
})

test('the surface is four verbs, and a place is named in the picture\'s own pixels', () => {
  const harness = fakeHarness()
  assert.deepEqual([...harness.tools.keys()].sort(),
    ['vision_edit', 'vision_look', 'vision_mark', 'vision_unmark'])
  assert.equal(harness.tools.has('vision_list'), false, 'the record comes back with every call')

  const mark = harness.tools.get('vision_mark')
  assert.deepEqual(mark.parameters.required, ['image', 'marks'], 'there is no handle to copy back')
  assert.equal(mark.parameters.properties.view, undefined, 'a view handle is not part of a call')
  assert.equal(mark.parameters.properties.marks.items.required[0], 'at')
  assert.match(mark.description, /LOOK FIRST/)

  const look = harness.tools.get('vision_look')
  assert.match(look.description, /nothing is scaled/, 'a caller never converts a scale')
  assert.match(look.description, /no scale to work out/, 'and is told how to read a position')
  assert.match(look.description, /only ruler/, 'and does not read positions off another view')
  assert.match(look.parameters.properties.region.description, /original image pixels/)
  assert.match(look.parameters.properties.marks.description, /Marks stay from call to call/,
    'the picture carries the record, and a look can draw it')
  assert.match(mark.description, /STAYS on the picture/, 'a mark is durable, not a report')
  assert.equal(look.parameters.required.includes('view'), false)

  const edit = harness.tools.get('vision_edit')
  assert.match(edit.description, /vision_unmark/, 'deleting is pointed at its own verb')
})

test('the client half claims a row for every tool', () => {
  // A tool with no row still answers, but its picture never reaches the reader,
  // and nothing else in this suite would notice: renaming the Host half once left
  // three tools showing text alone.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const listed = /const TOOL_NAMES = \[([^\]]+)\]/.exec(source)
  assert.ok(listed, 'the client half lists the tool names it claims')
  const names = listed[1].split(',').map((name) => name.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(names.slice().sort(), [...fakeHarness().tools.keys()].sort())
})

test('every tool value satisfies its own declared output schema', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession()
  await committedCall(harness, 'vision_look', { image: imagePath }, session, 'look-1')
  await committedCall(harness, 'vision_mark',
    { image: imagePath, marks: [{ at: [200, 200], caption: 'one' }, { at: [300, 260] }] },
    session, 'seed-1')

  const calls = [
    ['vision_mark', { image: imagePath, marks: [{ at: [700, 500], size: 'l' }] }],
    ['vision_edit', { image: imagePath, ops: [{ id: 1, move: [640, 480], colour: 'yellow' }] }],
    ['vision_unmark', { image: imagePath, marks: [1] }],
    ['vision_look', { image: imagePath, region: [100, 100, 500, 400], marks: true }],
    ['vision_look', { image: imagePath, compare: [2] }],
    ['vision_look', { image: imagePath, cover: 'green' }],
    ['vision_look', { image: imagePath, region: [100, 100, 400, 300], cover: 'all' }],
    // A sheet of rectangles: the value carries the same fields as any other look.
    ['vision_look', { image: imagePath, regions: [[0, 0, 400, 300], [400, 0, 800, 300]] }]
  ]
  for (const [toolName, args] of calls) {
    const { value, content } = await call(harness, toolName, args, session)
    const schema = harness.tools.get(toolName).output.schema
    assert.deepEqual(schemaViolations(schema, value), [], `${toolName} returned a value its schema rejects`)
    // The value is logged, so it has to be lossless JSON: no Buffers, no undefined.
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${toolName} returned a non-JSON value`)
    // So does the metadata projected for the Web client, and that is a separate
    // projection: `path: undefined` there fails the whole result at dispatch.
    const project = harness.tools.get(toolName).output.presentationMeta
    if (typeof project === 'function') {
      const meta = project(args, value)
      assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta,
        `${toolName} projected non-lossless presentationMeta`)
    }
    assert.equal(content[0].type, 'text')
    assert.equal(typeof content[0].text, 'string')
  }
})

test('the record is a fold: a committed call counts, a failed one does not', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession()

  // The harness commits the call BEFORE dispatch, and the result after it.
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'vision_mark',
    arguments: JSON.stringify({ image: imagePath, marks: [{ at: [100, 120] }, { at: [200, 240] }] })
  })
  const first = await call(harness, 'vision_mark',
    { image: imagePath, marks: [{ at: [100, 120] }, { at: [200, 240] }] }, session)
  assert.deepEqual(first.value.marked, [1, 2], 'the live call sees its own numbering')

  // Until the result lands, the record has not changed...
  const before = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.equal(before.value.marks, 0, 'a pending call has not committed')

  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-1', isError: false }
  })
  const after = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.equal(after.value.marks, 2, 'the committed result is the record')
  assert.deepEqual(after.value.record, ['#1 100,120 green', '#2 200,240 green'])

  // A call that failed changes nothing, even though its arguments were logged.
  session.append('tool/call', {
    turn: 1,
    step: 2,
    callId: 'call-2',
    name: 'vision_mark',
    arguments: JSON.stringify({ image: imagePath, marks: [{ at: [300, 300] }] })
  })
  session.append('tool/result', {
    turn: 1,
    step: 2,
    message: { role: 'tool', toolCallId: 'call-2', isError: true },
    error: { name: 'Error', code: 'INVALID_ARGS' }
  })
  const failed = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.equal(failed.value.marks, 2, 'a failed call leaves the record alone')

  // A call with no result at all — a killed process — never happened.
  session.append('tool/call', {
    turn: 1,
    step: 3,
    callId: 'call-3',
    name: 'vision_mark',
    arguments: JSON.stringify({ image: imagePath, marks: [{ at: [400, 400] }] })
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  const dropped = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.equal(dropped.value.marks, 2, 'an unfinished call is dropped at turn end')

  // An edit replays through the same pure functions, and so does a removal.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: 'call-4',
    name: 'vision_edit',
    arguments: JSON.stringify({ image: imagePath, ops: [{ id: 1, move: [640, 480], caption: 'moved on' }] })
  })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-4', isError: false }
  })
  const edited = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.deepEqual(edited.value.record, ['#1 640,480 green "moved on"', '#2 200,240 green'])

  session.append('tool/call', {
    turn: 3,
    step: 1,
    callId: 'call-5',
    name: 'vision_unmark',
    arguments: JSON.stringify({ image: imagePath, marks: [1] })
  })
  session.append('tool/result', {
    turn: 3,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-5', isError: false }
  })
  const unmarked = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.deepEqual(unmarked.value.record, ['#2 200,240 green'], 'a removed mark is gone from the replayed record')
})

test('the picture comes back around what was just marked', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession()

  // Two places close together: the answer is a rectangle of the picture, so the
  // caller sees what it just did without asking to look closer.
  const near = await call(harness, 'vision_mark',
    { image: imagePath, marks: [{ at: [200, 200] }, { at: [260, 260] }] }, session)
  assert.equal(near.value.region, '149,149,311,311')
  assert.equal(near.value.views[0].kind, 'crop')

  // Places spread across the picture: one tile per mark, because the whole picture
  // is too coarse to see whether a ring is on what it names. A row of marks across a
  // photograph once came back as that picture, 10% off every face, and said nothing.
  const far = await call(harness, 'vision_mark',
    { image: imagePath, marks: [{ at: [80, 80] }, { at: [720, 520] }] }, session)
  assert.equal(far.value.region, '0,0,800,600')
  assert.equal(far.value.views[0].kind, 'compare')
  assert.equal(far.value.views[0].name, 'check-2-photo.png')
  assert.equal(far.value.views[0].label, '#1, #2', 'the near call was never committed, so these are the first two')
  assert.ok(far.value.views[0].width > 0 && far.value.views[0].height > 0)
})

test('a picture is attached, and its path is reported when the backend has one', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const { value, content } = await call(harness, 'vision_look',
    { image: imagePath, marks: true }, session)
  assert.equal(value.attached, true)
  assert.equal(value.images.length, 1)
  assert.match(value.images[0].name, /^frame-photo\.png$/)
  assert.equal(value.images[0].path, '.dsh-vision/frame-photo.png')
  assert.ok(existsSync(join(dir, '.dsh-vision', 'frame-photo.png')), 'the view is a real file the UI can open')
  assert.equal(harness.saved.length, 1)
  assert.equal(harness.saved[0].mediaType, 'image/png')
  assert.ok(harness.saved[0].data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
  // The model gets the picture as an image block, exactly as read_image sends one.
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'attachment-1')
  assert.match(content[0].text, /no marks yet/)
  assert.match(content[0].text, /\(800x600\)/, 'the picture\'s own size, in original pixels')
  assert.match(content[0].text, /view 0,0,800,600 — grid every 100 original pixels, marks drawn/)
  assert.match(content[0].text, /saved as \.dsh-vision\/frame-photo\.png \(1400x1050\)/)
})

test('a model that cannot take images is told so, and gets text instead', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath, modalities: ['text'] })
  const session = fakeSession()
  const { value, content } = await call(harness, 'vision_look', { image: imagePath, marks: true }, session)
  assert.equal(value.attached, false)
  assert.deepEqual(value.images, [])
  assert.match(value.note, /does not declare image input/)
  assert.equal(content.length, 1, 'no image block on a text-only route')
  assert.match(content[0].text, /the picture was not attached/)
  // The work still happened: the view was rendered, it just could not be sent.
  assert.equal(value.views.length, 1)
})

test('no attachment service is reported rather than assumed', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath, attachments: false })
  const session = fakeSession()
  const { value, content } = await call(harness, 'vision_look', { image: imagePath }, session)
  assert.equal(value.attached, false)
  assert.match(value.note, /no attachment service/)
  assert.equal(content.length, 1)
})

test('a picture that cannot be stored is reported, and the record survives it', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath, storeFails: true })
  const session = fakeSession(dir)
  const { value, content } = await call(harness, 'vision_mark',
    { image: imagePath, marks: [{ at: [400, 300] }] }, session)
  // The record change happened and is durable; only the picture was lost.
  assert.deepEqual(value.marked, [1])
  assert.equal(value.marks, 1)
  assert.equal(value.attached, false)
  assert.match(value.note, /could not be stored/)
  assert.match(value.note, /past the deployment limit/)
  assert.deepEqual(value.images, [])
  assert.equal(content.length, 1, 'no image block for a picture that was not stored')
  assert.match(content[0].text, /marked #1/)
})

test('an uncertain route still attaches the picture', async (t) => {
  // resolveModelInfo throwing is not the same as the model being unable to see.
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const ctx = harness.ctx
  const realGet = ctx.get
  ctx.get = (service) => (service === 'llm'
    ? { async resolveModelInfo() { throw new Error('adapter exploded') } }
    : realGet(service))
  const { value } = await call(harness, 'vision_look', { image: imagePath, marks: true }, session)
  assert.equal(value.attached, true, 'an unrelated failure must not withhold the picture')
  assert.equal(value.images.length, 1)
})

test('a caller with no session is refused, not silently ignored', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  await assert.rejects(
    () => call(harness, 'vision_look', { image: imagePath }, undefined),
    /needs an owning agent session/
  )
  await assert.rejects(
    () => call(harness, 'vision_mark', { image: imagePath, marks: [{ at: [10, 10] }] }, undefined),
    /needs an owning agent session/
  )
})

test('the arguments the model can send are the only ones accepted', async (t) => {
  const { imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession()

  await assert.rejects(
    () => call(harness, 'vision_mark', { image: imagePath, marks: [{ size: 'm' }] }, session),
    /at must be \[x, y\] in original pixels/
  )
  await assert.rejects(
    () => call(harness, 'vision_mark', { image: imagePath, marks: [{ at: [900, 100] }] }, session),
    /outside the picture, which is 800x600 original pixels/
  )
  await assert.rejects(
    () => call(harness, 'vision_mark', { image: imagePath, marks: [{ at: [10, 10], size: 'xl' }] }, session),
    /size must be one of s, m, l/
  )
  await assert.rejects(
    () => call(harness, 'vision_unmark', { image: imagePath, marks: [] }, session),
    /non-empty array/
  )
  await assert.rejects(
    () => call(harness, 'vision_unmark', { image: imagePath, marks: [99] }, session),
    /no mark #99/
  )
  await assert.rejects(
    () => call(harness, 'vision_edit', { image: imagePath, ops: [{ id: 1, move: ['A1'] }] }, session),
    /move must be \[x, y\] in original pixels/
  )
  await assert.rejects(
    () => call(harness, 'vision_look', { image: imagePath, cover: 'chartreuse' }, session),
    /unknown colour\(s\) chartreuse/
  )
  await assert.rejects(
    () => call(harness, 'vision_look', { image: imagePath, region: ['a', 'b', 'c', 'd'] }, session),
    /region must be four numbers in original pixels/
  )
})
