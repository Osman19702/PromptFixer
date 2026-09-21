/**
 * The running version, read from package.json — the one place it is written
 * down. `npm run check:release` fails if any source file repeats the literal,
 * so everything that needs the version imports it from here.
 *
 * electron-builder packs package.json (build.files), so this path resolves
 * inside app.asar as well as from a checkout.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version
