/**
 * Drives the built React app in a real Chromium, the way a user does.
 *
 * One browser per test file, one fresh context (storage, permissions) per
 * scenario. Helpers here name things the way the interface does — the editor,
 * the Fix button, a tab, a toast — so scenarios read as user actions.
 */

import { chromium } from 'playwright'

let browser = null

export async function launchBrowser() {
  browser = await chromium.launch()
  return browser
}

export async function closeBrowser() {
  await browser?.close()
  browser = null
}

/**
 * Open the app served by `app` (from app.js) in a new context.
 * @param route      `{ pattern, handler }` to intercept a request before the page loads.
 * @param initScript runs before any page script — e.g. seed localStorage.
 */
export async function openApp(app, { viewport = { width: 1360, height: 880 }, permissions = [], route, initScript } = {}) {
  const context = await browser.newContext({ viewport, permissions, acceptDownloads: true })
  if (initScript) await context.addInitScript(initScript)
  if (route) await context.route(route.pattern, route.handler)
  const page = await context.newPage()
  await page.goto(app.base)
  await page.locator('textarea.editor').waitFor()
  // A cloud provider's model list arrives asynchronously and gates the Fix button.
  await page
    .waitForFunction(() => {
      const s = document.querySelector('select[aria-label="Model"]')
      return !s || !!s.value
    }, null, { timeout: 5000 })
    .catch(() => {})
  return { context, page, close: () => context.close() }
}

export const ui = {
  editor: (page) => page.locator('textarea.editor'),
  fixButton: (page) => page.locator('.action-row button.btn.primary'),
  tab: (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }),
  output: (page) => page.locator('pre.output'),
  historyCount: (page) => page.locator('[aria-label="Fix history"] .history-count'),
  prev: (page) => page.getByRole('button', { name: 'Previous fix' }),
  next: (page) => page.getByRole('button', { name: 'Next fix' }),
  drawer: (page) => page.getByRole('dialog', { name: 'Prompt library' }),
  toast: (page, text) => page.locator('.toast', { hasText: text }),
}

/** Type into the editor and wait for the live score under it. */
export async function typePrompt(page, text) {
  await ui.editor(page).fill(text)
  await page.locator('.pane-foot .metastrip', { hasText: 'score' }).waitFor()
}

/** The score shown in the strip under the editor — the live one. */
export async function liveScore(page) {
  const text = await page.locator('.pane-foot .metastrip').innerText()
  const m = text.match(/score\s*(\d+)\s*\/\s*100/)
  return m ? Number(m[1]) : null
}

/** The score on the dial in the results pane. */
export async function dialScore(page) {
  const text = await page.locator('.dial-value').first().innerText()
  return Number(text.match(/\d+/)[0])
}

/** Press Fix prompt and wait until the Fixed tab is showing a result. */
export async function runFix(page) {
  await ui.fixButton(page).click()
  await page.getByRole('tab', { name: /^Fixed/, selected: true }).waitFor()
  await ui.output(page).waitFor()
}

export async function expectToast(page, text, timeout = 4000) {
  await ui.toast(page, text).waitFor({ timeout })
}

/**
 * WCAG contrast of every visible piece of text on the page against the
 * background actually behind it. Runs inside the page; returns the failures.
 */
export async function contrastFailures(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim())
      return [Number(r), Number(g), Number(b), Number(a)]
    }
    const lum = ([r, g, b]) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const blend = (top, bottom) => {
      const a = top[3]
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
    }
    const background = (el) => {
      const layers = []
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n)
        // A gradient or image behind the text cannot be reduced to one colour; leave it to a human.
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
        const c = parse(cs.backgroundColor)
        if (c[3] > 0) {
          layers.push(c)
          if (c[3] >= 0.99) break
        }
      }
      let bg = layers.length && layers[layers.length - 1][3] >= 0.99 ? layers.pop() : [255, 255, 255, 1]
      while (layers.length) bg = blend(layers.pop(), bg)
      return bg
    }
    const decorative = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n)
        if (Number(cs.opacity) < 1 || n.hasAttribute('disabled') || cs.visibility === 'hidden' || cs.display === 'none') return true
        if (n.classList.contains('sr-only')) return true
      }
      return false
    }
    const failures = []
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim())
      if (!own.length || !el.getClientRects().length || decorative(el)) continue
      const cs = getComputedStyle(el)
      const fg = parse(cs.color)
      const bg = background(el)
      if (!bg) continue
      const fgOn = fg[3] < 1 ? blend(fg, bg) : fg
      const l1 = lum(fgOn)
      const l2 = lum(bg)
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      const size = parseFloat(cs.fontSize)
      const bold = Number(cs.fontWeight) >= 700
      const large = size >= 24 || (size >= 18.66 && bold)
      const needed = large ? 3 : 4.5
      if (ratio < needed) {
        failures.push({
          text: own.join(' ').slice(0, 40),
          selector: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}`,
          ratio: Math.round(ratio * 100) / 100,
          needed,
          color: cs.color,
          background: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
        })
      }
    }
    return failures
  })
}

// --- marks on the rewrite ----------------------------------------------------------

/** The marking bar above the rewrite, and the highlights inside it. */
export const marking = {
  keep: (page) => page.getByRole('button', { name: 'Keep it — I loved it', exact: true }),
  change: (page) => page.getByRole('button', { name: "Change it — I didn't like it", exact: true }),
  clear: (page) => page.getByRole('button', { name: 'Clear marks', exact: true }),
  fixAgain: (page) => page.getByRole('button', { name: 'Fix again with my marks', exact: true }),
  count: (page) => page.locator('.feedback-count'),
  // Scoped to the rewrite: a bare .mark is the logo and a bare .change is a row of the Changes tab.
  highlights: (page, kind) => page.locator(kind ? `pre.output mark.${kind}` : 'pre.output mark'),
}

/**
 * Finds `passage` in the text of `within` and returns the viewport points just
 * inside its first and its last character, for a mouse to press and release
 * on; with `select` it also becomes the document's selection. The same words
 * can stand in a text more than once: `occurrence` says which (1 is the first).
 * Throws when the passage is not there, so a scenario cannot pass by selecting
 * nothing.
 */
async function locatePassage(page, passage, { within = 'pre.output', select = false, occurrence = 1 } = {}) {
  const found = await page.evaluate(
    ({ passage, within, select, occurrence }) => {
      const root = document.querySelector(within)
      let at = -1
      for (let n = 0; root && n < occurrence; n++) {
        at = root.textContent.indexOf(passage, at + 1)
        if (at < 0) break
      }
      if (at < 0) return null
      // Highlights split the rewrite into several text nodes, so the offsets are walked.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let seen = 0
      let started = false
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const end = seen + node.data.length
        if (!started && at < end) {
          range.setStart(node, at - seen)
          started = true
        }
        if (started && at + passage.length <= end) {
          range.setEnd(node, at + passage.length - seen)
          break
        }
        seen = end
      }
      if (select) {
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      const rects = [...range.getClientRects()].filter((r) => r.width > 0)
      const first = rects[0]
      const last = rects[rects.length - 1]
      return {
        from: { x: first.left + 1, y: first.top + first.height / 2 },
        to: { x: last.right - 1, y: last.top + last.height / 2 },
      }
    },
    { passage, within, select, occurrence }
  )
  if (!found) throw new Error(`"${passage}" is not in ${within}${occurrence > 1 ? ` ${occurrence} times` : ''}`)
  return found
}

/**
 * Select a passage of the rewrite without a mouse — for setting a scene, where
 * a drag's pixel precision would add nothing. The app hears it the way it hears
 * any selection: through selectionchange.
 */
export async function selectPassage(page, passage, { within = 'pre.output', occurrence = 1 } = {}) {
  await locatePassage(page, passage, { within, occurrence, select: true })
}

/** Double-click a word, the way a user picks one. */
export async function doubleClickWord(page, word, within = 'pre.output') {
  const { from, to } = await locatePassage(page, word, { within })
  await page.mouse.dblclick((from.x + to.x) / 2, from.y)
}

/** Click a word once: the caret lands in it, and whatever holds it takes the focus. */
export async function clickWord(page, word, within = 'pre.output') {
  const { from, to } = await locatePassage(page, word, { within })
  await page.mouse.click((from.x + to.x) / 2, from.y)
}

/**
 * Drag the mouse from the first character of one passage to the last character
 * of another (or of the same one). Each end is a passage of the rewrite,
 * `{ passage, within }` for text elsewhere on the page, or `{ onto: locator }`
 * for the middle of a control. `whileHeld` runs with the button still down, at
 * the end of the drag, for what is only true for the length of a press; the
 * button is the left one unless `button` names another.
 */
export async function dragSelect(page, from, to = from, { whileHeld, button = 'left' } = {}) {
  const point = async (spec, edge) => {
    if (typeof spec === 'string') spec = { passage: spec }
    if (!spec.onto) return (await locatePassage(page, spec.passage, spec))[edge]
    const box = await spec.onto.boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const start = await point(from, 'from')
  const stop = await point(to, 'to')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button })
  try {
    // In steps: a real drag is a stream of moves, and the selection follows them.
    await page.mouse.move(stop.x, stop.y, { steps: 8 })
    if (whileHeld) await whileHeld()
  } finally {
    await page.mouse.up({ button })
  }
}

/**
 * Select from the first character of a passage of the rewrite to a place no
 * mouse can be trusted to stop at, by building the range in the page:
 * `{ endOf: selector }` ends it after the last character of that element, and
 * 'parked' at the very start of whatever follows the rewrite — where a triple
 * click on a block leaves the end of its selection, with nothing more selected.
 * Returns whether the selection's two ends lie inside the rewrite, so a
 * scenario can show that it selected what it says it did.
 */
export async function selectFromRewrite(page, passage, to = 'parked') {
  const { from } = await locatePassage(page, passage, { select: true })
  const ends = await page.evaluate((to) => {
    const pre = document.querySelector('pre.output')
    const selection = window.getSelection()
    const range = selection.getRangeAt(0).cloneRange()
    if (to === 'parked') {
      let last = pre
      while (last && !last.nextSibling) last = last.parentNode
      if (!last) return null
      range.setEnd(last.nextSibling, 0)
    } else {
      const target = document.querySelector(to.endOf)
      if (!target) return null
      range.setEnd(target, target.childNodes.length)
    }
    selection.removeAllRanges()
    selection.addRange(range)
    const live = selection.getRangeAt(0)
    return { startInside: pre.contains(live.startContainer), endInside: pre.contains(live.endContainer) }
  }, to)
  if (!ends) throw new Error(`nothing to end a selection of "${passage}" at: ${JSON.stringify(to)}`)
  return { ...ends, from }
}

/** Select a passage of the rewrite and press one of the two marking buttons. */
export async function markPassage(page, kind, passage, { occurrence = 1 } = {}) {
  await selectPassage(page, passage, { occurrence })
  await marking[kind](page).click()
  await marking.highlights(page, kind).filter({ hasText: passage }).first().waitFor()
}

/** What the document's selection currently holds, as text. */
export const selectedText = (page) => page.evaluate(() => String(window.getSelection()))

/** The highlights on the rewrite, in reading order. */
export const highlights = (page) =>
  marking.highlights(page).evaluateAll((els) => els.map((el) => ({ kind: el.classList.contains('keep') ? 'keep' : 'change', text: el.textContent })))

/** Where the keyboard focus is, as "tag.class": "body" when it has fallen off the control that held it. */
export const focusedElement = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    return el ? [el.tagName.toLowerCase(), ...el.classList].join('.') : null
  })

/**
 * The page once it has caught up with what was just done to it. "Nothing
 * happened" can only be asserted after the moment in which it would have: a
 * selection reaches the marking bar a render later, not at once.
 */
export const settled = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

/** The pane the rewrite scrolls in. */
const resultsPane = (page) => page.locator('.pane-body', { has: page.locator('pre.output') })

/**
 * Scroll a long rewrite until `passage` sits `gap` pixels under the marking
 * bar, which by then has stuck to the top of the pane. Returns how far the bar
 * is from the top of the pane and how far the pane has scrolled.
 */
export async function scrollRewriteUnderBar(page, passage, gap = 150) {
  const pane = resultsPane(page)
  // To the end first: the bar is measured where it sticks, not where it starts.
  await pane.evaluate((el) => (el.scrollTop = el.scrollHeight))
  const bar = await page.locator('.feedback-bar').boundingBox()
  const { from } = await locatePassage(page, passage)
  await pane.evaluate((el, by) => (el.scrollTop += by), from.y - (bar.y + bar.height + gap))
  const stuck = await page.locator('.feedback-bar').boundingBox()
  const box = await pane.boundingBox()
  return { barFromTop: stuck.y - box.y, scrolled: await pane.evaluate((el) => el.scrollTop) }
}
