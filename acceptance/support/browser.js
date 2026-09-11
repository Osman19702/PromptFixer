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
