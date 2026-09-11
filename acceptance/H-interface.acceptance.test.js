/**
 * Group H — The editor and the results interface.
 * Scenarios: acceptance/features/H-interface.feature. Run: npm run test:acceptance
 *
 * Drives the built app (dist/) in Chromium through Playwright against the
 * scripted model. `npm run build` must have run.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { closeBrowser, contrastFailures, dialScore, expectToast, launchBrowser, liveScore, openApp, runFix, typePrompt, ui } from './support/browser.js'
import { BLOG_PROMPT, COMPLAINT, DIVERGENT, FIX_RESPONSE, bloated, leaked, libraryEntry } from './support/fixtures.js'
import { startStub } from './support/stub-provider.js'

let stub
let app
before(async () => {
  stub = await startStub()
  app = await startApp({ stub })
  await launchBrowser()
})
after(async () => {
  await closeBrowser()
  await app.stop()
  await stub.close()
})
beforeEach(async () => {
  stub.reset()
  await app.clearLibrary()
})

const examples = async () => (await app.get('/api/examples')).body.examples

test('H1 — The first thirty seconds', async () => {
  const { page, close } = await openApp(app)
  try {
    assert.match(await ui.editor(page).getAttribute('placeholder'), /Paste the prompt/)
    assert.equal(await page.locator('.example-list .example-row').count(), 8, 'a gallery of examples')
    await page.locator('select[aria-label="Try an example"]').waitFor()

    const [first] = await examples()
    await page.locator('.example-list .example-row').first().click()
    assert.equal(await ui.editor(page).inputValue(), first.prompt)
    assert.equal(await page.locator('#intent').inputValue(), first.intent)
    assert.equal(await page.locator('#strength').inputValue(), first.strength)
    await page.locator('.pane-foot .metastrip', { hasText: 'score' }).waitFor()
    await page.locator('.scorecard').waitFor()
    assert.ok((await page.locator('.pill').count()) > 0, 'issues are listed')
  } finally {
    await close()
  }
})

test('H2 — All eight built-in examples load and lint', async () => {
  const { page, close } = await openApp(app)
  try {
    const targets = await page.locator('#target option').evaluateAll((o) => o.map((x) => x.value))
    await page.locator('#target').selectOption(targets[1])
    await page.getByLabel('Keep my voice').check()
    for (const ex of await examples()) {
      await page.locator('select[aria-label="Try an example"]').selectOption(ex.id)
      assert.equal(await ui.editor(page).inputValue(), ex.prompt, ex.id)
      assert.equal(await page.locator('#intent').inputValue(), ex.intent, ex.id)
      assert.equal(await page.locator('#strength').inputValue(), ex.strength, ex.id)
      assert.equal(await page.locator('#target').inputValue(), targets[1], 'target model left alone')
      assert.equal(await page.getByLabel('Keep my voice').isChecked(), true, 'toggle left alone')
      await page.locator('.pane-foot .metastrip', { hasText: 'score' }).waitFor()
    }
  } finally {
    await close()
  }
})

test('H3 — A broken example list is an empty gallery, not a broken app', async () => {
  const { page, close } = await openApp(app, {
    route: { pattern: '**/api/examples', handler: (r) => r.fulfill({ status: 500, body: 'nope' }) },
  })
  try {
    assert.equal(await page.locator('.example-list').count(), 0)
    assert.equal(await page.locator('select[aria-label="Try an example"]').count(), 0)
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.locator('.pane-foot .metastrip', { hasText: 'score' }).waitFor()
    assert.equal(typeof (await liveScore(page)), 'number', 'everything else works')
  } finally {
    await close()
  }
})

test('H4 — Editing after a fix does the honest thing', async () => {
  const { page, close } = await openApp(app)
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt)

    const edited = `${BLOG_PROMPT} Audience: junior developers.`
    await typePrompt(page, edited)
    // The Fixed tab parks the old result behind an explicit notice rather than showing it as current.
    await page.locator('.empty', { hasText: 'Prompt edited' }).waitFor()
    await page.getByRole('button', { name: 'Show last fix' }).click()
    await page.locator('.banner', { hasText: 'Showing the fix for an earlier version' }).waitFor()

    await ui.tab(page, 'Issues').click()
    const expected = (await app.analyze(edited, { intent: 'general' })).body.analysis.score
    await page.waitForFunction((s) => document.querySelector('.dial-value')?.textContent.includes(String(s)), expected)
    assert.equal(await dialScore(page), expected, 'the Issues tab scores what is in the editor now')
    assert.equal(await liveScore(page), expected)
  } finally {
    await close()
  }
})

test('H5 — A deliberately pinned older result keeps its tab', async () => {
  const { page, close } = await openApp(app)
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    const olderAfter = await dialScore(page) // the Fixed tab dial is the rewrite's score
    await typePrompt(page, COMPLAINT)
    await runFix(page)
    assert.equal(await ui.historyCount(page).innerText(), '2 of 2')

    await ui.prev(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '1 of 2')
    await ui.tab(page, 'Issues').click()
    const older = (await app.analyze(BLOG_PROMPT, { intent: 'general' })).body.analysis.score
    const current = (await app.analyze(COMPLAINT, { intent: 'general' })).body.analysis.score
    assert.notEqual(older, current, 'the fixture prompts must score differently for this to mean anything')
    // A pinned result owns every tab: Issues scores its rewrite against its original…
    assert.equal(await dialScore(page), olderAfter, 'the pinned result owns the Issues tab')
    assert.match(await page.locator('.scorecard').innerText(), new RegExp(`was\\s*${older}`), 'compared to the prompt it was made for')
    // …while the strip under the editor scores what is actually in the editor.
    assert.equal(await liveScore(page), current, 'while the editor has moved on')
  } finally {
    await close()
  }
})

test('H6 — Apply and undo', async () => {
  const { page, close } = await openApp(app)
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expectToast(page, 'Applied to the editor')
    assert.equal(await ui.editor(page).inputValue(), FIX_RESPONSE.fixedPrompt)
    const undo = page.getByRole('button', { name: 'Undo', exact: true })
    await undo.waitFor()
    const applied = (await app.analyze(FIX_RESPONSE.fixedPrompt, { intent: 'general' })).body.analysis.score
    await page.waitForFunction((s) => document.querySelector('.pane-foot .metastrip')?.textContent.includes(`score ${s}`), applied)

    await undo.click()
    await expectToast(page, 'Reverted')
    assert.equal(await ui.editor(page).inputValue(), BLOG_PROMPT)
    assert.equal(await undo.count(), 0, 'Undo is one-shot')

    // Apply parks the result, so a second Apply needs a fresh fix.
    await runFix(page)
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await undo.waitFor()
    await ui.editor(page).press('End')
    await ui.editor(page).type(' x')
    await undo.waitFor({ state: 'detached' })
  } finally {
    await close()
  }
})

test('H7 — Copy puts the rewrite on the clipboard', async () => {
  const { page, close } = await openApp(app, { permissions: ['clipboard-read', 'clipboard-write'] })
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectToast(page, 'Copied')
    // Windows normalises clipboard line endings to CRLF; the words must be identical.
    const clipboard = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
    assert.equal(clipboard, FIX_RESPONSE.fixedPrompt)
  } finally {
    await close()
  }
})

test('H8 — Fix is disabled when it cannot succeed, and says why', async () => {
  const { page, close } = await openApp(app)
  try {
    assert.equal(await ui.fixButton(page).isDisabled(), true, 'empty editor')
    await typePrompt(page, BLOG_PROMPT)
    assert.equal(await ui.fixButton(page).isDisabled(), false)

    await page.locator('select[aria-label="Provider"]').selectOption('anthropic')
    await page.waitForTimeout(300)
    assert.match(await page.locator('.status-dot').getAttribute('title'), /no API key/, 'the reason is visible')
    assert.equal(await ui.fixButton(page).isDisabled(), true, 'a provider with no key cannot fix')

    await page.locator('select[aria-label="Provider"]').selectOption('local')
    await page.locator('.banner', { hasText: 'Download the local model' }).waitFor()
    assert.equal(await ui.fixButton(page).isDisabled(), true, 'a missing local model cannot fix')
    // "download in progress" and "cancel settling" need a model file: nightly.
  } finally {
    await close()
  }
})

test('H9 — A remembered model choice is reconciled with the server', async () => {
  const before = (await app.get('/api/local/status')).body.tier
  assert.notEqual(before, 'quality')
  const { page, close } = await openApp(app, {
    initScript: () => localStorage.setItem('promptfixer.prefs.v1', JSON.stringify({ provider: 'local', model: 'quality', options: {} })),
  })
  try {
    await page.locator('select[aria-label="Local model tier"]').waitFor()
    const started = Date.now()
    let tier = before
    while (tier !== 'quality' && Date.now() - started < 4000) {
      await page.waitForTimeout(100)
      tier = (await app.get('/api/local/status')).body.tier
    }
    assert.equal(tier, 'quality', 'the remembered tier was pushed to the server')
    assert.equal(await page.locator('select[aria-label="Local model tier"]').inputValue(), 'quality')
  } finally {
    await app.post('/api/local/select', { tier: before })
    await close()
  }
})

test('H10 — Warnings read like sentences a person wrote', async () => {
  const cases = [
    { name: 'retention', replies: [{ json: DIVERGENT }, { json: DIVERGENT }], headline: /Rewrote more than the strength allows/ },
    { name: 'growth', replies: [bloated, bloated], headline: /Added more than the strength allows/ },
    { name: 'leak', replies: [leaked, leaked], headline: /instructions/i },
  ]
  for (const c of cases) {
    const { page, close } = await openApp(app)
    try {
      stub.reset()
      stub.queue(...c.replies)
      await page.locator('#strength').selectOption('light')
      await typePrompt(page, COMPLAINT)
      await runFix(page)
      const banner = page.locator('.banner.warn').first()
      assert.match(await banner.locator('strong').innerText(), c.headline, c.name)
    } finally {
      await close()
    }
  }

  // An unknown kind still shows the raw explanation under a sensible headline.
  const { page, close } = await openApp(app, {
    route: {
      pattern: '**/api/fix',
      handler: async (r) => {
        const res = await r.fetch()
        const json = await res.json()
        json.meta.warningKind = 'something-new'
        json.meta.warning = 'Raw explanation text from a newer server.'
        await r.fulfill({ response: res, json })
      },
    },
  })
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    const banner = page.locator('.banner.warn').first()
    assert.ok((await banner.locator('strong').innerText()).length > 0, 'a headline, never blank')
    assert.match(await banner.innerText(), /Raw explanation text/)
  } finally {
    await close()
  }
})

test('H11 — The app is usable from the keyboard', async () => {
  await app.post('/api/library', libraryEntry({ original: 'keyboard entry original' }))
  const { page, close } = await openApp(app)
  try {
    // Tab reaches the controls, in reading order, and never lands on something hidden.
    const seen = []
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab')
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement
          const r = el.getBoundingClientRect()
          return { tag: el.tagName, label: el.getAttribute('aria-label') || el.id || el.textContent.trim().slice(0, 20), visible: r.width > 0 && r.height > 0 }
        })
      )
    }
    assert.ok(seen.every((s) => s.visible), `every focus stop is visible: ${JSON.stringify(seen)}`)
    const labels = seen.map((s) => s.label)
    assert.ok(labels.includes('Provider') && labels.includes('Library'), `top bar first: ${labels}`)

    // Ctrl+Enter runs a fix from the editor.
    await ui.editor(page).fill(BLOG_PROMPT)
    await page.locator('.pane-foot .metastrip', { hasText: 'score' }).waitFor()
    await ui.editor(page).press('Control+Enter')
    await page.getByRole('tab', { name: /^Fixed/, selected: true }).waitFor()

    // Enter on the nested Delete deletes; it does not open the entry.
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await ui.drawer(page).waitFor()
    await page.locator('.lib-entry').first().waitFor()
    await page.locator('button[aria-label^="Delete "]').first().focus()
    await page.keyboard.press('Enter')
    await page.locator('.lib-entry').first().waitFor({ state: 'detached' })
    assert.equal(await ui.drawer(page).count(), 1, 'the drawer stays open')
    assert.equal(await ui.editor(page).inputValue(), BLOG_PROMPT, 'the entry was not loaded into the editor')
    assert.equal(await ui.toast(page, 'Loaded from library').count(), 0)

    await page.keyboard.press('Escape')
    await ui.drawer(page).waitFor({ state: 'detached' })
  } finally {
    await close()
  }
})

test('H12 — Text meets contrast requirements', async () => {
  const { page, close } = await openApp(app)
  try {
    const failures = []
    await typePrompt(page, BLOG_PROMPT)
    failures.push(...(await contrastFailures(page)).map((f) => ({ ...f, screen: 'issues' })))
    await runFix(page)
    failures.push(...(await contrastFailures(page)).map((f) => ({ ...f, screen: 'fixed' })))
    await ui.tab(page, 'Changes').click()
    failures.push(...(await contrastFailures(page)).map((f) => ({ ...f, screen: 'changes' })))
    await ui.tab(page, 'Diff').click()
    failures.push(...(await contrastFailures(page)).map((f) => ({ ...f, screen: 'diff' })))
    assert.deepEqual(failures, [], `text below AA contrast:\n${JSON.stringify(failures, null, 2)}`)
  } finally {
    await close()
  }
})

test('H13 — The window works at a small size', async () => {
  const { page, close } = await openApp(app, { viewport: { width: 1024, height: 720 } })
  try {
    const check = async (when) => {
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement
        const panes = [...document.querySelectorAll('.pane, .pane-body')].filter((p) => p.scrollWidth > p.clientWidth + 1).length
        return { page: doc.scrollWidth > doc.clientWidth, panes }
      })
      assert.equal(overflow.page, false, `${when}: the page scrolls horizontally`)
      assert.equal(overflow.panes, 0, `${when}: a pane scrolls horizontally`)
      for (const name of ['Library', 'Fix prompt']) {
        const box = await page.getByRole('button', { name: new RegExp(`^${name}`) }).boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 720, `${when}: ${name} is on screen`)
      }
    }
    await check('empty')
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    await check('after a fix')
  } finally {
    await close()
  }
})

test('H14 — Every action without a visible result reports itself', async () => {
  const { page, close } = await openApp(app, { permissions: ['clipboard-read', 'clipboard-write'] })
  try {
    await typePrompt(page, BLOG_PROMPT)
    await runFix(page)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expectToast(page, 'Saved to library')
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectToast(page, 'Copied')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expectToast(page, 'Applied to the editor')

    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await ui.drawer(page).waitFor()
    await page.getByRole('button', { name: 'Export' }).click()
    await expectToast(page, /Exported 1 prompt/)

    const file = { entries: [{ id: 'imported-1', original: 'an imported prompt', fixed: 'An imported prompt.' }] }
    await page.locator('input[aria-label="Import library file"]').setInputFiles({
      name: 'library.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    })
    await expectToast(page, /Imported 1 prompt/)
  } finally {
    await close()
  }
})
