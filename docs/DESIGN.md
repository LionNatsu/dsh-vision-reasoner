# dsh-vision-reasoner — how it is put together

Four model-facing tools over one idea: a mark is a position, a
number, a caption and a colour, and the number is drawn on the picture — so the
number *is* the address. Nothing in the package counts, lists or judges anything
about a picture; counting what it holds is the model's statement to make.

## Modules

| Path | Role |
|---|---|
| `index.js` | DSH host half: registers the four tools, folds the record out of the session log, attaches the pictures |
| `lib/record.js` | A mark record, and the ONLY two functions that change one — both pure |
| `lib/core.js` | One call: validate, change the record, decide which pictures to draw |
| `lib/draw.js` | Those pictures, as SVG strings (pure) |
| `lib/render.js` | SVG over the photograph, as PNG, through `sharp`; also header-only dimensions |
| `lib/client.js` | Browser half: one transcript row per tool name, so a call shows the picture it drew |

The split is the one thing worth defending: `record.js` knows nothing but marks,
`draw.js` knows nothing but shapes and text, `render.js` is the only module that
touches pixels, `core.js` is the only module that decides what a call means,
`index.js` is the only module that talks to the harness, and `client.js` is the
only module that runs in a browser.

Dependencies: `sharp`, and nothing else. Node has no canvas, no font rasterizer
and no image codec of its own, and `sharp` is what the harness itself uses for
every image a session attaches (`@deepseek-ai/dsh-attachment-local` depends on
it), so a deployment that can run this plugin already has it.

## Conventions

- A "view" maps original image pixels to view pixels:
  `svg_x = (original_x - view.x0) * view.sx`, and two scales rather than one,
  because a fitted map rounds its two dimensions independently.
- **Every label on a view is an ORIGINAL-image coordinate or a mark's number.**
  A view may be cropped, scaled and padded; the numbers printed on it never are.
- **A tick is drawn, and the tick is the coordinate** (`text-anchor="middle"` for
  the label, whose y baseline sits `0.35em` below the line so the digits straddle
  it). A close-up carries a magenta crosshair on the address it was asked for,
  captioned with its coordinates. Both exist because a coordinate read off a view
  carries a systematic bias: the rings are right and the reading is wrong, which
  is the one error a caller cannot see from the picture. The cheapest fix is to
  leave a position that needs no reading at all, and to make the instrument itself
  unambiguous — a nudged label is only a lie if there is no tick under it.
- Every view's longest side is capped (`MAX_VIEW_DIMENSION`), including zooms and
  sheets, whatever the caller asks for: a 1200x1200 crop at a 20000-pixel target
  is otherwise a 400-megapixel PNG.
- `ids: false` and `captions: false` draw the rings without the numbers and
  captions over them, for dense clusters where the annotations otherwise cover
  what is being read.
- Coordinates are integers in original pixels. Colour names come from a fixed
  palette; their meaning belongs to the caller (`yellow` = "not sure", by
  convention).
- Errors are plain `Error` with a lowercase message naming the input and the
  reason. `applyMarkArgs` / `applyUpdateArgs` THROW on bad input rather than
  repairing it: a record that quietly absorbed a malformed mark would make a
  count wrong in a way nobody can see.

## The record, and where it lives

```json
{ "image": "picture.jpg", "marks": [
  { "id": 1, "kind": "point", "x": 640, "y": 480, "r": 60, "caption": "", "colour": "green" },
  { "id": 2, "kind": "box", "x0": 120, "y0": 240, "x1": 360, "y1": 520, "caption": "", "colour": "green" }
] }
```

Addresses: `#17` a stored mark; `640,480` a point; `120,240,360,520` a
rectangle — the number of coordinates decides which of the last two it is.

**In DSH the record is the session log, and nothing is written anywhere else.**
The harness already logs every tool call with its full arguments and every
result, so the record is a pure fold of events the platform writes anyway:

- a `tool/call` for `vision_mark` / `vision_update` is a **pending** mutation;
- its `tool/result` with no `error` **commits** it, a failed one drops it;
- a `turn/end` drops anything still pending.

The fold calls the same `applyMarkArgs` / `applyUpdateArgs` the live call used, so
a record rebuilt after a restart is the record the model was working with, by
construction rather than by test. Reads are incremental: only the events appended
since the last read are folded, cached per session id.

Why not a `vision/mark` session event of our own? Because `Session.append` cannot
set the `ignorable` envelope marker, and `@deepseek-ai/dsh-session`'s persistence
read path refuses to interpret a log containing an event type outside
`KNOWN_SESSION_EVENT_TYPES` without it. A downstream plugin inventing an event
type would leave session restore broken behind it.

## Pictures

A view is rendered to PNG and committed through `ctx.attachments.saveImage`, then
travels as a `{ type: 'image', attachment }` block — the shape `read_image` uses.
So nothing is written beside the user's picture, and the model sees what was
drawn without a second call.

**A person needs a file, not an attachment.** The Web UI's document preview
decides how to render a file from its extension, and an attachment object has none
(`attachments/v1/objects/<sha>`), so each view is ALSO written to
`<cwd>/.dsh-vision/<name>.png` and reported workspace-relative in `images[].path`
and in `presentationMeta`. That directory is the only thing this plugin writes.
`ctx.fs` exposes no binary write, so it goes through `node:fs`; the target is
inside the session workspace, under the policy the session already runs under.

**Clicking a tool call shows its picture** because of `lib/client.js`, not because
of any host field. The transcript row for a tool name comes from a client-side
keyed slot (`tool.call.toolview`), and the built-in image row is gated on the name
being exactly `read_image`; a third-party tool claims its own key. The row reads
`block.meta.path` (this is what `presentationMeta` is for) and calls the row's
injected `openFile(path)`, which opens the same preview tab `read_image` opens. It
must NOT declare the `tool.call.images` child slot: that slot is single-owner and
already declared by the read-image row, and a second declaration throws at bundle
load.

Two failures are reported in the text instead of thrown: no attachment service,
and a route whose model does not declare image input (the gate `read_image`
applies — a model that cannot take images cannot use the view). Anything merely
*uncertain* attaches anyway: withholding a picture because a lookup failed once
cost more than it protected. A storage or file-write failure is reported too,
because by then the marks are already committed and failing the call would deny
work that happened.

## The four tools

| Tool | What it does |
|---|---|
| `vision_mark` | Adds marks, numbered in the order given. `view`: `map` (default) / `marks` (a sheet of just these) / `none` |
| `vision_update` | Moves, recaptions, recolours or removes marks by number; one call takes many operations |
| `vision_show` | The look: no address = the map; one address = a close-up with a coordinate grid; several = one sheet; `cover` paints settled colours out |
| `vision_list` | The record as text, one line per mark — a statement about the record, never about the picture |

`vision_mark` and `vision_update` leave `isConcurrencySafe` undeclared, so the
registry schedules them exclusively: two calls editing one record must not
interleave, or two marks would be handed the same number.

## Reading the picture

Through `ctx.fs` (`resolve` → `stat` → `readBytes`), which is the sandbox's own
path: a picture outside the permitted roots is refused by the harness rather than
read around it by a plugin holding `node:fs`. Bytes are cached per reported
version, so a second look in the same turn does not re-read the file.
