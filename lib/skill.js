/**
 * The skill this package publishes: the workflow that makes pointing work.
 *
 * The model is trained to emit coordinates, but pointing *inside* reasoning is a mode it does
 * not enter on its own — it reads a task like "count the people" and looks, and looks, and
 * writes the marks down at the end, where they cannot help it. A skill is the one channel that
 * arrives before the work starts, so the recipe lives here rather than only in the tool
 * descriptions, which are read while deciding whether to call at all.
 *
 * @module lib/skill
 */

export const SKILL_NAME = 'vision-sweep-count'

export const SKILL_DESCRIPTION =
  'Count or annotate places in a picture with the camera tools: sweep it window by window, ' +
  'mark as you read, and count the record.'

export const SKILL_WHEN_TO_USE =
  'A task asks how many of something a picture holds, asks where something is in one, or asks ' +
  'to mark, label or annotate places in one.'

export const SKILL_CONTENT = `# Count or annotate places in a picture

The camera tools draw a grid of the picture's own pixel coordinates and keep a record of numbered
marks, which every later view draws again. The camera is always a square window on the picture:
the picture is drawn inside it and whatever is left over is black. Work through a picture like
this; it is the difference between a count someone can check and one they cannot.

1. **See the whole picture first.** \`camera_reset\`. Every grid line is labelled in original
   pixels — read a position off the labels, never off the pixels of the image in front of you,
   which is a rendering at a size the tool chose. At this size the whole picture is a single
   window; there is nothing to sweep until you zoom in.

2. **Sweep it in windows, at one scale.** \`camera_zoom_in\` until faces are big enough to read,
   then walk the picture with \`camera_move\` and \`step: "next"\`: the windows tile the picture
   centred on it, "next" goes left to right and then down, and every result says how far the sweep
   has got and which windows are left. Keep that scale for the whole sweep — every zoom changes the
   grid — and work through the windows in order rather than jumping about: a place read in a window
   you have already used is comparable with the last one. \`camera_move\` with
   \`to: [x, y]\` goes straight to a place you can see, and \`camera_zoom_out\` or
   \`camera_reset\` pulls back.

3. **Mark as you read, and read what comes back.** \`mark_add\` two or three places at a time.
   The answer is the window you are already in, with the new marks drawn and a cross at each
   centre — read it before doing anything else, and nothing moves underneath you: a mark never
   changes where the camera is, so the sweep you are in the middle of stays where it was. A ring
   that is off is moved with
   \`mark_edit\` or deleted with \`mark_remove\` in the same breath. Never carry a ring you know
   is wrong into the next view: it is still drawn there, and every judgement after it is made
   against a picture that lies. A place read from the whole picture is good to tens of pixels and
   from a close window to a few; \`r\` sets a ring's radius in the picture's own pixels when it
   has to match what you can see.

4. **Finish a window before leaving it.** The marks are drawn in every view, so what is left
   unmarked in the window in front of you is what you have not dealt with. Every result lists the
   whole record as well: a number that is there twice, or a ring on nothing, shows at once.
   \`mark_edit\` moves a mark that is nearly right; \`mark_remove\` deletes one that is not.

5. **Count the record, not the picture.** The count is the number of marks in the record, which
   every result lists. Look at the whole picture once before answering — \`camera_reset\`, and
   \`marks: false\` if you want it without your own rings — and say plainly what you were unsure
   about. The tools never judge what a picture holds: that statement is yours.
`

/** The skill, ready to hand to `ctx.get('skills')`. */
export const SKILL = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  whenToUse: SKILL_WHEN_TO_USE,
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: true },
  content: SKILL_CONTENT
}
