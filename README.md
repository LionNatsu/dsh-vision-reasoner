# dsh-vision-reasoner

A DeepSeek Harness plugin that lets a model put numbered marks on a picture and
look at what it drew. Every view is labelled in original-image pixels, so a
coordinate comes from the picture rather than from a guess at a scaled preview,
and several places can be compared in one image. It is not specific to any kind
of picture: counting the people in a photograph is one use, checking which of two
similar regions a note meant is another.

## Tools

| Tool | Purpose |
|---|---|
| `vision_mark` | Add numbered marks. One call takes a whole round of them. |
| `vision_unmark` | Delete marks by number, e.g. `[3, 7]`, when a mark is in the wrong place. |
| `vision_update` | Move, recaption, recolour or delete marks by number — `17=yellow`, `21 "half hidden"` in one call. Comes back with the whole frame redrawn, like every call that changes the record. |
| `vision_show` | Look: the whole frame with a ruler, a close-up of one address, several addresses as one sheet, or a `cover` that paints given colours out. |
| `vision_list` | Read the record back as text. |

A mark is a position, a number, a caption and a colour. The number is drawn on the
picture, so `#17` can be moved, recoloured or deleted without describing it in
words. The tools never count or judge what is in a picture — that is the model's
statement to make — and `vision_list` reports only how many marks the record
holds.

## Install

```
dsh plugin --profile <name> add dsh-vision-reasoner
```

Or from the Web UI: **Plugins → Add plugin**, with the package name. The package
declares `dsh.bundle.patch` → `./cordis.patch.yml` (one Host row), which the
profile loader applies the next time the profile loads. There is no build step and
no install script.

The only dependency is [`sharp`](https://sharp.pixelplumbing.com/) (Apache-2.0),
which the harness already uses for every image a session attaches
(`@deepseek-ai/dsh-attachment-local` depends on it), so a deployment that can run
this plugin already has it. Nothing third-party is vendored: the icon and the two
locale files are this package's own. Node `^22.19.0 || >=24.0.0`.

## Behaviour

**The record is not written to disk.** Marks live in the session log. The harness
logs every tool call with its arguments and its result, and the record is a fold of
those events, rebuilt with the same two pure functions the live call used. A
reopened session recovers the same record, and nothing appears beside your
picture.

**Each view is written twice.** The model receives an image block through the
attachment service, the shape `read_image` sends, so the picture arrives with the
call that drew it. The Web UI's preview needs a file, because it decides how to
render a document from its extension and an attachment object has none; the PNG is
therefore also written to `<cwd>/.dsh-vision/<name>.png` and reported
workspace-relative in `images[].path`. That directory is the only thing this
plugin writes, and only when there is a picture to show.

**A missing picture is reported, not thrown.** No attachment service, or a model
that does not declare image input (the gate `read_image` applies), returns the text
plus a note instead of an image block; so does a failed write. Anything merely
unknown — an unresolvable route, an adapter error — attaches anyway, because
withholding a picture over a failed lookup costs more than it protects.

**Pictures are read through `ctx.fs`**, so the sandbox decides what may be read.

## What a view shows

- Labels are original-image coordinates or mark numbers, never fractions of the
  rendered image. A map gets a ruler whose tick line is the coordinate; a close-up
  gets a coordinate grid.
- Every call that changes the record returns the whole frame, so the picture arrives
  with the change and `vision_show` is for looking again, not for looking at all.
- Ticks, grid lines and rings are drawn 2-3 pixels wide at minimum and scale with the
  zoom. A one-pixel guide line is gone by the time the attachment pipeline has
  re-encoded the picture, and an invisible guide is worse than none.
- A close-up draws a magenta crosshair on the address it was asked for, captioned
  with its coordinates, so one position on the tile needs no reading at all.
- Every mark's number is drawn on the picture in its own colour.
- Several addresses come back as one sheet, which is the only way to compare them.
- `cover` paints the given colours out, so whatever still shows has not been
  marked. It checks the record, not the perception that produced it.
- `ids: false` and `captions: false` draw the rings alone, for places where the
  annotations cover what is being read.
- A view's longest side is capped at 4096 pixels (`MAX_VIEW_DIMENSION`), including
  sheets, whatever the caller asks for.

## Limitations

- **Reading a coordinate is still the model's job.** A mark lands exactly where the
  record says; the reading that produced it can be tens of pixels off. The ruler
  and the crosshair make that visible, not impossible.
- **A record belongs to the session that made it.** A subagent sees the marks of
  the session it was forked from; its parent does not see the subagent's. Two
  agents need one session to share a record.
- **Only points and boxes are stored.** Anything else, such as how much of an
  object is visible, cannot be written down.
- **Labels need a font.** Text is rendered by librsvg, so a machine with no fonts
  draws shapes but no digits.
- **Text width is estimated**, not measured, so a caption may be cut a character
  early. It never overflows its tile.
- **A call that produced no result** — a process killed mid-call — is left out of
  the replayed record. The model may have been told about a mark the replay does
  not have.
- **Native presentation only.** Under code execution (PTC) the calls are not logged
  as `tool/call`, so the fold does not see them.
- **Checking is cheap, not automatic.** Nothing forces a look at a sheet or a
  `cover`.

## Development

```
node test/vision.test.mjs     # record, views, geometry, dimension caps
node test/tools.test.mjs      # the Host half against a stand-in harness
```

The first renders real PNGs and inspects pixel colours, so a mark that moved would
fail. The second drives all four tools against a fake session and filesystem: it
checks that every returned value satisfies its declared output schema, and that the
record is a fold — a committed call counts, a failed one does not, an unfinished one
never happened.

`tools/replay-session.mjs <session.v4.jsonl.zstd> [--png out.png]` rebuilds a
record from a stored session log with no harness in the loop, and can render it
onto the picture it names. `tools/inspect-region.mjs IMAGE X Y W H` prints part of
an image as ASCII. `tools/row-css.mjs` prints the harness's own tool-row CSS.

`index.js` is the Host half. `lib/client.js` is the browser half, which claims one
transcript row per tool name. The module contracts are in
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — see [`LICENSE`](LICENSE).
