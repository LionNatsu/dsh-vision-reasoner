# dsh-vision-reasoner

A DeepSeek Harness plugin that lets a model put numbered marks on a picture and
look at what it drew. A place is named in the picture's own pixels, read off a
labelled grid, so nothing is converted from a preview and no call has to be
expressed in the terms of an earlier one. It is not specific to any kind of
picture: counting the people in a photograph is one use, checking which of two
similar regions a note meant is another.

## Tools

| Tool | Purpose |
|---|---|
| `camera_reset` | Point the camera at the whole picture — one square window holding all of it, the picture drawn inside and the rest black — and see it. |
| `camera_move` | `step: "next"` walks the sweep in reading order, `"previous"` steps back, a direction steps one whole window, and `to: [x, y]` centres the window on a place read off the grid. |
| `camera_zoom_in` / `camera_zoom_out` | One ×2 or ÷2 step each, about the centre, `times` for several at once. The camera stays where it is left. |
| `mark_add` | Mark places by their coordinates, `at: [x, y]` in original pixels, with a radius `r`, a caption and a colour. The camera moves to the batch and the answer is a window around it. |
| `mark_remove` | Delete marks by number, e.g. `[3, 7]`, when a mark is in the wrong place. |
| `mark_edit` | Move, resize, recaption or recolour marks by number, in one call. |

Every picture comes back with a grid whose lines sit at round positions in the
picture's own pixels — 100, 200, 500, depending on how closely it is being looked
at — and every line is labelled with that number along all four edges. A number the
model reads is a number it can use. Every result also lists the whole record, with
the coordinates of every mark, so a mark placed twice, or in the wrong spot, is
visible in the next answer rather than several calls later. The tools never count
or judge what is in a picture: that is the model's statement to make.

The package also publishes a skill, `vision-sweep-count`: the workflow this tool set was
built around — see the whole picture, sweep it window by window, mark as you read, read the
window that comes back, count the record. A model reads a skill when a task matches one, which
matters here because pointing inside reasoning is a mode a model does not enter on its own.

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

## How it is used

1. **Look first.** A place is named from what has been seen, and the tool
   descriptions say so before anything else. The grid on the returned picture is
   the only ruler: the picture is not cropped with another tool, and no position is
   read off another view of it, whose pixels are a different size.
2. **Read the labels.** The lines are at round numbers of original pixels, so a
   position is read by naming the line before a feature and estimating the gap —
   about a quarter of a step is as fine as the eye goes, which is why the grid steps
   finer as the view gets closer.
3. **Mark the coordinates.** `mark_add` takes `at: [x, y]`, a radius `r` in the
   picture's own pixels, a caption and a colour. The camera moves to what was marked
   and the answer is a square window around those marks, with a cross at each centre
   and the record beside it.
4. **Sweep in windows you keep.** `camera_zoom_in` until a face is big enough to read,
   then walk the picture with `camera_move` and `step: "next"`: the windows tile the
   picture from its centre, "next" goes left to right and then down, and every result
   says how far the sweep has got and which windows are left. A place read in a window
   already used is comparable with the last one.
5. **Check, then correct.** The marks are drawn in every view, so what is left unmarked
   in the window in front of you is what you have not dealt with, and the record beside
   it shows a number twice or a ring on nothing. `mark_edit` moves a mark that is nearly
   right and `mark_remove` deletes one that is not — at once, since a change comes back
   as a window around what it touched and a wrong ring misleads every view after it.

## Behaviour

**The record is not written to disk.** Marks live in the session log. The harness
logs every tool call with its arguments and its result, and the record is a fold of
those events, rebuilt with the same pure functions the live call used. A call
carries everything the fold needs — a place is a pair of pixels, a radius is a number
of pixels, and the camera is a list of ways it was aimed — so a reopened session recovers the
same record, and nothing appears beside your picture.

**Each picture is written twice.** The model receives an image block through the
attachment service, the shape `read_image` sends, so the picture arrives with the
call that drew it. The Web UI's preview needs a file, because it decides how to
render a document from its extension and an attachment object has none; the PNG is
therefore also written to `<cwd>/.dsh-vision/<name>.png` and reported
workspace-relative in `images[].path`. That directory is the only thing this plugin
writes, and only when there is a picture to show.

**A missing picture is reported, not thrown.** No attachment service, or a model
that does not declare image input (the gate `read_image` applies), returns the text
plus a note instead of an image block; so does a failed write. Anything merely
unknown — an unresolvable route, an adapter error — attaches anyway, because
withholding a picture over a failed lookup costs more than it protects.

**Pictures are read through `ctx.fs`**, so the sandbox decides what may be read.

## The grid

- Lines sit at multiples of a round step — 10, 20, 50, 100, 200, 500 … — chosen as
  the coarsest step whose labels are still about 100 view pixels apart. A wide view
  and a close view therefore both stay readable, and neither changes what a number
  means.
- Every label is an original-image coordinate, on all four edges, whatever the view
  is. Nothing is scaled, and nothing has to be converted.
- Lines are drawn 2 pixels wide at minimum and scale with the view, because a
  one-pixel line is gone by the time the attachment pipeline has re-encoded the
  picture.
- Every view is rendered at the same longest side, so looking at a rectangle is
  never coarser than looking at the whole picture.
- The camera is a place, not an action. A look shows what is in front of the lens, `zoom` and
  `move` aim it, `reset` points it back at the whole picture, and every result says where it is —
  so a caller reads "closer, a little left" rather than inventing rectangles, and looking again
  needs no arguments at all.
- Marks are drawn by default, so the picture carries the record; `marks: false` gives a clean
  canvas for counting a place again from scratch.
- Every result counts the windows the camera has **stopped in** since the last reset, names the
  one it is in, and names the ones still left: an unswept corner is a word in the answer rather
  than something a caller has to keep in its head.
- The window line says how the drawing relates to the picture — `drawn 1400x1400 (1.08x of the
  picture)` — because a caller that reads the rendering as the picture itself is wrong by exactly
  that ratio. One session reported reading a "1540x1084 preview" while every number it had was
  in a 2600-pixel space, and concluded the mapping was ambiguous.
- Every view is the same shape: a 1400x1400 square. The picture is placed inside it at the scale
  that fits and whatever is left over is black, so no view can come back as a strip one face
  tall, and no two views are shaped differently from each other.
- The grid is always drawn: both axes are labelled along all four edges, the columns that run
  down and the rows that run across in different colours, and a row label keeps out of the band
  where the column labels write so a corner is not a fight between two numbers.
- A view's longest side is capped at 4096 pixels (`MAX_VIEW_DIMENSION`).

## Limitations

- **A mark is where the caller said it was.** The grid makes a position readable to
  about a quarter of its step, and nothing more; a mark placed from the whole
  picture of a large photograph lands within tens of pixels, not within one.
- **A record belongs to the session that made it.** A subagent sees the marks of
  the session it was forked from; its parent does not see the subagent's. Two
  agents need one session to share a record.
- **Labels need a font.** Text is rendered by librsvg, so a machine with no fonts
  draws shapes but no digits.
- **Text width is estimated**, not measured, so a caption may be cut a character
  early. It never overflows its tile.
- **A call that produced no result** — a process killed mid-call — is left out of
  the replayed record. The model may have been told about a mark the replay does
  not have.
- **A log written before this redesign does not replay.** Its calls carry cell names
  where the arguments now hold coordinates, so the replay reports that it could not
  place them.
- **Native presentation only.** Under code execution (PTC) the calls are not logged
  as `tool/call`, so the fold does not see them.
- **Checking is cheap, not automatic.** Nothing forces a second look, and the ledger only
  reports where the camera has been: it says nothing about what a rectangle holds.

## Development

```
node test/vision.test.mjs     # the grid, the places, the record, the pictures
node test/tools.test.mjs      # the Host half against a stand-in harness
```

The first checks the geometry (the grid steps in round pixels, a place is refused
outside the picture, a ring is a radius in pixels), renders real PNGs, and drives
every planning function. The second drives all four tools against a fake session and
filesystem: it checks that every returned value satisfies its declared output
schema, that a place is named in the picture's own pixels, and that the record is a
fold — a committed call counts, a failed one does not, an unfinished one never
happened.

`tools/replay-session.mjs <session.v4.jsonl.zstd> [--png out.png]` rebuilds a
record from a stored session log with no harness in the loop, and can render it
onto the picture it names. `tools/inspect-region.mjs IMAGE X Y W H` prints part of
an image as ASCII. `tools/row-css.mjs` prints the harness's own tool-row CSS.

`index.js` is the Host half. `lib/client.js` is the browser half, which claims one
transcript row per tool name. The module contracts are in
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — see [`LICENSE`](LICENSE).
