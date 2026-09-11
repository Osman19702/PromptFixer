/**
 * Screenshot the built app for the website.
 *
 *   npm run build
 *   node scripts/capture-screenshot.mjs <out.png> [width] [height]
 *
 * Two modes:
 *   default       the acceptance stub provider answers the fix (no model needed); the header
 *                 shows the stub's label, so this is for layout checks, not publishing.
 *   SHOT_REAL=1   the real local model from %USERPROFILE%\.promptfixer\models answers the fix,
 *                 so every pixel is what a user sees. Slower (model load + inference).
 *
 * SHOT_PROMPT overrides the prompt typed into the editor (default: the blog-post sample) and
 * SHOT_INTENT picks the Task type preset for it (writing, code, analysis, ...; default: leave
 * the app's own choice). The website image is
 *   SHOT_REAL=1 SHOT_PROMPT="explain how machine learning works" SHOT_INTENT=general \
 *     node scripts/capture-screenshot.mjs ../my-portfolio/img/promptfixer.png 1200 750
 */
import os from 'node:os'
import path from 'node:path'
import { startStub } from '../acceptance/support/stub-provider.js'
import { startApp } from '../acceptance/support/app.js'
import { launchBrowser, closeBrowser, openApp, typePrompt, runFix, ui } from '../acceptance/support/browser.js'
import { BLOG_PROMPT } from '../acceptance/support/fixtures.js'

const out = path.resolve(process.argv[2] || 'docs/screenshots/promptfixer.png')
const width = Number(process.argv[3] || 1200)
const height = Number(process.argv[4] || 750)
const real = process.env.SHOT_REAL === '1'
const prompt = process.env.SHOT_PROMPT || BLOG_PROMPT
const intent = process.env.SHOT_INTENT || ''
const SLOW = 600_000 // model load plus a CPU-speed fix can take minutes

const stub = real ? null : await startStub()
const app = await startApp(
  real
    ? { env: { PROMPTFIXER_MODEL_DIR: path.join(os.homedir(), '.promptfixer', 'models') } }
    : { stub, env: { COMPATIBLE_LABEL: process.env.SHOT_LABEL || 'Stub' } },
)
await launchBrowser()
try {
  const { page, close } = await openApp(app, { viewport: { width, height } })
  try {
    await typePrompt(page, prompt)
    if (intent) await page.locator('#intent').selectOption(intent)
    if (real) {
      await ui.fixButton(page).click({ timeout: SLOW })
      await page.getByRole('tab', { name: /^Fixed/, selected: true }).waitFor({ timeout: SLOW })
      await ui.output(page).waitFor({ timeout: SLOW })
    } else {
      await runFix(page)
    }
    // Let the "Fixed in …" toast go so the shot is the resting state of the interface.
    await page.locator('.toast').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(300)
    await page.screenshot({ path: out })
    console.log(`wrote ${out} (${width}x${height}, ${real ? 'real local model' : 'stub provider'})`)
  } finally {
    await close()
  }
} finally {
  await closeBrowser()
  await app.stop()
  await stub?.close()
}
