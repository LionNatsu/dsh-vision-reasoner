# dsh-vision-reasoner — internals

## Modules

| Path | Role |
|---|---|
| `index.js` | Host half: registers the four tools, folds each record from the session log, stores the rendered views |
| `lib/views.js` | The geometry a caller reads: a view's grid, a cell, the place a cell names — all pure |
| `lib/record.js` | The mark record, the only two functions that change it, and the conversion from a call's arguments to those functions |
| `lib/core.js` | One call: validate, change the record, decide what to draw, write the text the caller reads |
| `lib/draw.js` | The overlays, as SVG strings (pure) |
| `lib/render.js` | A region of the picture, plus its overlay, as a PNG through `sharp`; also header-only dimensions |
| `lib/client.js` | Browser half: one transcript row per tool name |

`views.js` knows only grids and rectangles, `record.js` knows only marks,
`render.js` is the only module that touches pixels, `core.js` decides what a call
means, `index.js` talks to the harness, and `client.js` runs in the browser.

`sharp` is the only dependency. Node has no image codec of its own, and the harness
already uses `sharp` for every image a session attaches
(`@deepseek-ai/dsh-attachment-local` depends on it).

## Views

A view is a rectangle of the picture, rendered at a size this package chooses. The
rectangle *is* the caller's handle for it — `x0,y0,x1,y1`, digits only — which is
what makes a call replayable and a handle stable across a restart.

- The grid is derived from the rectangle's shape, not from a count per axis:
  `cols = clamp(round(sqrt(70 · width / height)), 2, 26)`, `rows = round(70 / cols)`.
  A wide view gets more columns than rows, a tall view the reverse, and the cells
  stay close to square whatever the aspect ratio is.
- A cell is a whole-pixel rectangle inside the view. `placeOn` returns its centre:
  a caller names what it can see, and the conversion is the only place picture
  coordinates are produced.
- A ring size is a fraction of the view's shorter side (`s` 2%, `m` 5%, `l` 12%), so
  a size looks the same to the reader whatever the view is.
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
only place a place is a picture coordinate; no caller ever sends one.

The record is a fold of the session log, and nothing else is stored:

- a `tool/call` for `vision_mark` / `vision_unmark` / `vision_edit` is a pending
  mutation;
- its `tool/result` with no `error` commits it, a failed one drops it;
- a `turn/end` drops anything still pending.

The fold replays a call through the same `marksFromArgs` / `opsFromArgs` the live
call used, so a rebuilt record is the record the model was working with. It needs no
state of its own: a call's own arguments carry the view handle it was placed on, and
a handle is a rectangle. Reads are incremental: only the events appended since the
last read are folded, cached per session id.

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
| `vision_look` | The whole picture, or one cell of a view closer, or several marks side by side, or a colour painted out. Answers a handle and a grid; draws the marks only when asked |
| `vision_mark` | Adds marks at the centres of the cells named, numbered in the order given. Requires the view it was shown |
| `vision_unmark` | Deletes marks by number, through the same removal operation as `vision_edit` |
| `vision_edit` | Moves, resizes, recaptions or recolours marks by number; one call takes many operations |

Every result carries the same five things: the picture, the handle (`view`), the
grid's name, whether the marks are drawn, and the whole record as one line per mark
named by a cell of the whole picture's grid. `vision_list` is not a tool because a
caller should never have to ask what it has already been told.

`vision_mark`, `vision_unmark` and `vision_edit` leave `isConcurrencySafe`
undeclared, so the registry schedules them exclusively: two calls editing one record
must not interleave, or two marks would be handed the same number.

## Reading the picture

Through `ctx.fs` (`resolve` → `stat` → `readBytes`), which is the sandbox's own
path: a picture outside the permitted roots is refused by the harness rather than
read around it by a plugin holding `node:fs`. Bytes are cached per reported version.
