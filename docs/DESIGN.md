# dsh-vision-reasoner — internals

## Modules

| Path | Role |
|---|---|
| `index.js` | Host half: registers the five tools, folds each record from the session log, stores the rendered views |
| `lib/record.js` | The mark record, and the only two functions that change it — both pure |
| `lib/core.js` | One call: validate, change the record, decide which views to render |
| `lib/draw.js` | The views, as SVG strings (pure) |
| `lib/render.js` | SVG over the picture, as PNG, through `sharp`; also header-only dimensions |
| `lib/client.js` | Browser half: one transcript row per tool name |

`record.js` knows only marks, `draw.js` only shapes and text, `render.js` is the
only module that touches pixels, `core.js` decides what a call means, `index.js`
talks to the harness, and `client.js` runs in the browser.

`sharp` is the only dependency. Node has no image codec of its own, and the harness
already uses `sharp` for every image a session attaches
(`@deepseek-ai/dsh-attachment-local` depends on it).

## Views

A view maps original pixels to view pixels, with two scales because a fitted map
rounds its two dimensions independently:

    svg_x = (original_x - view.x0) * view.sx

- Every label is an original-image coordinate or a mark's number; the tick line is
  the coordinate, and the label is centred on it. A label nudged inwards to stay on
  the canvas would otherwise misstate the position it names.
- A close-up draws a crosshair on the address it was asked for, so one position on
  the tile needs no reading.
- `MAX_VIEW_DIMENSION` caps every view, sheets included, whatever the caller asks.
- Line widths have a floor of 2-3 view pixels and scale with the zoom: the
  attachment pipeline re-encodes a view, and hairlines do not survive it.
- Coordinates are integers in original pixels. Colour names come from a fixed
  palette; what they mean is the caller's business.
- `applyMarkArgs` and `applyUpdateArgs` throw on bad input rather than repairing
  it: a record that absorbed a malformed mark would be wrong invisibly.

## The record

```json
{ "image": "picture.jpg", "marks": [
  { "id": 1, "kind": "point", "x": 640, "y": 480, "r": 60, "caption": "", "colour": "green" },
  { "id": 2, "kind": "box", "x0": 120, "y0": 240, "x1": 360, "y1": 520, "caption": "", "colour": "green" }
] }
```

Addresses: `#17` a stored mark, `640,480` a point, `120,240,360,520` a rectangle —
the number of coordinates decides which of the last two it is.

The record is a fold of the session log, and nothing else is stored:

- a `tool/call` for `vision_mark` / `vision_update` is a pending mutation;
- its `tool/result` with no `error` commits it, a failed one drops it;
- a `turn/end` drops anything still pending.

The fold calls the same two pure functions the live call used, so a rebuilt record
is the record the model was working with. Reads are incremental: only the events
appended since the last read are folded, cached per session id.

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
| `vision_mark` | Adds marks, numbered in the order given. `view`: `map` (default) / `marks` |
| `vision_unmark` | Deletes marks by number, through the same removal operation as `vision_update` |
| `vision_update` | Moves, recaptions, recolours or removes marks by number; one call takes many operations. `view` defaults to `map` |
| `vision_show` | No address: the map. One: a close-up. Several: a sheet. `cover` paints given colours out |
| `vision_list` | The record as text, one line per mark |

`vision_mark`, `vision_unmark` and `vision_update` leave `isConcurrencySafe`
undeclared, so the registry schedules them exclusively: two calls editing one record must not
interleave, or two marks would be handed the same number.

## Reading the picture

Through `ctx.fs` (`resolve` → `stat` → `readBytes`), which is the sandbox's own
path: a picture outside the permitted roots is refused by the harness rather than
read around it by a plugin holding `node:fs`. Bytes are cached per reported version.
