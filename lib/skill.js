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
  'mark as you read, finish each rectangle, and count the record.'

export const SKILL_WHEN_TO_USE =
  'A task asks how many of something a picture holds, asks where something is in one, or asks ' +
  'to mark, label or annotate places in one.'

export const SKILL_CONTENT = `# Count or annotate places in a picture

The \`vision_*\` tools draw a grid of the picture's own pixel coordinates and keep a record of
numbered marks that every later look draws again. Work through a picture like this; it is the
difference between a count someone can check and one they cannot.

1. **Look at the whole picture.** \`vision_look\` with no arguments. Every grid line is labelled
   in original pixels — read a position off the labels, never off the pixels of the image in
   front of you, which is a rendering at a size the tool chose.

2. **Sweep it in rectangles you keep.** \`vision_look\` with \`regions\`: up to nine rectangles
   at once, returned as one sheet of tiles, each labelled with its rectangle. Let neighbouring
   rectangles overlap so nothing falls between two, and keep the list — step 4 needs the same ones.
   From there, aim the camera rather than cutting the picture up: \`zoom: "in"\` goes closer,
   \`move: [dx, dy]\` shifts by original pixels, \`reset\` returns to the whole picture, and a look
   with no arguments shows where the camera already is. The camera stays where you leave it.

   Keep the rectangles: a place read inside a frame you have already used is comparable with
   the last one, where a new frame for every look makes positions drift. Work through them in
   order, and let the \`looked:\` line at the end of each result be the list of what is left.

3. **Mark as you read, and read what comes back.** \`vision_mark\` two or three places at a time:
   the picture comes back at once, drawn around them with a cross at each centre — read it before
   doing anything else. A ring that is off is moved with \`vision_edit\` or deleted with
\`vision_unmark\` in the same breath. Never carry a ring you know is wrong into the next look:
   it is still drawn there, and every judgement after it is made against a picture that lies. A place
   read from the whole picture is good to tens of pixels and from a close view to a few; \`r\` sets
   a ring radius in the picture's own pixels when it has to match something you can see.

4. **Finish a rectangle before leaving it.** \`vision_look\` with \`marks: true\` shows what you
   have already marked, and the \`looked:\` line beside it lists each rectangle you have been
   through with the number of marks inside. A rectangle with none is either finished or
   forgotten: go back before moving on. \`vision_edit\` moves a mark that is nearly right;
   \`vision_unmark\` deletes one that is not.

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
