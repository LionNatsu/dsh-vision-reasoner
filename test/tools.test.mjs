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
import { describe as describeResult } from '../lib/core.js'

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

test('the surface is seven verbs: the camera and the record, and every parameter is pinned', () => {
  const harness = fakeHarness({ imagePath: 'x.jpg' })
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'camera_move', 'camera_reset', 'camera_zoom_in', 'camera_zoom_out',
    'mark_add', 'mark_edit', 'mark_remove'
  ])
  const params = (tool) => Object.keys(harness.tools.get(tool).parameters.properties).sort()
  // Pinned on purpose: every parameter is a concept a caller has to learn, so adding one is a
  // decision rather than a drift. Looking down this list is the inventory.
  assert.deepEqual(params('camera_reset'), ['image', 'marks'])
  assert.deepEqual(params('camera_move'), ['image', 'marks', 'step', 'to'])
  assert.deepEqual(params('camera_zoom_in'), ['image', 'marks', 'times'])
  assert.deepEqual(params('camera_zoom_out'), ['image', 'marks', 'times'])
  assert.deepEqual(params('mark_add'), ['image', 'marks'])
  assert.deepEqual(params('mark_remove'), ['image', 'marks'])
  assert.deepEqual(params('mark_edit'), ['image', 'ops'])

  const that = (tool) => harness.tools.get(tool)
  assert.deepEqual(Object.keys(that('mark_add').parameters.properties.marks.items.properties).sort(),
    ['at', 'caption', 'colour', 'r'])
  assert.deepEqual(Object.keys(that('mark_edit').parameters.properties.ops.items.properties).sort(),
    ['caption', 'colour', 'id', 'move', 'r'])
  assert.deepEqual(that('camera_move').parameters.properties.step.enum,
    ['next', 'previous', 'left', 'right', 'up', 'down'])

  // The four things the cold read of an earlier draft could not guess, now said outright.
  assert.match(that('camera_reset').description, /square window/, 'the shape of a view')
  assert.match(that('camera_move').description, /tile the picture/, 'how the sweep grid is laid out')
  assert.match(that('camera_move').description, /stopped in it/, 'what "looked at" counts')
  assert.match(that('camera_zoom_in').description, /halves on each step/, 'the size of a zoom step')
  assert.match(that('camera_move').parameters.properties.to.description, /never an offset/,
    'to is a place, not a distance to work out')
  assert.match(that('mark_add').description, /read it before you go on/,
    'a mark comes back drawn, to be checked')
})

test('every tool value satisfies its own declared output schema', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const calls = [
    ['camera_reset', { image: imagePath }],
    ['camera_move', { image: imagePath, step: 'next' }],
    ['camera_move', { image: imagePath, to: [120, 90] }],
    ['camera_zoom_in', { image: imagePath, times: 2 }],
    ['camera_zoom_out', { image: imagePath }],
    ['mark_add', { image: imagePath, marks: [{ at: [100, 100], r: 20, caption: 'one' }] }],
    ['mark_edit', { image: imagePath, ops: [{ id: 1, move: [150, 120], r: 25 }] }],
    ['mark_remove', { image: imagePath, marks: [1] }]
  ]
  for (const [tool, args] of calls) {
    const result = await committedCall(harness, tool, args, session, `c-${tool}`)
    const problems = schemaViolations(result.tool.output.schema, result.value)
    assert.deepEqual(problems, [], `${tool} returned a value the registry would reject`)
    // The value is logged, so it has to be lossless JSON: no Buffers, no `undefined`.
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value, `${tool} returned a non-JSON value`)
    // The metadata the Web client reads is a second projection, and a `path: undefined`
    // there fails the whole result at dispatch, exactly as a missing required key would.
    const project = result.tool.output.presentationMeta
    if (typeof project === 'function') {
      const meta = project(args, result.value)
      assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, `${tool} projected non-lossless presentationMeta`)
      assert.equal(typeof meta.marks, 'number', `${tool} did not report its mark count to the row`)
    }
    assert.ok(result.content.some((block) => block.type === 'image'), `${tool} returned no picture`)
  }
})

test('every view is a square, whatever the camera was asked for', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  for (const [tool, args] of [
    ['camera_reset', {}],
    ['camera_zoom_in', { times: 3 }],
    ['camera_move', { step: 'next' }],
    ['camera_move', { to: [700, 500] }],
    ['camera_zoom_out', { times: 8 }]
  ]) {
    const result = await committedCall(harness, tool, args, session, `s-${tool}-${JSON.stringify(args)}`)
    const view = result.value.views[0]
    assert.equal(view.width, 1400, `${tool} drew a view that is not the fixed square`)
    assert.equal(view.height, 1400, `${tool} drew a view that is not the fixed square`)
    const [x0, y0, x1, y1] = result.value.window.split(',').map(Number)
    assert.equal(x1 - x0, y1 - y0, `${tool} named a window that is not square`)
    assert.equal(result.value.side, x1 - x0)
  }
})

test('the whole picture is drawn inside the square, and what is outside it is black', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const result = await committedCall(harness, 'camera_reset', { image: imagePath }, session, 'reset')
  assert.equal(result.value.whole, true)
  assert.equal(result.value.picture, '800x600')
  assert.equal(result.value.window, '0,-100,800,700', 'the 800x600 picture centred in an 800 square')
  const text = describeResult(result.value)
  assert.match(text, /drawn 1400x1400 \(1\.8x of the picture\)/)
  assert.match(text, /the whole picture, 1400x1050 inside it/)

  // The view is a file the row can open as well as an attachment, and the path is reported
  // workspace-relative: a result carrying `path: undefined` fails the whole call at dispatch.
  assert.equal(result.value.images[0].path, '.dsh-vision/picture-photo.png')
  assert.ok(existsSync(join(dir, '.dsh-vision', 'picture-photo.png')), 'the view is a real file the UI can open')
  assert.equal(result.tool.output.presentationMeta({}, result.value).path, '.dsh-vision/picture-photo.png')

  // The picture occupies raster rows 175..1225 of the 1400 square at this scale, so the top of
  // the frame is black and the middle is the picture. Both samples sit between two grid lines,
  // so each reads the picture or the black rather than a line drawn over either.
  const { data } = await sharp(harness.saved[0].data).raw().toBuffer({ resolveWithObject: true })
  const pixel = (x, y) => {
    const at = (y * 1400 + x) * 3
    return [data[at], data[at + 1], data[at + 2]]
  }
  const black = pixel(656, 87)
  assert.ok(black[0] < 12 && black[1] < 12 && black[2] < 12, `the top of the square is black, got ${black}`)
  const picture = pixel(656, 569)
  assert.ok(picture[0] > 20 && picture[2] > 30, `the middle is the picture, got ${picture}`)
  // And the grid is drawn over the picture itself, which is what makes a place readable.
  assert.notDeepEqual(pixel(350, 569), picture, 'the grid is drawn over the picture')
})

test('a row of marks comes back as a square window around them, not a strip', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const marks = [100, 200, 300, 400].map((x, index) => ({ at: [x, 300], r: 20, caption: `m${index + 1}` }))
  const result = await committedCall(harness, 'mark_add', { image: imagePath, marks }, session, 'row')
  assert.deepEqual(result.value.marked, [1, 2, 3, 4])
  assert.equal(result.value.window, '10,60,490,540')
  assert.equal(result.value.side, 480)
  assert.equal(result.value.whole, false, 'a window around the marks, not the whole picture')
  const [x0, y0, x1, y1] = result.value.window.split(',').map(Number)
  assert.equal(x1 - x0, y1 - y0, 'the strip one face tall is what this redesign removed')
  const spanX = Math.max(...marks.map((mark) => mark.at[0])) - Math.min(...marks.map((mark) => mark.at[0]))
  assert.ok(x1 - x0 >= spanX * 1.5, 'a side wide enough for the row plus room around it')
  for (const mark of marks) {
    // Room around every ring, not just its centre inside the frame: the answer is a view of
    // the place that changed, with what is next to it whole.
    assert.ok(mark.at[0] - mark.r > x0 && mark.at[0] + mark.r < x1, `the ring at ${mark.at} is inside and whole`)
    assert.ok(mark.at[1] - mark.r > y0 && mark.at[1] + mark.r < y1, `the ring at ${mark.at} is inside and whole`)
  }
  assert.match(describeResult(result.value), /marked #1 #2 #3 #4/)
  assert.equal(result.value.record.length, 4)
})

test('the camera walks the sweep, and the text says how far it has got', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  const whole = await committedCall(harness, 'camera_reset', { image: imagePath }, session, 'a')
  assert.equal(whole.value.sweep, 'the whole picture is one window · `camera_zoom_in` to sweep it in windows')

  const closer = await committedCall(harness, 'camera_zoom_in', { image: imagePath }, session, 'b')
  assert.equal(closer.value.side, 400, 'one step halves the 800-pixel square')
  assert.equal(closer.value.window, '200,100,600,500')
  assert.equal(closer.value.sweep,
    '1 of 4 windows looked at · this one is bottom right · not yet: top left, top right, bottom left')

  const next = await committedCall(harness, 'camera_move', { image: imagePath, step: 'next' }, session, 'c')
  assert.equal(next.value.sweep,
    '2 of 4 windows looked at · this one is top left · not yet: top right, bottom left',
    'the sweep counts the windows the camera stopped in, in reading order')
  assert.match(next.value.window, /^-?\d+,-?\d+,-?\d+,-?\d+$/, 'and a window came back')
  assert.notEqual(next.value.window, closer.value.window, 'the camera moved')
  assert.match(describeResult(next.value), /^sweep: 2 of 4 windows looked at/m,
    'the text carries the same line the value does')

  const back = await committedCall(harness, 'camera_reset', { image: imagePath, marks: false }, session, 'd')
  assert.equal(back.value.marksShown, false, 'a clean canvas, on request')
  assert.equal(back.value.window, '0,-100,800,700')
  assert.match(back.value.sweep, /the whole picture is one window/)
  assert.match(describeResult(back.value), /no marks drawn/, 'and the text says the picture is clean')
})

test('the record is a fold: a committed call counts, an errored result does not', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  await committedCall(harness, 'mark_add', {
    image: imagePath, marks: [{ at: [120, 140], r: 20, caption: 'kept' }]
  }, session, 'one')

  // The harness logs a call before dispatch and its result after it. These arguments would
  // have been accepted, so nothing but the result's own error can keep the call out.
  session.append('tool/call', {
    turn: 2, step: 1, callId: 'bad', name: 'mark_add',
    arguments: JSON.stringify({ image: imagePath, marks: [{ at: [500, 500], r: 20 }] })
  })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: { role: 'tool', toolCallId: 'bad', isError: true },
    error: { name: 'Error', code: 'MARK_FAILED' }
  })

  const kept = await committedCall(harness, 'mark_add', {
    image: imagePath, marks: [{ at: [400, 300], r: 20 }]
  }, session, 'two')
  assert.deepEqual(kept.value.marked, [2], 'the number after the errored call, not one it skipped')
  assert.equal(kept.value.record.length, 2)
  assert.equal(kept.value.marks, 2)
  assert.ok(!kept.value.record.some((line) => line.includes('500,500')),
    'the errored call put no mark in the record')

  // A call still pending when its turn ended never produced a result at all: a killed process
  // must not leave half a record behind.
  session.append('tool/call', {
    turn: 3, step: 1, callId: 'gone', name: 'mark_add',
    arguments: JSON.stringify({ image: imagePath, marks: [{ at: [600, 400], r: 20 }] })
  })
  session.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
  const after = await call(harness, 'camera_reset', { image: imagePath }, session)
  assert.equal(after.value.marks, 2, 'an unfinished call is dropped at turn end')
})

test('the arguments the model can send are the only ones accepted', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath })
  const session = fakeSession(dir)
  await assert.rejects(
    () => call(harness, 'camera_move', { image: imagePath }, session),
    /camera_move needs/)
  await assert.rejects(
    () => call(harness, 'camera_move', { image: imagePath, step: 'sideways' }, session),
    /move must be/)
  await assert.rejects(
    () => call(harness, 'camera_zoom_in', { image: imagePath, times: 0 }, session),
    /times must be/)
  await assert.rejects(
    () => call(harness, 'mark_add', { image: imagePath, marks: [{ at: [10, 10], r: 'wide' }] }, session),
    /r must be a number of picture pixels/)
  await assert.rejects(
    () => call(harness, 'mark_add', { image: imagePath, marks: [{ at: [10, 10], colour: 'chartreuse' }] }, session),
    /unknown colour/)
  await assert.rejects(
    () => call(harness, 'mark_edit', { image: imagePath, ops: [{ id: 99, move: [1, 2] }] }, session),
    /no mark #99/)
  await assert.rejects(
    () => call(harness, 'mark_remove', { image: imagePath, marks: [] }, session),
    /non-empty/)
})

test('a picture that cannot be stored is reported, and the record survives it', async (t) => {
  const { dir, imagePath } = await fixture(t)
  const harness = fakeHarness({ imagePath, storeFails: true })
  const session = fakeSession(dir)
  const result = await committedCall(harness, 'mark_add', {
    image: imagePath, marks: [{ at: [200, 200], r: 20 }]
  }, session, 'nostore')
  assert.equal(result.value.attached, false)
  assert.match(result.value.note, /could not be stored/)
  assert.equal(result.value.marks, 1, 'the record is kept even when the picture is not')
  const text = result.content.find((block) => block.type === 'text').text
  assert.match(text, /the picture was not attached/)
})

test('the client half claims a row for every registered tool, and only those', async () => {
  // A tool with no row still answers, but its picture never reaches the reader; adding a row
  // for a tool that does not exist is a slot nobody can dispatch to. The two lists are one list.
  const harness = fakeHarness({ imagePath: 'x.jpg' })
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const listed = /const TOOL_NAMES = \[([^\]]+)\]/.exec(source)
  assert.ok(listed, 'the client half lists the tool names it claims')
  const claimed = listed[1].split(',').map((name) => name.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(claimed.slice().sort(), [...harness.tools.keys()].sort(),
    'the client half\'s TOOL_NAMES is the registered tool names')
})

test('the workflow is published as a skill, for a task that matches it', () => {
  const skills = []
  const ctx = {
    tools: { register() { return () => {} } },
    fs: { async resolve(path) { return { path } } },
    effect(fn) { return fn() },
    get(service) {
      if (service === 'skills') {
        return { register(skill) { skills.push(skill); return () => {} } }
      }
      return undefined
    }
  }
  apply(ctx)
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.name, 'vision-sweep-count')
  assert.equal(skill.source, 'runtime')
  assert.match(skill.whenToUse, /how many of something a picture holds/)
  assert.match(skill.content, /camera_reset/, 'the first step is seeing the whole picture')
  assert.match(skill.content, /step: "next"/, 'the sweep is the camera walking windows')
  assert.match(skill.content, /read it before doing anything else/, 'a mark is checked at once')
  assert.match(skill.content, /mark_edit/, 'a correction is named')
  assert.match(skill.content, /Count the record/, 'the count comes from the record')
})
