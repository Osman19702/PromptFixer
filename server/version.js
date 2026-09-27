/**
 * What package.json says about this build, read once: the running version
 * and the project website. package.json is the one place either is written
 * down — `npm run check:release` fails if any source file repeats the version
 * literal — so everything that needs them imports them from here.
 *
 * electron-builder packs package.json (build.files), so this path resolves
 * inside app.asar as well as from a checkout.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

export const VERSION = pkg.version

/**
 * The project website ("homepage"), or '' when package.json names none. The
 * interface links to it; nothing in the app ever fetches it.
 */
export const HOMEPAGE = typeof pkg.homepage === 'string' ? pkg.homepage : ''
