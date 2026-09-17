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
 * the app's own choice).
 *
 * SHOT_MARKS=1 marks the rewrite before the picture is taken, the way a user would: one passage
 * kept, one marked for change, so the shot shows the highlights, the count and "Fix again with
 * my marks". A real model's rewrite is not known in advance, so the passages are chosen from
 * what came back: the first sentence, and the sentence furthest from it that is still in view.
 * SHOT_KEEP / SHOT_CHANGE name the passages instead (each has to occur in the rewrite).
 *
 * The website image is
 *   SHOT_REAL=1 SHOT_MARKS=1 SHOT_PROMPT="explain how machine learning works" SHOT_INTENT=general \
 *     node scripts/capture-screenshot.mjs ../my-portfolio/img/promptfixer.png 1200 750
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SLOW = 600_000 // model load plus a CPU-speed fix can take minutes

/**
 * Sentences of the rewrite that make a sensible mark: list markers and headings' signs are left
 * out of the passage, and anything too short to read as a highlight or too long to be one is
 * skipped. Each is a substring of the rewrite, which is what a selection is.
 */
export function markCandidates(rewrite) {
  const text = String(rewrite ?? '')
  const seen = new Set()
  return (
    text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/, '').trim())
      .flatMap((line) => line.split(/(?<=[.!?:])\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 16 && s.length <= 140 && !seen.has(s) && seen.add(s))
      // A passage that occurs twice would be marked at its first place, wherever the second one is.
      .filter((s) => text.indexOf(s) === text.lastIndexOf(s))
  )
}

async function main() {
  // Imported here, not at the top: the tests import this file for markCandidates() alone.
  const { startStub } = await import('../acceptance/support/stub-provider.js')
  const { startApp } = await import('../acceptance/support/app.js')
  const { launchBrowser, closeBrowser, openApp, typePrompt, runFix, ui, marking, markPassage, selectPassage } = await import(
    '../acceptance/support/browser.js'
  )
  const { BLOG_PROMPT } = await import('../acceptance/support/fixtures.js')

  const out = path.resolve(process.argv[2] || 'docs/screenshots/promptfixer.png')
  const width = Number(process.argv[3] || 1200)
  const height = Number(process.argv[4] || 750)
  const real = process.env.SHOT_REAL === '1'
  const marks = process.env.SHOT_MARKS === '1'
  const prompt = process.env.SHOT_PROMPT || BLOG_PROMPT
  const intent = process.env.SHOT_INTENT || ''

  /** Whether the passage, selected, lies inside what the results pane shows without scrolling. */
  const inView = async (page, passage) => {
    await selectPassage(page, passage)
    const seen = await page.evaluate(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return false
      const box = sel.getRangeAt(0).getBoundingClientRect()
      const pane = document.querySelector('pre.output')?.closest('.pane-body')?.getBoundingClientRect()
      const bar = document.querySelector('.feedback-bar')?.getBoundingClientRect()
      return !!pane && box.height > 0 && box.bottom <= pane.bottom - 4 && box.top >= (bar ? bar.bottom : pane.top)
    })
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    return seen
  }

  const markRewrite = async (page) => {
    const rewrite = await ui.output(page).evaluate((el) => el.textContent)
    const candidates = markCandidates(rewrite)
    const nothing = `nothing to mark in this rewrite (${candidates.length} candidate passages); name them with SHOT_KEEP and SHOT_CHANGE`
    const named = (name, passage) => {
      if (passage && !rewrite.includes(passage)) throw new Error(`${name} is not in the rewrite: "${passage}"`)
      return passage
    }
    const keep = named('SHOT_KEEP', process.env.SHOT_KEEP) || candidates[0]
    if (!keep) throw new Error(nothing)
    await markPassage(page, 'keep', keep)
    // Only now: the first mark gives the bar its second row (count, Clear marks, Fix again),
    // which pushes the rewrite down, so what was in view a moment ago may not be any more.
    let change = named('SHOT_CHANGE', process.env.SHOT_CHANGE)
    if (!change) {
      // From the far end back towards the kept passage: the two highlights should not sit side by side.
      for (const passage of candidates.filter((c) => !keep.includes(c) && !c.includes(keep)).reverse()) {
        if (await inView(page, passage)) {
          change = passage
          break
        }
      }
    }
    if (!change) throw new Error(nothing)
    await markPassage(page, 'change', change)
    await marking.count(page).filter({ hasText: '1 kept · 1 to change' }).waitFor()
    // Leave nothing of the driver on the picture: no hover, no focus ring, no selection.
    await page.mouse.move(0, 0)
    await page.evaluate(() => {
      document.activeElement?.blur?.()
      window.getSelection()?.removeAllRanges()
    })
    console.log(`kept:   "${keep}"\nchange: "${change}"`)
  }

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
      if (marks) await markRewrite(page)
      // Let the "Fixed in …" toast go so the shot is the resting state of the interface.
      await page.locator('.toast').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(300)
      await page.screenshot({ path: out })
      console.log(`wrote ${out} (${width}x${height}, ${real ? 'real local model' : 'stub provider'}${marks ? ', marked' : ''})`)
    } finally {
      await close()
    }
  } finally {
    await closeBrowser()
    await app.stop()
    await stub?.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
