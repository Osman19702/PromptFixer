// Visual check targets, run by scripts/visual.mjs and the Group N scenarios.
//
// Every target is one screen of the interface, reached by driving the page the
// way a user would against the real server and the scripted stub provider
// (acceptance/support), so a screen is the same picture on every run with no
// key and no model. A screen is a list of steps: to add one, copy a line of
// `targets` and name the steps that lead to it.
//
// What would differ between two honest captures is kept off the picture:
//   hide  toasts (they carry elapsed seconds and leave on a timer) and the
//         date of a library entry
//   mask  the run details of the Changes tab (elapsed time, token counts)
//   and every driver ends `atRest`: mouse parked, nothing focused or selected,
//   panes scrolled to the top, no spinner. Elastishot itself stops animations
//   and hides the text caret.
import { MODEL_DIR_PREFIX } from './acceptance/support/app.js'
import { markPassage, marking, runFix, typePrompt, ui } from './acceptance/support/browser.js'
import { BLOG_PROMPT, DISLIKED, LOVED } from './acceptance/support/fixtures.js'

const BASE = (process.env.PROMPTFIXER_VISUAL_URL ?? '').replace(/\/+$/, '')
if (!BASE) {
  throw new Error(
    'PROMPTFIXER_VISUAL_URL is not set. The visual check needs the real server and the stub provider running: use "npm run visual" (or "npm run visual:approve"), which starts both.'
  )
}

// Deliberate regressions, so the check can be shown to notice one:
// PROMPTFIXER_VISUAL_VARIANT=<name> restyles the page before it is captured.
const VARIANTS = {
  // the keep highlight loses its green; only the marked screen has one
  'keep-colour': 'pre.output mark.keep { background: #6b5200 !important; color: #fff !important; }',
  // both highlights lose all their paint and keep their place: what then differs is what they painted
  'marks-plain':
    'pre.output mark { background: none !important; box-shadow: none !important; color: inherit !important; text-decoration: none !important; }',
  // the rewrite is set in a larger type; fixed and marked show it, and library through its backdrop
  'rewrite-type': 'pre.output { font-size: 16px !important; }',
  // the Fix prompt button turns red; every screen shows it, the library's through the backdrop
  'fix-button': '.action-row .btn.primary { background: #c0392b !important; }',
}
const VARIANT = process.env.PROMPTFIXER_VISUAL_VARIANT ?? ''
if (VARIANT && !VARIANTS[VARIANT]) {
  throw new Error(`PROMPTFIXER_VISUAL_VARIANT="${VARIANT}" is not a variant (known: ${Object.keys(VARIANTS).join(', ')})`)
}

// --- steps ---------------------------------------------------------------------

/**
 * The library belongs to the server, not to the browser context: a prompt saved
 * by one capture would be in the next one's drawer, and later fixes would learn
 * from it. So every screen starts by emptying it — which is only ever done to a
 * server started by acceptance/support/app.js, recognised by its throwaway
 * model folder, never to a library somebody is using.
 */
const emptyLibrary = async (page) => {
  const status = await (await page.request.get(`${BASE}/api/local/status`)).json()
  if (!String(status.modelDir).includes(MODEL_DIR_PREFIX)) {
    throw new Error(`${BASE} was not started by the acceptance harness, so its library is left alone. Use "npm run visual".`)
  }
  await page.request.delete(`${BASE}/api/library/all`)
}

/** The app has loaded: the editor, the example gallery, and the model list that gates Fix prompt. */
const ready = async (page) => {
  await ui.editor(page).waitFor()
  await page.locator('[data-testid="example-gallery"] .example-row').first().waitFor()
  // While the list loads the select is disabled and its one option reads "Loading models…".
  await page.locator('select[aria-label="Model"]:enabled').waitFor()
  if (VARIANT) await page.addStyleTag({ content: VARIANTS[VARIANT] })
}

/** The built-in sample typed in; the live score and the issue list follow a debounce. */
const typeSample = async (page) => {
  await typePrompt(page, BLOG_PROMPT)
  await page.locator('[data-testid="issue-list"]').waitFor()
}

/** Fix prompt, until the Fixed tab shows the rewrite. */
const fix = (page) => runFix(page)

/** One passage marked "keep" and one marked "change". */
const markBoth = async (page) => {
  await markPassage(page, 'keep', LOVED)
  await markPassage(page, 'change', DISLIKED)
  await marking.count(page).filter({ hasText: '1 kept · 1 to change' }).waitFor()
}

const openTab = (name) => async (page) => {
  await ui.tab(page, name).click()
  await page.getByRole('tab', { name: new RegExp(`^${name}`), selected: true }).waitFor()
}

/** Save the result, then open the drawer on its one entry. */
const saveAndOpenLibrary = async (page) => {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // Toasts are hidden from the capture, so this one is waited for in the DOM, not on screen.
  await ui.toast(page, 'Saved to library').waitFor({ state: 'attached' })
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await ui.drawer(page).locator('.lib-entry').waitFor()
}

/** Leave nothing of the driver on the picture. */
const atRest = async (page) => {
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    document.activeElement?.blur?.()
    window.getSelection()?.removeAllRanges()
    for (const pane of document.querySelectorAll('.pane-body')) pane.scrollTop = 0
  })
  await page.waitForFunction(() => !document.querySelector('.spinner'))
}

/** A target: a fresh server library, the loaded app, the steps in order, then at rest. */
const screen = (name, ...steps) => ({
  name,
  url: `${BASE}/`,
  capture: {
    waitFor: async (page) => {
      await emptyLibrary(page)
      await ready(page)
      for (const step of steps) await step(page)
      await atRest(page)
    },
  },
})

export default {
  // set but empty counts as not set, as for the URL and the variant: '' would resolve to the project root
  baselineDir: (process.env.PROMPTFIXER_VISUAL_BASELINES ?? '').trim() || '.elastishot/baselines',
  outDir: '.elastishot/runs',
  threshold: 0.98,
  viewports: [
    // the size the browser scenarios run at, and the small window scenario H13 guards
    { name: 'desktop', width: 1360, height: 880 },
    { name: 'small', width: 1024, height: 720 },
  ],
  capture: {
    waitUntil: 'load',
    timeoutMs: 60_000,
    hide: ['[data-testid="toasts"]', '[data-testid="library-entry-date"]'],
    mask: ['[data-testid="run-details"]'],
  },
  report: { title: 'PromptFixer visual check' },
  targets: [
    screen('empty'),
    screen('issues', typeSample),
    screen('fixed', typeSample, fix),
    screen('marked', typeSample, fix, markBoth),
    screen('diff', typeSample, fix, openTab('Diff')),
    screen('changes', typeSample, fix, openTab('Changes')),
    screen('library', typeSample, fix, saveAndOpenLibrary),
  ],
}
