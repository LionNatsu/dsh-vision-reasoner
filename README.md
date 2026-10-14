# dsh-vision-reasoner

A DeepSeek Harness plugin that lets a model put numbered marks on a picture and
look at what it drew. A place is named the way it was seen — as a cell of the grid
drawn on the picture — so nothing is converted from a preview, and looking closer
is one more look rather than arithmetic. It is not specific to any kind of
picture: counting the people in a photograph is one use, checking which of two
similar regions a note meant is another.

## Tools

| Tool | Purpose |
|---|---|
| `vision_look` | Look at the whole picture, or at one cell of it closer; compare marks side by side; paint a colour out. The picture is drawn without the marks unless they are asked for. |
| `vision_mark` | Mark places, one cell of a view at a time. Needs the view it was shown. |
| `vision_unmark` | Delete marks by number, e.g. `[3, 7]`, when a mark is in the wrong place. |
| `vision_edit` | Move, resize, recaption or recolour marks by number, in one call. |

Every view carries a grid whose letters and numbers are written along all four
edges, and the result names the view's handle — the caller copies that back when it
marks, moves or looks closer. Every result also lists the whole record, so a mark
that was placed twice, or not at all, is visible in the next answer rather than
several calls later. The tools never count or judge what is in a picture: that is
the model's statement to make.

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

1. **Look first.** Nothing can be marked on a view the model has not been shown:
   `vision_mark` and a moving `vision_edit` require the `view` handle that only a
   `vision_look` result carries.
2. **Lay the grid on the place.** A view is cut into cells as square as its shape
   allows — a wide picture gets more columns than rows — and every cell has a name
   like `C3`. The grid follows the picture's aspect ratio rather than a fixed count
   per axis.
3. **Look closer by naming a cell.** `vision_look` with a cell returns that cell
   as a new view with a finer grid of its own, so one face in a crowd is read by
   looking at it twice rather than by estimating a coordinate.
4. **Mark the cell.** A mark is placed at the centre of the cell the model named,
   with a size it can see (`s`, `m`, `l`), a caption and a colour. The picture comes
   back with the ring on it, plus the record.

## Behaviour

**The record is not written to disk.** Marks live in the session log. The harness
logs every tool call with its arguments and its result, and the record is a fold of
those events, rebuilt with the same pure functions the live call used. A call
carries everything the fold needs — the view it was placed on is the handle in its
own arguments — so a reopened session recovers the same record, and nothing appears
beside your picture.

**Each view is written twice.** The model receives an image block through the
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

## What a view is

- A view is a rectangle of the picture, rendered at a size the plugin chooses. Its
  handle is that rectangle — digits and commas, no letters to confuse — so it
  survives a restart and a copied handle always names the same region.
- The grid is derived from the rectangle's shape: about seventy cells, as square as
  the shape allows, columns lettered `A…` and rows numbered `1…` on all four edges.
- Cell lines are drawn 2 pixels wide at minimum and scale with the view, because a
  one-pixel line is gone by the time the attachment pipeline has re-encoded the
  picture.
- Marks are drawn only when asked for, so what is being read is the picture.
- A comparison sheet is the only way to put several places in one picture, and it
  exists because pictures received separately cannot be compared.
- `cover` paints the given colours out: whatever still shows has not been marked.
  It checks the record, not the perception that produced it.
- A view's longest side is capped at 4096 pixels (`MAX_VIEW_DIMENSION`).

## Limitations

- **A cell is as fine as the view that carries it.** Marking something smaller than
  a cell means looking at the cell first; a mark is placed at the cell's centre, not
  at a point inside it.
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
- **A log written before the grid redesign does not replay.** Its calls carry
  picture coordinates that no longer exist in the arguments, so the replay reports
  that it could not place them.
- **Native presentation only.** Under code execution (PTC) the calls are not logged
  as `tool/call`, so the fold does not see them.
- **Checking is cheap, not automatic.** Nothing forces a second look or a `cover`.

## Development

```
node test/vision.test.mjs     # views, cells, the record, drawing, the call layer
node test/tools.test.mjs      # the Host half against a stand-in harness
```

The first checks the geometry (a cell is whole pixels, a handle reproduces its
region, a ring size is a fraction the caller can see), renders real PNGs and
inspects pixel colours, and drives every planning function. The second drives all
four tools against a fake session and filesystem: it checks that every returned
value satisfies its declared output schema, that marking cannot skip the look, and
that the record is a fold — a committed call counts, a failed one does not, an
unfinished one never happened.

`tools/replay-session.mjs <session.v4.jsonl.zstd> [--png out.png]` rebuilds a
record from a stored session log with no harness in the loop, and can render it
onto the picture it names. `tools/inspect-region.mjs IMAGE X Y W H` prints part of
an image as ASCII. `tools/row-css.mjs` prints the harness's own tool-row CSS.

`index.js` is the Host half. `lib/client.js` is the browser half, which claims one
transcript row per tool name. The module contracts are in
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — see [`LICENSE`](LICENSE).
