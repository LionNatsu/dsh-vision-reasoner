# dsh-vision-reasoner — internals

## Modules

| Path | Role |
|---|---|
| `index.js` | Host half: registers the four tools, folds each record from the session log, stores the rendered pictures |
| `lib/views.js` | The geometry a caller reads: a grid's step, the places on it, the rectangle a call means — all pure |
| `lib/camera.js` | Where a caller is looking: the ops that aim it, folded from arguments, and their resolution into a rectangle |
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
- A ring radius is a number of original pixels (30 unless the caller says otherwise), not a
  fraction of the view: a radius that depended on the view would change the ring a caller had
  already placed.
- Every view is a square (`VIEW_SIDE`, 1400), capped by `MAX_VIEW_DIMENSION` like any drawing.
- Line widths have a floor of 2-3 pixels and scale with the view: the attachment
  pipeline re-encodes a view, and hairlines do not survive it.
- `applyMarkArgs` and `applyUpdateArgs` throw on bad input rather than repairing it:
  a record that absorbed a malformed mark would be wrong invisibly.

    svg_x = (original_x - view.x0) * view.sx

Two scales rather than one, because a fitted view rounds its two dimensions
independently.

## The camera

A caller is always looking somewhere, and a camera does not stop seeing: there is no "look" verb,
because every action on the camera returns what it now sees. The camera is a fold of ops taken
from the arguments — `reset`, `zoom` by a factor, `move` by a step or to a place, and the `fit` a
mark call performs — so it is as replayable as a mark and survives a restart, while *resolving* it
into a window needs the picture's dimensions and therefore happens where the picture is at hand.

It is a square window, never smaller than `MIN_SIDE` (64) and never larger than the picture's
longer side, positioned by its centre within the picture's bounds; the window itself may reach
past an edge, and what is outside the picture is black. The sweep is read off the same fold: the
windows tile the picture *centred on it*, so the widest window is exactly the first cell of its own
sweep, and a cell counts as looked at when the camera **stopped** in it — not when it passed over
it. A reset clears the count, because a swept picture that is reset is a picture being swept again.

## The record
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

- a `tool/call` for a mark tool — `mark_add` / `mark_remove` / `mark_edit` — is a pending
  mutation;
- its `tool/result` with no `error` commits it, a failed one drops it;
- a `turn/end` drops anything still pending.

The fold replays a call through the same `marksFromArgs` / `opsFromArgs` the live
call used, so a rebuilt record is the record the model was working with. It needs no
state of its own, and no picture: a place is a pair of pixels and a size is a number
of pixels, so there is nothing to measure. The live path passes the picture's
dimensions only to refuse a place outside it, which is a refusal, not a value — a
call that was refused never committed, so the two paths cannot disagree.

A look is folded too, when it names a rectangle: the ledger of where a picture has been
looked at, newest first, each once, is what lets a result say which rectangles are still empty.
The rectangles come from the arguments, so this is as replayable as a mark, and a mark call
carries them forward — an applier that rebuilt a record without the ledger would silently drop
the coverage a caller was relying on.

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
| `camera_reset` | Points the camera at the whole picture: one square window holding all of it |
| `camera_move` | `step` walks the sweep in reading order or by direction; `to: [x, y]` puts the window's centre on a place |
| `camera_zoom_in` / `camera_zoom_out` | Halves or doubles the window about its centre, `times` steps at once |
| `mark_add` | Adds marks at the coordinates given, numbered in the order given, and sends the camera to them |
| `mark_remove` | Deletes marks by number, through the same removal operation as `mark_edit` |
| `mark_edit` | Moves, resizes, recaptions or recolours marks by number; one call takes many operations |

There is one view shape and no verb that picks it: a 1400x1400 square, always. The picture is
placed inside it at the scale that fits and whatever is left over is black, so a view can never
come back as a strip — the failure this redesign answers was a feedback view of 676x115 for a row
of ten marks, whose faces were cut off at the chin; the model could not verify its own rings,
fell back on arithmetic across two renderings, and invented a 71-pixel offset that moved marks
which were already right.

Every result carries the same things: the picture's size, the window the camera looks through,
how the drawing relates to it (`drawn 1400x1400 (1.08x of the picture)`), the grid's step,
whether the marks are drawn, how far the sweep has got in words, and the whole record as one line
per mark with its coordinates. A mark reports the window *around what was just changed*, so the
caller sees the result of its own change without a second call. There is no `vision_list`: a
caller should never have to ask what it has already been told, and no `vision_look`: a camera
does not stop seeing, so every action on it returns what it now sees.

`mark_add`, `mark_remove` and `mark_edit` leave `isConcurrencySafe`
undeclared, so the registry schedules them exclusively: two calls editing one record
must not interleave, or two marks would be handed the same number.

## The skill

`lib/skill.js` publishes one skill, `vision-sweep-count`, through `ctx.get('skills')` when the
composition has that service: sweep in rectangles, mark as you read, finish each rectangle with
and read the ledger. The tool descriptions are read while deciding whether to call a tool;
a skill is read when a task matches one, which is the channel that reaches the model before it
starts. The skill is registered from the calling context's layer, so a profile that mounts this
package offers it to every session in that profile.

## Reading the picture

Through `ctx.fs` (`resolve` → `stat` → `readBytes`), which is the sandbox's own
path: a picture outside the permitted roots is refused by the harness rather than
read around it by a plugin holding `node:fs`. Bytes are cached per reported version.
