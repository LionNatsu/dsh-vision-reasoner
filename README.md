# dsh-vision-reasoner

**Mark things on a picture, and look at the picture.** A DeepSeek Harness plugin
that gives the model somewhere to put what it sees: numbered marks on the image
itself, coordinates read off a labelled ruler instead of guessed from a preview,
and close-ups that come back as one sheet so doubtful places can be compared
rather than described.

Built from one failure mode and cut back until only what it needs is left. A
vision model reads a large photograph through a downscaled preview, so every
position it takes from that preview is off by the ratio between the two — and
nothing about the answer reveals it. So: a mark carries its own number, a view
carries its own coordinates, and doubtful places can be put side by side.

Nothing here is about one kind of picture: the same four tools count the people
in a photograph, check which of two similar regions a note meant, or follow a
label to the right part of a diagram.

## What the model gets

Four tools.

| Tool | What it is for |
|---|---|
| `vision_mark` | Put numbered marks on a picture. One call takes a whole round of them. |
| `vision_update` | Move, recaption, recolour or delete marks **by their number** — `17=yellow`, `21 "half hidden"`, `16 removed`, in one call. Comes back as a sheet of the marks it touched. |
| `vision_show` | Look: the whole frame with a ruler, a close-up of one place, **several places as one sheet**, or a *cover* that paints the settled marks out. `ids: false` / `captions: false` quiet the marks down when they cover what you are reading. |
| `vision_list` | Read the record back as text. |

A mark is four things: **where it is, a number, a caption, a colour.** The number
is drawn on the picture, so the number *is* the address — `#17` can be pointed
at, moved, recoloured or deleted without describing it in words. Nothing in the
tool set counts, lists or judges anything about the picture: counting what it
holds is the model's statement to make, and `vision_list` will only ever tell it
how many numbers it has drawn.

## Why it exists

A vision model looking at a large photograph through an attachment pipeline sees
a smaller copy of it. Every coordinate read off that copy is wrong by the ratio
between the two, and nothing about the answer reveals it — the result comes out
plausible either way. The fix is not a better estimate. It is to make the picture
carry its own coordinates, and to make looking cheap enough that looking again is
the normal thing to do:

- **Every rendered view is labelled in ORIGINAL pixels.** The map carries a ruler
  with a tick spacing chosen so neighbouring labels never collide; a close-up
  carries a labelled coordinate grid. **The tick line is the coordinate** — a
  short mark is drawn at each position, its label centred on it, and where a
  label has to be nudged inwards to stay on the canvas the tick is still exactly
  where it claims to be.
- **A close-up marks the address itself.** A magenta crosshair sits on the
  position the view was asked for, captioned with its original coordinates. One
  position on the tile therefore needs no reading at all — and a caller that
  reads the grid slightly wrong can see by how much.
- **The number is drawn on the picture, in the mark's colour.** A mark is
  addressable from what is visible.
- **Doubtful places come back as ONE sheet.** "Is this one thing or two, and did
  I already mark that one" is a comparison, and four separate images cannot be
  compared.
- **`cover` makes the record answerable.** Paint the settled marks out and
  whatever still shows has not been marked: a mark sitting on empty background
  appears as a black blob with nothing under it, and something with no blob over
  it is a missed one. This checks the *record*, not the looking — it cannot catch
  a mistake in perception, only a slip in keeping track.
- **The marks can be turned down.** `ids: false` and `captions: false` draw the
  rings without the numbers and captions on top of them. In a dense scene the
  annotations otherwise sit on exactly what is being read.

## Install

```
dsh plugin --profile <name> add dsh-vision-reasoner
```

or from the Web UI: **Plugins → Add plugin**, and give the package name. The
package declares `dsh.bundle.patch` → `./cordis.patch.yml`, one Host row, so the
profile loader applies it the next time the profile loads. There is no build step
and no install script.

The one dependency is [`sharp`](https://sharp.pixelplumbing.com/) (Apache-2.0) —
which is also what the harness itself uses for every image a session attaches
(`@deepseek-ai/dsh-attachment-local` depends on it), so a deployment that can run
this plugin already has it. Nothing third-party is vendored or reproduced in this
package: every line and both assets (the icon and the two locale files) are this
package's own, and `sharp` arrives as an ordinary dependency with its own licence.
Node `^22.19.0 || >=24.0.0`.

## How the plugin behaves

**The record is never written to disk.** The mark record lives in the session:
every `vision_mark` is logged by the harness as a tool call, and the record is a
fold of those calls and their results. No state directory appears beside your
picture, and a session that is reopened rebuilds the same record — the fold runs
the same two pure functions the live call ran.

**A rendered view is written twice, for two different readers.** The model gets an
image block through the harness's attachment service, exactly the way `read_image`
hands over a picture, so the picture arrives in the same turn as the call that
drew it. A *person* gets a real file at `<cwd>/.dsh-vision/<name>.png`, because
that is the only thing the Web UI's preview can open: the preview decides how to
render a file from its extension, and an attachment object has no extension. That
directory is the one thing this plugin writes, it is written only when there is a
picture to show, and each `images[]` entry carries both the `name` the view was
given and the workspace-relative `path` a click on the transcript row opens.

**It says when it could not show you the picture, instead of failing the turn.**
Two cases are reported rather than thrown: no attachment service is mounted, or
the route's model does not declare image input (the same gate `read_image`
applies, since a model that cannot take images cannot use the view). Anything
merely *uncertain* — an unresolvable route, an adapter hiccup — attaches anyway;
withholding a picture because a lookup failed once cost more than it protected.
A storage failure is reported too: the marks are already committed by then, and
failing the call would tell the model its work did not happen.

**It reads the picture through the harness filesystem service**, so the sandbox
decides what may be read, not this plugin.

## Known limits

- **The tool makes a coordinate readable; reading it is still the model's job.**
  A model asked to place marks from one of these views will get some of them
  wrong by tens of pixels: the ring lands exactly where the record says, and the
  reading that produced the record was the model's. The crosshair and the tick
  lines reduce that rather than remove it. Check a doubtful mark with a close-up
  before trusting it.
- **A record belongs to the session that made it.** Marks live in the log they
  were made in, so a subagent sees the marks of the session it was forked from
  but its parent never sees the subagent's. Two agents cannot share one record;
  if they need to, they need one session.
- **No channel is independent of the model's own seeing.** `cover` reprocesses
  marks the model made, so it catches slips in keeping the record, not mistakes
  in perception. A mark that is confidently wrong is still wrong.
- **Labels are rendered by librsvg**, so they need a font on the machine. Text is
  drawn in a monospace stack for numbers; a system with no fonts at all would
  render shapes but no digits.
- **Text width is estimated**, not measured, so a caption can be truncated a
  character earlier than strictly necessary. It never overflows its tile.
- **Only points and boxes can be stored.** "How much of this object is visible"
  cannot be written down.
- **A tool call that never produced a result** — a process killed mid-call —
  leaves its mutation out of the replayed record. That is the conservative
  direction: the model may have been told about a mark that a later replay does
  not have.
- **Native tool presentation only.** In a code-execution (PTC) presentation the
  calls are not logged as `tool/call`, so the fold would not see them.
- **Nothing forces the checking steps to happen.** Looking at a sheet, or running
  a `cover`, is cheap, not automatic.

## Layout, checks, licence

One npm package, both halves: `index.js` (the Host half) and `lib/client.js` (the
browser half, which claims one transcript row per tool name so the picture a call
drew is visible where the call is), plus five modules under `lib/` —
`record.js` (what a mark is, and the only two functions that change one),
`core.js` (one call, with no I/O), `draw.js` (the views, as SVG) and `render.js`
(SVG over the photograph, as PNG). See
[`docs/DESIGN.md`](docs/DESIGN.md) for the module contracts and the reasoning
behind the session-log record.

From the repository root:

```
node test/vision.test.mjs     # record, views, geometry, dimensions
node test/tools.test.mjs      # the Host half against a stand-in harness
```

The first suite renders real PNGs through the real pipeline and asks what colour
particular pixels are, so a mark that moved would fail the tests that claim it
did not. The second drives all four tools against a fake session and filesystem:
it checks that every value satisfies its declared output schema (the registry
rejects a mismatch at dispatch, which is how a `vision_list` value once shipped
without its `views` key), and that the record really is a fold — a committed
call counts, a failed one does not, an unfinished one never happened.

`tools/replay-session.mjs <session.v4.jsonl.zstd>` rebuilds a record from a
stored session log with no harness in the loop, and `--png` renders it onto the
picture it names. It is the strongest available check on the central claim — that
the record lives in the log and nowhere else — and it is how the marks a
different session made can be looked at afterwards.
`tools/inspect-region.mjs IMAGE X Y W H` prints a region of any image as ASCII,
for checking where a label actually landed.

MIT — see [`LICENSE`](LICENSE).
