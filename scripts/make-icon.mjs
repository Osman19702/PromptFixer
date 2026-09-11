/**
 * Render build/icon.svg to build/icon.png (1024 x 1024, transparent) with Playwright's Chromium.
 *
 * electron-builder converts build/icon.png into the Windows .ico (and the macOS .icns) itself; the
 * PNG is committed so the rasterisation is deterministic and does not depend on the builder's own
 * SVG renderer. Re-run after editing the SVG:
 *
 *   node scripts/make-icon.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'build', 'icon.svg')
const target = path.join(root, 'build', 'icon.png')
const size = 1024

const svg = fs.readFileSync(source, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
  await page.screenshot({ path: target, omitBackground: true })
} finally {
  await browser.close()
}
console.log(`wrote ${path.relative(root, target)} (${fs.statSync(target).size} bytes)`)
