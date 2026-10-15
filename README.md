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
| `vision_look` | Look at the whole picture, at a rectangle of it given as `[x0, y0, x1, y1]` in original pixels, or at up to nine rectangles at once, which come back as one sheet of labelled tiles. Compare marks side by side; paint a colour out. The picture is drawn without the marks unless they are asked for. |
| `vision_mark` | Mark places by their coordinates, `at: [x, y]` in original pixels, with a size, a caption and a colour. |
| `vision_unmark` | Delete marks by number, e.g. `[3, 7]`, when a mark is in the wrong place. |
| `vision_edit` | Move, resize, recaption or recolour marks by number, in one call. |

Every picture comes back with a grid whose lines sit at round positions in the
picture's own pixels — 100, 200, 500, depending on how closely it is being looked
at — and every line is labelled with that number along all four edges. A number the
model reads is a number it can use. Every result also lists the whole record, with
the coordinates of every mark, so a mark placed twice, or in the wrong spot, is
visible in the next answer rather than several calls later. The tools never count
or judge what is in a picture: that is the model's statement to make.

The package also publishes a skill, `vision-sweep-count`: the workflow this tool set was
built around — look, sweep in rectangles, mark as you read, finish each rectangle with
`cover`. A model reads a skill when a task matches one, which matters here because
pointing inside reasoning is a mode a model does not enter on its own.

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
3. **Mark the coordinates.** `vision_mark` takes `at: [x, y]`, a size the caller
   judges by eye (`s`, `m`, `l`), a caption and a colour. The picture comes back
   drawn around what was just marked, with the ring on it and the record beside it.
4. **Sweep, then finish a tile at a time.** `regions` takes up to nine rectangles
   and returns one sheet, each tile labelled with the rectangle it came from and
   carrying its own grid. Reading a tile, marking what is in it, then `cover`ing that
   same rectangle is how a crowded scene is counted in a handful of calls instead of
   twenty separate looks.
5. **Check, then correct.** `cover` paints the marked colours out, so whatever still
   shows has not been marked; `compare` puts marks side by side when two places are
   too close to tell apart; `vision_edit` moves a mark that is nearly right and
   `vision_unmark` deletes one that is not. A change comes back drawn around what it
   touched — one tile per mark when those are spread across the picture — so a ring
   that missed its face is visible in the answer that placed it.

## Behaviour

**The record is not written to disk.** Marks live in the session log. The harness
logs every tool call with its arguments and its result, and the record is a fold of
those events, rebuilt with the same pure functions the live call used. A call
carries everything the fold needs — a place is a pair of pixels and a size is a
number of pixels, with no picture to measure — so a reopened session recovers the
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
- Marks are drawn only when asked for, so what is being read is the picture.
- Every result lists the rectangles the picture has been looked at in, newest first, with how
  many marks are inside each, and names the ones left empty. A caller cannot see its own
  coverage, and a rectangle it went through and forgot is where a missing row comes from.
- The view line says how the drawing relates to the picture — `drawn 1400x986 (0.54x of the
  picture)` — because a caller that reads the rendering as the picture itself is wrong by
  exactly that ratio. One session reported reading a "1540x1084 preview" while every number
  it had was in a 2600-pixel space.
- A sheet is the only way to put several places in one picture, because pictures
  received separately cannot be compared. Its cells take the shape of the tiles they
  hold, so a row of wide tiles is not padded into squares, and it holds at most nine
  tiles so the sheet is not downscaled on its way out.
- `cover` paints the given colours out: whatever still shows has not been marked.
  It checks the record, not the perception that produced it.
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
- **Checking is cheap, not automatic.** Nothing forces a second look or a `cover`.

## Development

```
node test/vision.test.mjs     # the grid, the places, the record, the pictures
node test/tools.test.mjs      # the Host half against a stand-in harness
```

The first checks the geometry (the grid steps in round pixels, a place is refused
outside the picture, a size is a ring in pixels), renders real PNGs, and drives
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
