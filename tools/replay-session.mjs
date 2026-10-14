/**
 * Rebuild a mark record from a stored session log, outside the harness.
 *
 * The DSH half of this plugin keeps no state of its own: the record is a fold of
 * the `tool/call` and `tool/result` events the harness writes anyway. This tool
 * does that fold from a `.jsonl.zstd` session file with no harness, no model and
 * no attachment service in the loop — which is the strongest available check
 * that the design claim is true, and a way to see what another session actually
 * marked.
 *
 *   node tools/replay-session.mjs <session.v4.jsonl.zstd> [--image <name>]
 *   node tools/replay-session.mjs <session...> --png <out.png>
 *
 * With `--png`, the recovered record is rendered onto the picture it names, so
 * the marks can be looked at rather than only listed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

import { applyMarkArgs, applyUpdateArgs, emptyRecord, imageKey, recordSummary } from '../lib/record.js'
import { renderViews } from '../lib/render.js'
import { probeImageSize } from '../lib/render.js'

const MUTATING = new Set(['vision_mark', 'vision_update'])

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Read a session log's text.
 *
 * A DSH session log is a CONCATENATION of zstd frames — one per append — and
 * `zstdDecompressSync` stops after the first, which for a real log is only the
 * header. `ZSTD_findFrameCompressedSize` is not exposed to JavaScript, so each
 * frame's end is found by decompressing from every candidate magic offset and
 * taking the shortest slice that decodes: a slice spanning two frames also
 * decodes, so the shortest success is the boundary. (`dsh-context-explorer`'s
 * `tools/zstd-frames.mjs` solves the same problem the same way.)
 */
function readSessionLog(buffer) {
  const offsets = []
  for (let at = 0; (at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1; at += 4) offsets.push(at)
  const parts = []
  let cursor = 0
  while (cursor < buffer.length) {
    let end = null
    for (const candidate of offsets) {
      if (candidate <= cursor) continue
      try {
        const text = zstdDecompressSync(buffer.subarray(cursor, candidate)).toString('utf8')
        if (text.length > 0) { end = { at: candidate, text }; break }
      } catch {
        // Not a frame boundary yet; try a longer slice.
      }
    }
    if (end === null) {
      try {
        parts.push(zstdDecompressSync(buffer.subarray(cursor)).toString('utf8'))
      } catch {
        // Undecodable tail.
      }
      break
    }
    parts.push(end.text)
    cursor = end.at
  }
  return parts.join('')
}

const [file, ...flags] = process.argv.slice(2)
if (!file) {
  console.error('usage: node tools/replay-session.mjs <session.v4.jsonl.zstd> [--image NAME] [--png OUT.png]')
  process.exit(1)
}
const flagValue = (name) => {
  const at = flags.indexOf(name)
  return at < 0 ? undefined : flags[at + 1]
}

const text = readSessionLog(readFileSync(file))
const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    continue
  }
  // The persistence format wraps a record per line; the event is either the
  // record itself or one field inside it.
  events.push(parsed.type === undefined && parsed.event !== undefined ? parsed.event : parsed)
}

/**
 * The session's own working directory, from the header record the log opens
 * with. The plugin keys a record by `imageKey(image, session.header.cwd)`, so a
 * replay that used the process cwd instead would print a DIFFERENT key and a
 * different record for any relative image path — which would make this tool's
 * whole point (an outside reader rebuilding the record) quietly untrue.
 */
const sessionCwd = events.find((event) => event.type === 'session')?.cwd

const wanted = flagValue('--image')
const records = new Map()
const pending = new Map()

for (const event of events) {
  if (event.type === 'tool/call') {
    if (!MUTATING.has(event.data?.name)) continue
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    if (wanted !== undefined && !String(args?.image ?? '').includes(wanted)) continue
    pending.set(event.data.callId, { tool: event.data.name, args })
    continue
  }
  if (event.type === 'tool/result') {
    const callId = event.data?.message?.toolCallId
    const call = callId === undefined ? undefined : pending.get(callId)
    if (call === undefined) continue
    pending.delete(callId)
    if (event.data.error !== undefined || event.data?.message?.isError === true) continue
    const key = imageKey(call.args.image, sessionCwd)
    const record = records.get(key) ?? emptyRecord(call.args.image)
    try {
      records.set(key, call.tool === 'vision_mark'
        ? applyMarkArgs(record, call.args).record
        : applyUpdateArgs(record, call.args).record)
    } catch (error) {
      console.error(`a committed call did not replay: ${error.message}`)
    }
    continue
  }
  if (event.type === 'turn/end') pending.clear()
}

console.log(`${file}`)
console.log(`${events.length} events, ${records.size} image record(s)`)
for (const [key, record] of records) {
  console.log(`\n${recordSummary(record).image}  (${key})`)
  console.log(recordSummary(record).marks === 0
    ? '  no marks'
    : record.marks.map((mark) => `  #${mark.id} ${mark.kind === 'point'
        ? `point ${mark.x},${mark.y} r${mark.r}`
        : `box ${mark.x0},${mark.y0},${mark.x1},${mark.y1}`} ${mark.colour}` +
        `${mark.caption ? ` ${JSON.stringify(mark.caption)}` : ''}`).join('\n'))
}

const out = flagValue('--png')
if (out !== undefined) {
  const [key, record] = [...records.entries()].pop() ?? []
  if (record === undefined) throw new Error('no record to render')
  const path = record.image
  const size = await probeImageSize(path)
  const views = await renderViews(
    { bytes: readFileSync(path), width: size.width, height: size.height, orientation: size.orientation },
    record,
    { map: true, target: 1600 }
  )
  writeFileSync(out, views[0].png)
  console.log(`\nrendered ${views[0].width}x${views[0].height} -> ${out}   (record key ${key})`)
}
