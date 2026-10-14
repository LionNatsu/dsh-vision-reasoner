# dsh-vision-reasoner — internals

## Modules

| Path | Role |
|---|---|
| `index.js` | Host half: registers the four tools, folds each record from the session log, stores the rendered pictures |
| `lib/views.js` | The geometry a caller reads: a grid's step, the places on it, the rectangle a call means — all pure |
| `lib/record.js` | The mark record, the only functions that change it, and the conversion from a call's arguments to those functions |
| `lib/core.js` | One call: validate, change the record, decide what to draw, write the text the caller reads |
| `lib/draw.js` | The overlays, as SVG strings (pure) |
| `lib/render.js` | A region of the picture, plus its overlay, as a PNG through `sharp`; also header-only dimensions |
| `lib/client.js` | Browser half: one transcript row per tool name |

`views.js` knows only pixels and rectangles, `record.js` knows only marks,
`render.js` is the only module that touches pixels, `core.js` decides what a call
means, `index.js` talks to the harness, and `client.js` runs in the browser.

`sharp` is the only dependency. Node has no image codec of its own, and the harness
already uses `sharp` for every image a session attaches
(`@deepseek-ai/dsh-attachment-local` depends on it).

## The grid and the places

A grid is drawn at multiples of a round step of the picture's own pixels, and every
line is labelled with that number on all four edges. Nothing in a call is expressed
in the terms of an earlier view: a place is a pair of original pixels, which is what
makes a call replayable, a number portable between views, and a position independent
of how closely the picture is being looked at.

- The step is the coarsest of `10, 20, 50, 100, 200, 500, …` whose lines are still
  about a hundred view pixels apart (`MIN_LABEL_SPACING`). A closer view therefore
  steps finer without changing what a number means, and two axes of the same view
  always agree because the step is one number.
- Every view is rendered at the same longest side (`VIEW_TARGET`), so a rectangle of
  the picture is never coarser than the whole picture, and a small one is magnified
  until `MAX_CLOSE_SCALE`.
- A ring size is a number of original pixels (`s` 30, `m` 60, `l` 120 radius), not a
  fraction of the view: a size that depended on the view would make a replayed call
  depend on what the caller happened to be looking at.
- `MAX_VIEW_DIMENSION` caps every view, sheets included.
- Line widths have a floor of 2-3 pixels and scale with the view: the attachment
  pipeline re-encodes a view, and hairlines do not survive it.
- `applyMarkArgs` and `applyUpdateArgs` throw on bad input rather than repairing it:
  a record that absorbed a malformed mark would be wrong invisibly.

    svg_x = (original_x - view.x0) * view.sx

Two scales rather than one, because a fitted view rounds its two dimensions
independently.

## The record

```json
{ "image": "picture.jpg", "marks": [
  { "id": 1, "kind": "point", "x": 640, "y": 480, "r": 60, "caption": "", "colour": "green" }
] }
```

A mark is addressed by the number drawn on the picture: `#17`. The record is the
only place a place is a picture coordinate; a caller sends one, and gets every one
back in the list beside each picture.

The record is a fold of the session log, and nothing else is stored:

- a `tool/call` for `vision_mark` / `vision_unmark` / `vision_edit` is a pending
  mutation;
- its `tool/result` with no `error` commits it, a failed one drops it;
- a `turn/end` drops anything still pending.

The fold replays a call through the same `marksFromArgs` / `opsFromArgs` the live
call used, so a rebuilt record is the record the model was working with. It needs no
state of its own, and no picture: a place is a pair of pixels and a size is a number
of pixels, so there is nothing to measure. The live path passes the picture's
dimensions only to refuse a place outside it, which is a refusal, not a value — a
call that was refused never committed, so the two paths cannot disagree.

Reads are incremental: only the events appended since the last read are folded,
cached per session id.

No event type of our own is used, because `Session.append` cannot set the
`ignorable` envelope marker and `@deepseek-ai/dsh-session`'s read path refuses a log
containing an event type outside `KNOWN_SESSION_EVENT_TYPES` without it. A plugin
inventing one would leave session restore broken behind it.

## Pictures

A view is rendered to PNG, committed through `ctx.attachments.saveImage`, and sent
as a `{ type: 'image', attachment }` block — the shape `read_image` uses.

The Web UI's document preview decides how to render a file from its extension, and
an attachment object (`attachments/v1/objects/<sha>`) has none, so each view is also
written to `<cwd>/.dsh-vision/<name>.png` and reported workspace-relative in
`images[].path` and in `presentationMeta`. That directory is the only thing this
plugin writes. `ctx.fs` exposes no binary write, so it goes through `node:fs`,
inside the session workspace and under the policy the session already runs under.

Clicking a tool call shows its picture because `lib/client.js` claims a key in the
client-side `tool.call.toolview` slot. The row reads `block.meta.path` and calls the
slot's `openFile(path)`, which opens the same preview tab `read_image` opens. It must
not declare the `tool.call.images` child slot: that slot has a single owner — the
read-image row — and a second declaration throws at bundle load.

Two failures are reported in text instead of thrown: no attachment service, and a
model that does not declare image input. A storage failure is reported too, since
the marks are committed by then.

## Tools

| Tool | Behaviour |
|---|---|
| `vision_look` | The whole picture, a rectangle of it, several rectangles at once, several marks side by side, or a colour painted out. Draws the marks only when asked |
| `vision_mark` | Adds marks at the coordinates given, numbered in the order given |
| `vision_unmark` | Deletes marks by number, through the same removal operation as `vision_edit` |
| `vision_edit` | Moves, resizes, recaptions or recolours marks by number; one call takes many operations |

A look that names several rectangles renders each at `TILE` and assembles one sheet
labelled with each rectangle, capped at `MAX_SHEET_TILES` — nine tiles at 620 pixels
fit under the attachment pipeline's downscale threshold, and a tenth would buy a
smaller picture rather than a bigger one. Sheet cells follow the tiles' mean aspect
ratio, because square cells around wide tiles double a sheet's pixels to show the
same picture. A sweep is the shape a counting task needs: one call for a band of the
picture, then a `cover` of the same rectangle to find what the band still shows.

Every result carries the same things: the picture's size, the rectangle drawn, the
grid's step, whether the marks are drawn, and the whole record as one line per mark
with its coordinates. A mark and a move report the picture drawn *around what was
just changed*, so the caller sees the result of its own change without a second
look — the whole picture when the change is spread across it. `vision_list` is not a
tool because a caller should never have to ask what it has already been told.

`vision_mark`, `vision_unmark` and `vision_edit` leave `isConcurrencySafe`
undeclared, so the registry schedules them exclusively: two calls editing one record
must not interleave, or two marks would be handed the same number.

## Reading the picture

Through `ctx.fs` (`resolve` → `stat` → `readBytes`), which is the sandbox's own
path: a picture outside the permitted roots is refused by the harness rather than
read around it by a plugin holding `node:fs`. Bytes are cached per reported version.
