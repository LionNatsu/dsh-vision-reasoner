/**
 * Dev check: print the harness's own tool-row CSS rules, so a third-party row can
 * match them. The rules live in a hashed CSS-module string inside the shipped
 * client bundle; the class NAMES are internal, but the declarations are the
 * answer to "what does a native row look like".
 *
 *   node tools/row-css.mjs                        # every rule
 *   node tools/row-css.mjs _root _title _fileLink # only rules matching a name
 *   node tools/row-css.mjs --bundle <path to dsh-client-ui-tool/lib/client.js>
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const bundleFlag = args.indexOf('--bundle')
const BUNDLE = bundleFlag < 0
  ? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai',
      'dsh-client-ui-tool', 'lib', 'client.js')
  : args[bundleFlag + 1]
const wanted = bundleFlag < 0 ? args : args.filter((_, i) => i !== bundleFlag && i !== bundleFlag + 1)

let source
try {
  source = readFileSync(BUNDLE, 'utf8')
} catch (error) {
  console.error(`cannot read the client bundle at ${BUNDLE}: ${error.message}`)
  console.error('pass --bundle <path> if the harness is installed elsewhere')
  process.exit(1)
}

// The module CSS is one long JavaScript string literal per module; the bundle
// carries dozens, so every one is collected and the rules are filtered by name.
const strings = [...source.matchAll(/const css\$?\d* = "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
if (strings.length === 0) {
  console.error('no CSS module strings found in the bundle')
  process.exit(1)
}
const css = strings.join('\n').replace(/\\n/g, '\n').replace(/\\"/g, '"')

let printed = 0
for (const rule of css.split('}')) {
  const selector = rule.split('{')[0]?.trim()
  if (!selector) continue
  if (wanted.length === 0 || wanted.some((w) => selector.includes(w))) {
    console.log(`${rule.trim()}}`)
    printed++
  }
}
console.error(`${strings.length} module stylesheet(s), ${printed} rule(s) printed`)
