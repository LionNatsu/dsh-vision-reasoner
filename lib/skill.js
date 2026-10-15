/**
 * The skill this package publishes: the workflow that makes pointing work.
 *
 * The model is trained to emit coordinates, but pointing *inside* reasoning is a mode it
 * does not enter on its own — it reads a task like "count the people" and looks, and
 * looks, and writes the marks down at the end, where they cannot help it. A skill is the
 * one channel that arrives before the work starts, so the recipe lives here rather than
 * only in the tool descriptions, which are read while deciding whether to call at all.
 *
 * @module lib/skill
 */

export const SKILL_NAME = 'vision-sweep-count'

export const SKILL_DESCRIPTION =
  'Count or annotate places in a picture with the vision tools: sweep it in rectangles, ' +
  'mark as you read, and finish each rectangle with cover.'

export const SKILL_WHEN_TO_USE =
  'A task asks how many of something a picture holds, asks where something is in one, or asks ' +
  'to mark, label or annotate places in one.'

export const SKILL_CONTENT = `# Count or annotate places in a picture

The \`vision_*\` tools draw a grid of the picture's own pixel coordinates and keep a record of
numbered marks that every later look draws again. Work through a picture like this; it is the
difference between a count someone can check and one they cannot.

1. **Look at the whole picture.** \`vision_look\` with no \`region\`. Every grid line is labelled
   in original pixels — read a position off the labels, never off the pixels of the image in
   front of you, which is a rendering at a size the tool chose.

2. **Sweep it.** \`vision_look\` with \`regions\`: up to nine rectangles at once, returned as one
   sheet of tiles, each labelled with its rectangle. Let neighbouring rectangles overlap so
   nothing falls between two of them, and keep the list — step 4 needs the same ones.

3. **Mark as you read.** In a tile, \`vision_mark\` two or three places at a time: the picture
   comes back around them with a cross at each centre, close enough to see whether a ring is on
   what it names. A place read from the whole picture is good to tens of pixels, and from a close
   view to a few. Mark what you have decided now rather than at the end: a mark stays on the
   picture, and the marks you have placed are what you read instead of remembering.

4. **Finish each rectangle.** \`vision_look\` with that same \`region\` and \`cover: "green"\`: every
   mark is painted out, so whatever still shows is unmarked. Mark it, cover again, and only then
   move on. \`vision_edit\` moves a mark that is nearly right; \`vision_unmark\` deletes one that is
   not.

5. **Count the record, not the picture.** The count is the number of marks in the record, which
   every result lists. Look at the whole picture once with \`marks: true\` before answering, and
   say plainly what you were unsure about. The tools never judge what a picture holds — that
   statement is yours.
`

/** The skill, ready to hand to \`ctx.get('skills')\`. */
export const SKILL = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  whenToUse: SKILL_WHEN_TO_USE,
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: true },
  content: SKILL_CONTENT
}
