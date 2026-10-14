/**
 * Print a region of an image as coarse ASCII, for checking where a label landed.
 *
 *   node tools/inspect-region.mjs IMAGE X Y W H
 */
import sharp from 'sharp'

const [file, x0, y0, w, h] = process.argv.slice(2)
const left = Number(x0 ?? 0)
const top = Number(y0 ?? 0)
const width = Number(w ?? 60)
const height = Number(h ?? 30)
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

let out = ''
for (let y = top; y < top + height; y++) {
  let line = ''
  for (let x = left; x < left + width; x++) {
    const i = (y * info.width + x) * 4
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    if (r > 180 && g > 180 && b > 180) line += 'W'
    else if (g > 170 && r < 130 && b < 130) line += 'G'
    else if (b > 170 && g > 140 && r < 130) line += 'C'
    else if (r > 170 && g > 150 && b < 120) line += 'Y'
    else if (r < 60 && g < 60 && b < 60) line += '#'
    else line += '.'
  }
  out += `${String(y).padStart(4)} ${line}\n`
}
console.log(`${file} ${info.width}x${info.height}, region ${left},${top} ${width}x${height}`)
console.log(out)
