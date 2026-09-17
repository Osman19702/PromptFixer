/**
 * Group M — Marking a rewrite and fixing it again.
 * Scenarios: acceptance/features/M-feedback.feature. Run: npm run test:acceptance
 *
 * The API scenarios send marks the way the interface does: the original prompt
 * plus the marked rewrite. The browser scenarios drive the built app (dist/) in
 * Chromium against the scripted model. `npm run build` must have run.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import {
  clickWord,
  closeBrowser,
  contrastFailures,
  doubleClickWord,
  dragSelect,
  expectToast,
  focusedElement,
  highlights,
  launchBrowser,
  marking,
  markPassage,
  openApp,
  runFix,
  scrollRewriteUnderBar,
  selectedText,
  selectFromRewrite,
  selectPassage,
  settled,
  typePrompt,
  ui,
} from './support/browser.js'
import {
  BLOG_PROMPT,
  DISLIKED,
  FIX_RESPONSE,
  LONG_PROMPT,
  LONG_REWRITE,
  LOVED,
  REWORDED,
  SLOT,
  SLOT_REWRITE,
  TWICE,
  TWICE_REWORDED,
  TWICE_REWRITE,
  honoursMarks,
  ignoresMarks,
} from './support/fixtures.js'
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
  // A saved rewrite would be shown to the model as an example and blur what the marks did.
  await app.clearLibrary()
})

const balanced = { intent: 'writing', strength: 'balanced' }

/** The first fix: the rewrite the user then reads and marks. */
const firstRewrite = async () => (await app.fix(BLOG_PROMPT, balanced)).body.fixedPrompt

/** Fix again the way the interface does: still the original prompt, plus the marks on the earlier rewrite. */
const fixAgain = (feedback) => app.fix(BLOG_PROMPT, balanced, { feedback })

/** The Fixed tab showing the rewrite of a prompt: the blog prompt and its default rewrite, unless the scenario scripted others. */
async function fixedScreen(options, prompt = BLOG_PROMPT) {
  const opened = await openApp(app, options)
  await typePrompt(opened.page, prompt)
  await runFix(opened.page)
  return opened
}

// A selection reaches the bar a render after it is made, so both of these look once the page has caught up.
const bothDisabled = async (page) => {
  await settled(page)
  return (await marking.keep(page).isDisabled()) && (await marking.change(page).isDisabled())
}
const bothEnabled = async (page) => {
  await settled(page)
  return (await marking.keep(page).isEnabled()) && (await marking.change(page).isEnabled())
}

/** Wait for the history to read "2 of 2": a result has arrived, whatever toasts are still up from the one before. */
const historyShows = (page, count) => ui.historyCount(page).filter({ hasText: count }).waitFor({ timeout: 5000 })

/** A scripted reply: the default one, with another rewrite in it. */
const asRewrite = (fixedPrompt) => ({ json: { ...FIX_RESPONSE, fixedPrompt } })
/** TWICE_REWRITE once a model has reworded TWICE where it stood on its own and left the loved sentence alone. */
const TWICE_HONOURED = TWICE_REWRITE.replace(`try the ${TWICE}`, `try the ${TWICE_REWORDED}`)
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('M1 — The model is shown what I marked, and the result says how many marks it was given', async () => {
  const previous = await firstRewrite()
  const firstTime = stub.last()

  stub.queue(honoursMarks)
  const { status, body } = await fixAgain({ previous, keep: [LOVED], change: [DISLIKED] })
  assert.equal(status, 200)

  const shown = stub.last()
  assert.deepEqual(shown.feedback, { previous, keep: [LOVED], change: [DISLIKED] }, 'the marked rewrite and each passage under its own verdict')
  assert.equal(shown.original, BLOG_PROMPT, 'the prompt to fix is still what the user wrote')
  assert.deepEqual(shown.findings, firstTime.findings, 'with the findings the user was shown')

  assert.equal(body.fixedPrompt, previous.replace(DISLIKED, REWORDED))
  assert.ok(body.fixedPrompt.includes(LOVED), 'the kept passage is there word for word')
  assert.ok(!body.fixedPrompt.includes(DISLIKED), 'the disliked passage is not there as it was')
  assert.deepEqual(body.meta.feedback, { keep: 1, change: 1, missingKeep: [], unchangedChange: [] })
  assert.equal(body.meta.warning, undefined, `unexpected warning: ${body.meta.warning}`)
  assert.equal(body.meta.attempts, 1)

  // Before and after are still about the user's own prompt, not about the rewrite they marked.
  assert.equal(body.original, BLOG_PROMPT)
  assert.deepEqual(body.before, (await app.analyze(BLOG_PROMPT, balanced)).body.analysis)

  // Marks are made on places and travel as text. Two words of the sentence the user loved stand once
  // more further down, and there they are disliked: two marks, and neither may cost the other.
  stub.queue(asRewrite(TWICE_REWRITE))
  const twice = await firstRewrite()
  assert.equal(twice, TWICE_REWRITE)
  stub.queue(honoursMarks)
  const both = await fixAgain({ previous: twice, keep: [LOVED], change: [TWICE] })
  assert.equal(both.status, 200)
  assert.deepEqual(stub.last().feedback, { previous: twice, keep: [LOVED], change: [TWICE] }, 'the model is shown both marks')
  assert.match(stub.last().user, /Where the words of a <change> passage also stand inside a <keep> passage, the <keep> passage wins/, 'and told which wins where')
  assert.equal(both.body.fixedPrompt, TWICE_HONOURED, 'reworded where they stood on their own')
  assert.ok(both.body.fixedPrompt.includes(LOVED), 'and left alone inside the kept sentence')
  assert.deepEqual(both.body.meta.feedback, { keep: 1, change: 1, missingKeep: [], unchangedChange: [] })
  assert.equal(both.body.meta.warning, undefined, `unexpected warning: ${both.body.meta.warning}`)
  assert.equal(both.body.meta.attempts, 1, 'the words still standing inside the kept sentence are no reason to retry')
})

test('M2 — A rewrite that drops a passage I kept is retried, and the faithful attempt is kept', async () => {
  const previous = await firstRewrite()
  stub.queue(ignoresMarks, honoursMarks)
  const { status, body } = await fixAgain({ previous, keep: [LOVED], change: [DISLIKED] })
  assert.equal(status, 200)
  assert.equal(body.fixedPrompt, previous.replace(DISLIKED, REWORDED), 'the attempt that followed the marks')
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warning, undefined, 'a successful retry is not a warning')
  assert.deepEqual(body.meta.feedback, { keep: 1, change: 1, missingKeep: [], unchangedChange: [] })

  const [, attempt, retry] = stub.requests
  assert.equal(retry.isRetry, true)
  // Each passage under its own verdict, inside one reason. The reasons are joined with "; ", and the
  // closing "copy every <keep> passage" would satisfy a bare /keep/ whatever the reasons said.
  const told = (verdict, passage) => new RegExp(`${verdict}[^;]*"${escaped(passage)}"`)
  assert.match(retry.rejectedReasons, told('marked to keep', LOVED), 'the retry was told which passage it dropped')
  assert.match(retry.rejectedReasons, told('marked for change', DISLIKED), 'and which it left as it was')
  assert.doesNotMatch(retry.rejectedReasons, told('marked to keep', DISLIKED), 'each under its own verdict, not the other one')
  assert.deepEqual(retry.feedback, attempt.feedback, 'and was shown the marks again')
  assert.equal(retry.original, BLOG_PROMPT)
})

test('M3 — When the model ignores my marks twice, I still get a result and I am told what was not honoured', async () => {
  const previous = await firstRewrite()
  stub.queue(ignoresMarks, ignoresMarks)
  const { status, body } = await fixAgain({ previous, keep: [LOVED], change: [DISLIKED] })
  assert.equal(status, 200)
  assert.ok(body.fixedPrompt.trim().length > 0, 'the user still gets a result')
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warningKind, 'feedback', `got ${body.meta.warningKind}: ${body.meta.warning}`)
  assert.match(body.meta.warning, /1 kept passage is missing/)
  assert.match(body.meta.warning, /1 passage to change is still there/)
  assert.deepEqual(body.meta.feedback, { keep: 1, change: 1, missingKeep: [LOVED], unchangedChange: [DISLIKED] })

  // The same journey on screen: the warning has a headline, and the note does not take credit.
  const { page, close } = await fixedScreen()
  try {
    await markPassage(page, 'keep', LOVED)
    await markPassage(page, 'change', DISLIKED)
    stub.queue(ignoresMarks, ignoresMarks)
    await marking.fixAgain(page).click()
    await expectToast(page, 'Refined in')
    const banner = page.locator('.banner.warn').first()
    assert.equal(await banner.locator('strong').innerText(), 'Did not follow all of your marks')
    assert.match(await banner.innerText(), /1 kept passage is missing and 1 passage to change is still there/)
    assert.match(await page.locator('.banner.info').innerText(), /refined with your marks \(0 kept, 0 changed\)/)
  } finally {
    await close()
  }
})

test('M4 — Nonsense marks are coerced, never a server error', async () => {
  const previous = await firstRewrite()
  const ordinary = async (feedback, why) => {
    const { status, body } = await fixAgain(feedback)
    assert.equal(status, 200, `${why}: marks=${JSON.stringify(feedback)} gave ${status}`)
    assert.equal(stub.last().feedback, null, `${why}: the model was shown marks`)
    assert.equal(body.meta.feedback, undefined, `${why}: the result mentions marks`)
    assert.equal(body.fixedPrompt, FIX_RESPONSE.fixedPrompt)
  }

  const nonsense = ['x', 42, true, null, [], [LOVED], {}, { previous: 42, keep: [LOVED] }, { previous: '   ', keep: [LOVED] }]
  nonsense.push({ previous, keep: 'x', change: 7 }, { previous, keep: [1, null, {}, [LOVED]], change: { 0: DISLIKED } })
  for (const feedback of nonsense) await ordinary(feedback, 'nonsense')

  // A mark has to point at something in the rewrite it was made on.
  await ordinary({ previous, keep: ['words that are nowhere in the rewrite'], change: ['nor are these'] }, 'marks that point at nothing')

  stub.queue(honoursMarks)
  const tidied = await fixAgain({ previous, keep: [`  ${LOVED}\n`, LOVED, 'words that are nowhere in the rewrite', 7], change: [null] })
  assert.equal(tidied.status, 200)
  assert.deepEqual(stub.last().feedback, { previous, keep: [LOVED], change: [] }, 'once, trimmed, and nothing else')
  assert.equal(tidied.body.meta.feedback.keep, 1)

  // A keep that can only be the very place a change points at loses to it: the same words where they
  // stand once (LOVED), and words that stand nowhere but inside the passage to change ("blog post").
  stub.queue(honoursMarks)
  const torn = await fixAgain({ previous, keep: [LOVED, 'blog post', 'At most 600 words'], change: [LOVED] })
  assert.equal(torn.status, 200)
  assert.deepEqual(stub.last().feedback, { previous, keep: ['At most 600 words'], change: [LOVED] }, 'the change wins')
  assert.deepEqual(torn.body.meta.feedback, { keep: 1, change: 1, missingKeep: [], unchangedChange: [] })

  // The same words standing in two places are two places to mark: kept in one, to change in the other.
  stub.queue(honoursMarks)
  const twoPlaces = await fixAgain({ previous: TWICE_REWRITE, keep: [TWICE], change: [TWICE] })
  assert.equal(twoPlaces.status, 200)
  assert.deepEqual(stub.last().feedback, { previous: TWICE_REWRITE, keep: [TWICE], change: [TWICE] }, 'both marks reach the model')
  assert.deepEqual(twoPlaces.body.meta.feedback, { keep: 1, change: 1, missingKeep: [], unchangedChange: [] }, 'one place reworded, one left: both honoured')
  assert.equal(twoPlaces.body.meta.attempts, 1)

  // The limits the README states: twenty passages of each kind, two thousand characters a passage.
  const many = Array.from({ length: 25 }, (_, i) => previous.slice(i * 8, i * 8 + 24).trim())
  assert.equal(new Set(many).size, 25, 'twenty-five different passages of the rewrite')
  stub.queue(honoursMarks)
  const manyKept = await fixAgain({ previous, keep: many })
  assert.equal(manyKept.status, 200)
  assert.deepEqual(stub.last().feedback.keep, many.slice(0, 20), 'the first twenty, in the order they were marked')
  assert.equal(manyKept.body.meta.feedback.keep, 20, 'and the result says twenty, not twenty-five')
  const manyChanged = await fixAgain({ previous, change: many })
  assert.equal(manyChanged.status, 200)
  assert.deepEqual(stub.last().feedback.change, many.slice(0, 20))
  assert.equal(manyChanged.body.meta.feedback.change, 20)

  const longRewrite = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ')
  const longMark = await fixAgain({ previous: longRewrite, keep: [longRewrite.slice(0, 2500)] })
  assert.equal(longMark.status, 200, 'a very long mark is cut, not refused')
  const [cut] = stub.last().feedback.keep
  assert.ok(cut.length <= 2000 && cut.length > 1990, `a passage of ${cut.length} characters reached the model`)
  assert.ok(longRewrite.startsWith(cut), 'and it is the head of what was marked')

  const calls = stub.requests.length
  const tooLong = await fixAgain({ previous: 'x'.repeat(60001), keep: ['x'] })
  assert.equal(tooLong.status, 413)
  assert.match(tooLong.body.error, /60001/)
  assert.match(tooLong.body.error, /60000/)
  assert.equal(stub.requests.length, calls, 'refused before any model was contacted')
})

test('M5 — A fix without marks is the fix it always was', async () => {
  const plain = await app.fix(BLOG_PROMPT, balanced)
  const asked = stub.last()
  assert.equal(plain.status, 200)
  assert.equal(asked.feedback, null, 'no earlier rewrite and no marks are shown')
  assert.equal(plain.body.meta.feedback, undefined, 'and the result says nothing about marks')
  assert.equal(plain.body.meta.warning, undefined)

  stub.queue(honoursMarks)
  const refined = await fixAgain({ previous: plain.body.fixedPrompt, keep: [LOVED], change: [DISLIKED] })
  assert.notEqual(refined.body.fixedPrompt, plain.body.fixedPrompt, 'the marks did change the rewrite in between')

  const again = await app.fix(BLOG_PROMPT, balanced)
  assert.equal(stub.last().user, asked.user, 'the model is asked exactly what it was asked the first time')
  assert.equal(again.body.fixedPrompt, plain.body.fixedPrompt)
  assert.deepEqual(again.body.after, plain.body.after)
  assert.equal(again.body.meta.feedback, undefined)

  // The tags a fix-again wraps the marks in mean nothing on a fix that had none: a rewrite may hold
  // a <user_feedback> slot of its own, and that is the prompt, not our instructions pasted back.
  const calls = stub.requests.length
  stub.queue(asRewrite(SLOT_REWRITE))
  const slotted = await app.fix(BLOG_PROMPT, balanced)
  assert.equal(slotted.status, 200)
  assert.equal(slotted.body.fixedPrompt, SLOT_REWRITE, 'the slot comes back intact')
  assert.equal(slotted.body.meta.attempts, 1, 'and was no reason to ask the model again')
  assert.equal(slotted.body.meta.warning, undefined, `unexpected warning: ${slotted.body.meta.warning}`)
  assert.equal(stub.requests.length, calls + 1)

  // Nor does marking that rewrite turn its slot into a leak: it is in the text the model is told to start from.
  stub.queue(honoursMarks)
  const slotKept = await fixAgain({ previous: SLOT_REWRITE, keep: [SLOT], change: [DISLIKED] })
  assert.equal(slotKept.body.fixedPrompt, SLOT_REWRITE.replace(DISLIKED, REWORDED))
  assert.equal(slotKept.body.meta.attempts, 1)
  assert.equal(slotKept.body.meta.warning, undefined, `unexpected warning: ${slotKept.body.meta.warning}`)
})

test('M6 — I mark what I loved and what I did not', async () => {
  const { page, close } = await fixedScreen()
  try {
    assert.equal(await bothDisabled(page), true, 'nothing is selected yet')

    // A selection elsewhere on the page is not a selection of the rewrite…
    await doubleClickWord(page, 'labelled', '.banner.info')
    assert.match(await selectedText(page), /labelled/, 'the summary word is selected')
    assert.equal(await bothDisabled(page), true, 'a selection outside the rewrite')
    // …and neither is one that only ends in it. (Pressing on the word just selected would drag that word, not select.)
    await dragSelect(page, { passage: 'bounded the length', within: '.banner.info' }, 'senior content')
    const dragged = await selectedText(page)
    assert.ok(dragged.includes('bounded the length') && dragged.includes('senior content'), `the drag selected: ${dragged}`)
    assert.equal(await bothDisabled(page), true, 'a selection that starts outside the rewrite')
    // Nor one that starts in it and runs on into other text. A toast is the text that follows the
    // rewrite on this page; the range is built in the page, where a mouse would have to race the toast.
    await selectPassage(page, 'senior content')
    assert.equal(await bothEnabled(page), true, 'these words of the rewrite can be marked')
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await ui.toast(page, /Copied|Clipboard/).waitFor()
    const ranOn = await selectFromRewrite(page, 'senior content', { endOf: '[data-testid="toasts"]' })
    assert.deepEqual([ranOn.startInside, ranOn.endInside], [true, false])
    assert.match(await selectedText(page), /sections\.[\s\S]*(Copied|Clipboard)/, 'the selection runs from the rewrite into the toast')
    assert.equal(await bothDisabled(page), true, 'a selection that ends outside the rewrite')
    // A triple click parks the end of its selection at the start of whatever follows the block it
    // selected. That is outside the rewrite, and selects nothing outside it: it can be marked.
    const LAST_LINE = 'Markdown, with an H1 title and three H2 sections.'
    const parked = await selectFromRewrite(page, LAST_LINE, 'parked')
    assert.deepEqual([parked.startInside, parked.endInside], [true, false], 'the selection ends outside the rewrite')
    assert.equal((await selectedText(page)).trim(), LAST_LINE, 'with nothing but the rewrite in it')
    assert.equal(await bothEnabled(page), true, 'an end parked just outside the rewrite')
    await marking.change(page).click()
    assert.deepEqual(await highlights(page), [{ kind: 'change', text: LAST_LINE }])
    await marking.clear(page).click()

    // A double-click drags the trailing space along on some platforms; the mark is the word.
    await doubleClickWord(page, 'announcing')
    await marking.keep(page).click()
    assert.deepEqual(await highlights(page), [{ kind: 'keep', text: 'announcing' }])
    assert.equal(await selectedText(page), '', 'the selection is gone once it has become a mark')
    assert.equal(await bothDisabled(page), true)

    await dragSelect(page, DISLIKED)
    assert.equal(await selectedText(page), DISLIKED, 'pressing the button must not have to guess what was selected')
    await marking.change(page).click()
    assert.deepEqual(await highlights(page), [
      { kind: 'change', text: DISLIKED },
      { kind: 'keep', text: 'announcing' },
    ])

    const paint = (kind) => marking.highlights(page, kind).evaluate((el) => getComputedStyle(el).backgroundColor)
    const plain = await ui.output(page).evaluate((el) => getComputedStyle(el).backgroundColor)
    assert.notEqual(await paint('keep'), plain, 'a kept passage is visibly highlighted')
    assert.notEqual(await paint('change'), plain, 'and so is one to change')
    assert.notEqual(await paint('keep'), await paint('change'), 'and the two verdicts look different')

    assert.equal(await marking.count(page).innerText(), '1 kept · 1 to change')
    assert.equal(await marking.fixAgain(page).isEnabled(), true)
  } finally {
    await close()
  }

  // A rewrite longer than the window scrolls under the marking bar, which stays where it is.
  stub.byDefault(asRewrite(LONG_REWRITE))
  const long = await fixedScreen(undefined, LONG_PROMPT)
  try {
    const { page } = long
    const bar = page.locator('.feedback-bar')
    const barYields = () => bar.evaluate((el) => getComputedStyle(el).pointerEvents === 'none')
    const selection = () =>
      page.evaluate(() => {
        const pre = document.querySelector('pre.output')
        const chosen = window.getSelection()
        const range = chosen.rangeCount ? chosen.getRangeAt(0) : null
        return { text: String(chosen), inside: !!range && pre.contains(range.startContainer) && pre.contains(range.endContainer) }
      })

    const { barFromTop, scrolled } = await scrollRewriteUnderBar(page, 'Line 60: describe')
    assert.ok(scrolled > 500 && barFromTop >= 0 && barFromTop < 40, `the bar is stuck above a scrolled rewrite: ${JSON.stringify({ barFromTop, scrolled })}`)

    // Dragging a selection upwards runs the mouse onto the bar. The text under the bar is what gets
    // selected, not the bar's labels and everything between them and the rewrite.
    let yielded
    await dragSelect(page, 'Line 60: describe', { onto: marking.keep(page) }, { whileHeld: async () => (yielded = await barYields()) })
    const dragged = await selection()
    assert.ok(dragged.inside, `the selection is wholly inside the rewrite: ${JSON.stringify(dragged.text.slice(0, 80))}`)
    assert.ok(dragged.text.trim().length > 0 && dragged.text.length < LONG_REWRITE.length / 2, `some lines, not the page: ${dragged.text.length} characters`)
    assert.ok(LONG_REWRITE.includes(dragged.text.trim()), 'and nothing of the bar is in it')
    assert.equal(await bothEnabled(page), true, 'so it can be marked')
    assert.equal(yielded, true, 'for the length of the press the bar let the mouse through')
    assert.equal(await barYields(), false, 'and it takes the mouse again once the press is over')
    await marking.keep(page).click()
    assert.deepEqual(await highlights(page), [{ kind: 'keep', text: dragged.text.trim() }])

    // The same drag starting on a highlight, which has a press handler of its own.
    await markPassage(page, 'change', 'Line 62: describe')
    await dragSelect(page, 'Line 62: describe', { onto: marking.change(page) }, { whileHeld: async () => (yielded = await barYields()) })
    assert.ok((await selection()).inside && (await selection()).text.trim().length > 0, 'a drag from a highlight stays inside the rewrite too')
    assert.equal(yielded, true)
    assert.equal((await highlights(page)).length, 2, 'and leaves the highlight it started on')
    assert.equal(await bothEnabled(page), true)

    // Not every press ends in a mouseup: a window that loses the focus never hears of the release.
    let restored
    const losesFocus = async () => {
      yielded = await barYields()
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      restored = !(await barYields())
    }
    await dragSelect(page, 'Line 64: describe', 'Line 64: describe', { whileHeld: losesFocus })
    assert.deepEqual([yielded, restored], [true, true], 'a press that never reports its end must not leave the bar dead')
    // And the other mouse buttons open menus: they drag no selection, and the bar stays as it is.
    await dragSelect(page, 'Line 64: describe', 'Line 64: describe', { button: 'right', whileHeld: async () => (yielded = await barYields()) })
    assert.equal(yielded, false)
    assert.equal(await ui.output(page).evaluate((el) => el.textContent), LONG_REWRITE)

    // The server reads twenty passages of a kind (M4). The bar stops there too, and says so, rather
    // than count a twenty-first that no model would ever be shown.
    await marking.clear(page).click()
    for (let line = 1; line <= 20; line++) await markPassage(page, 'keep', `Line ${line}: describe`)
    assert.equal(await marking.count(page).innerText(), '20 kept · 0 to change')
    await selectPassage(page, 'Line 30: describe')
    await settled(page)
    assert.equal(await marking.keep(page).isDisabled(), true, 'a twenty-first kept passage')
    assert.equal(await marking.keep(page).getAttribute('title'), '20 passages kept is the most the model is shown. Remove one to mark another.')
    assert.equal(await marking.change(page).isEnabled(), true, 'the other verdict has room')
    assert.equal(await marking.change(page).getAttribute('title'), null)
    // Drawing one of the twenty again, wider, adds no passage: the bar refuses only what the press would drop.
    await selectPassage(page, 'Line 5: describe requirement')
    await settled(page)
    assert.equal(await marking.keep(page).isEnabled(), true, 'a kept passage drawn again')
    assert.equal(await marking.keep(page).getAttribute('title'), null)
    await marking.keep(page).click()
    assert.equal(await marking.count(page).innerText(), '20 kept · 0 to change')
    assert.equal((await highlights(page))[4].text, 'Line 5: describe requirement')
    await settled(page)
    assert.equal(await marking.keep(page).isDisabled(), true, 'nothing is selected now')
    assert.match(await marking.keep(page).getAttribute('title'), /^20 passages kept is the most/, 'and the full kind still says why')
    // Remove one to mark another. The passage is already selected when the highlight goes: that
    // selection collapses without the browser announcing it, and the bar must not go on offering
    // a verdict on nothing.
    await selectPassage(page, 'Line 30: describe')
    await settled(page)
    await marking.highlights(page).first().focus()
    await page.keyboard.press('Enter')
    assert.equal(await marking.count(page).innerText(), '19 kept · 0 to change')
    await settled(page)
    assert.equal(await page.evaluate(() => String(window.getSelection())), '', 'the removal took the selection with it')
    assert.equal(await marking.keep(page).isDisabled(), true, 'nothing is selected, so nothing can be kept')
    assert.equal(await marking.change(page).isDisabled(), true, 'or changed')
    await selectPassage(page, 'Line 30: describe')
    await settled(page)
    assert.equal(await marking.keep(page).isEnabled(), true)
    assert.equal(await marking.keep(page).getAttribute('title'), null)
    await marking.keep(page).click()
    assert.equal(await marking.count(page).innerText(), '20 kept · 0 to change')
  } finally {
    await long.close()
  }
})

test('M7 — A mark can be changed and taken back', async () => {
  const { page, close } = await fixedScreen()
  try {
    await markPassage(page, 'keep', LOVED)
    await markPassage(page, 'keep', 'At most 600 words')
    await markPassage(page, 'change', DISLIKED)
    assert.equal(await marking.count(page).innerText(), '2 kept · 1 to change')

    // A real drag, starting on the first character of the highlight: the newest decision wins.
    await dragSelect(page, LOVED)
    await marking.change(page).click()
    assert.deepEqual(await highlights(page), [
      { kind: 'change', text: DISLIKED },
      { kind: 'change', text: LOVED },
      { kind: 'keep', text: 'At most 600 words' },
    ])
    assert.equal(await marking.count(page).innerText(), '1 kept · 2 to change')

    // A highlight with text before it on its line is where Chromium loses such a drag, and the
    // release then counts as a click: the passage has to end up selected, and still highlighted.
    await dragSelect(page, 'At most 600 words')
    assert.equal(await selectedText(page), 'At most 600 words', 'dragging across a highlight selects it')
    assert.equal((await highlights(page)).length, 3, 'and does not remove it')
    await marking.keep(page).click()
    assert.equal(await marking.count(page).innerText(), '1 kept · 2 to change', 'the same verdict again changes nothing')

    await marking.highlights(page).filter({ hasText: DISLIKED }).click()
    assert.deepEqual(await highlights(page), [
      { kind: 'change', text: LOVED },
      { kind: 'keep', text: 'At most 600 words' },
    ])
    assert.equal(await marking.count(page).innerText(), '1 kept · 1 to change')

    // From the keyboard: the highlights follow the bar in the tab order. The last one is
    // removed, so the element that held the focus is gone and focus has to be handed on.
    await marking.fixAgain(page).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    assert.deepEqual(await highlights(page), [{ kind: 'change', text: LOVED }])
    assert.equal(await page.evaluate(() => document.activeElement.textContent), LOVED, 'focus moves to the highlight that is left, not to the top of the page')

    // Ctrl+Enter is "Fix prompt" from anywhere, and a fresh fix throws the marks away. While there
    // is a mark to lose, the rewrite and its bar keep the key to themselves.
    await clickWord(page, 'Audience')
    assert.equal(await focusedElement(page), 'pre.output')
    await page.keyboard.press('Control+Enter')
    await marking.fixAgain(page).focus()
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(500)
    assert.equal(stub.requests.length, 1, 'no model was asked anything')
    assert.deepEqual(await highlights(page), [{ kind: 'change', text: LOVED }], 'and the mark is still there')

    // Clear marks, from the keyboard: the button goes away with the marks, and must not take the focus with it.
    await marking.clear(page).focus()
    await page.keyboard.press('Enter')
    assert.deepEqual(await highlights(page), [])
    assert.equal(await marking.count(page).count(), 0)
    assert.equal(await marking.fixAgain(page).count(), 0, 'nothing marked, nothing to fix again with')
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt)
    assert.equal(await focusedElement(page), 'pre.output', 'focus is handed to the rewrite, not dropped to the top of the page')
    assert.equal(await ui.output(page).evaluate((el) => getComputedStyle(el).outlineStyle), 'none', 'which shows no ring for it')

    // With no mark left to lose, the key is the shortcut it is everywhere else — from the rewrite too.
    await clickWord(page, 'Audience')
    await page.keyboard.press('Control+Enter')
    await historyShows(page, '2 of 2')
    assert.equal(stub.requests.length, 2, 'a fresh fix')
  } finally {
    await close()
  }
})

test('M8 — "Fix again with my marks" sends exactly what I marked', async () => {
  const { page, close } = await fixedScreen()
  try {
    await markPassage(page, 'keep', LOVED)
    await markPassage(page, 'change', DISLIKED)
    stub.queue(honoursMarks)
    // From the keyboard: the button is disabled while the request runs and gone when it is back.
    await marking.fixAgain(page).focus()
    await page.keyboard.press('Enter')
    await expectToast(page, /Refined in [\d.]+s · \d+ → \d+/)

    const shown = stub.last()
    assert.deepEqual(shown.feedback, { previous: FIX_RESPONSE.fixedPrompt, keep: [LOVED], change: [DISLIKED] })
    assert.equal(shown.original, BLOG_PROMPT)
    assert.equal(stub.requests.length, 2, 'one fix, one fix again')

    assert.equal(await ui.historyCount(page).innerText(), '2 of 2')
    assert.equal(await page.getByRole('tab', { name: /^Fixed/ }).getAttribute('aria-selected'), 'true')
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt.replace(DISLIKED, REWORDED))
    assert.match(await page.locator('.banner.info').innerText(), /refined with your marks \(1 kept, 1 changed\)/)
    assert.deepEqual(await highlights(page), [], 'the marks belonged to the rewrite they were made on')
    assert.equal(await marking.fixAgain(page).count(), 0)
    assert.equal(await focusedElement(page), 'pre.output', 'focus is on the new rewrite, not dropped to the top of the page')

    await ui.prev(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '1 of 2')
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt)
    assert.deepEqual(await highlights(page), [], 'and they do not come back with it')
    assert.doesNotMatch(await page.locator('.banner.info').innerText(), /refined with your marks/)

    // Leaving a rewrite is what ends its marks, whichever way it is left: a step through the history…
    await markPassage(page, 'keep', LOVED)
    await ui.next(page).click()
    await ui.prev(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '1 of 2')
    assert.deepEqual(await highlights(page), [], 'a mark does not wait for the user to step back')
    // …or a fresh fix.
    await markPassage(page, 'keep', LOVED)
    stub.queue(asRewrite(TWICE_REWRITE))
    await ui.fixButton(page).click()
    await historyShows(page, '3 of 3')
    assert.equal(await ui.output(page).innerText(), TWICE_REWRITE)
    assert.deepEqual(await highlights(page), [])
    await ui.prev(page).click()
    await ui.prev(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '1 of 3')
    assert.deepEqual(await highlights(page), [], 'nor for a fresh fix to be stepped back from')
    await ui.next(page).click()
    await ui.next(page).click()

    // Two words of the sentence I keep, marked for change where they stand again on their own: the
    // model is shown as many marks as the bar counted, and the note claims no more than that.
    await markPassage(page, 'keep', LOVED)
    await markPassage(page, 'change', TWICE, { occurrence: 2 })
    assert.equal(await marking.count(page).innerText(), '1 kept · 1 to change')
    stub.queue(honoursMarks)
    await marking.fixAgain(page).click()
    await historyShows(page, '4 of 4')
    assert.deepEqual(stub.last().feedback, { previous: TWICE_REWRITE, keep: [LOVED], change: [TWICE] }, 'one kept and one to change, as counted')
    assert.equal(await ui.output(page).innerText(), TWICE_HONOURED)
    assert.match(await page.locator('.banner.info').innerText(), /refined with your marks \(1 kept, 1 changed\)/)
    assert.equal(await page.locator('.banner.warn').count(), 0, 'and no warning about words that still stand inside the kept sentence')
  } finally {
    await close()
  }
})

test('M9 — The rewrite stays exact while marks are showing', async () => {
  const { page, close } = await fixedScreen({ permissions: ['clipboard-read', 'clipboard-write'] })
  try {
    // Two lines kept, and four to change: a passage of well over a hundred characters.
    const LONG_PASSAGE = '- Do not include statistics unless they are in the provided source material\n\n## Output format\nMarkdown, with an H1 title'
    await markPassage(page, 'keep', '## Task\nWrite one blog post')
    await markPassage(page, 'change', LONG_PASSAGE)
    assert.equal((await highlights(page)).length, 2)
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt)
    assert.equal(await ui.output(page).evaluate((el) => el.textContent), FIX_RESPONSE.fixedPrompt)

    // A highlight is a button, so a screen reader is given its name and not its text: the name has
    // to carry the verdict and the whole passage, however long, its line breaks read as spaces.
    const name = `Marked to change: “${LONG_PASSAGE.replace(/\s+/g, ' ')}”. Activate to remove this mark.`
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `no button is called: ${name}`)
    assert.equal(await page.getByRole('button', { name: 'Marked to keep: “## Task Write one blog post”. Activate to remove this mark.', exact: true }).count(), 1)

    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectToast(page, 'Copied')
    // Windows normalises clipboard line endings to CRLF; the words must be identical.
    const clipboard = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
    assert.equal(clipboard, FIX_RESPONSE.fixedPrompt)
  } finally {
    await close()
  }
})

test('M10 — Marks are readable and fit a small window', async () => {
  const { page, close } = await fixedScreen({ viewport: { width: 1024, height: 720 } })
  try {
    await markPassage(page, 'keep', LOVED)
    await markPassage(page, 'change', DISLIKED)
    await marking.count(page).waitFor()
    // With a passage selected the two marking buttons are live, so their labels are measured too.
    await selectPassage(page, 'At most 600 words')
    await page.waitForFunction(() => ![...document.querySelectorAll('.feedback-bar button')].some((b) => b.disabled))

    const measured = await page.evaluate(() => [...document.querySelectorAll('pre.output mark, .feedback-bar *')].filter((el) => el.getClientRects().length).length)
    assert.ok(measured >= 8, 'the bar and both highlights are on screen to be measured')
    assert.deepEqual(await contrastFailures(page), [], 'text below AA contrast with marks showing')

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement
      const panes = [...document.querySelectorAll('.pane, .pane-body, .feedback-bar')].filter((p) => p.scrollWidth > p.clientWidth + 1).length
      return { page: doc.scrollWidth > doc.clientWidth, panes }
    })
    assert.deepEqual(overflow, { page: false, panes: 0 }, 'nothing scrolls horizontally')
    for (const control of [marking.keep, marking.change, marking.clear, marking.fixAgain]) {
      const box = await control(page).boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 1024 && box.y >= 0 && box.y + box.height <= 720, `on screen: ${JSON.stringify(box)}`)
    }
  } finally {
    await close()
  }
})

test('M11 — Fixing again still works after I edited the prompt', async () => {
  const { page, close } = await fixedScreen()
  try {
    const marks = [{ kind: 'change', text: DISLIKED }]
    await markPassage(page, 'change', DISLIKED)

    // One keystroke in the editor parks the rewrite, and the marks with it, out of sight…
    const parked = page.locator('.empty', { hasText: 'Prompt edited' })
    await ui.editor(page).focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('x')
    await parked.waitFor()
    assert.equal(await ui.output(page).count(), 0)
    assert.equal(await marking.fixAgain(page).count(), 0, 'nothing to fix again with while the rewrite is out of sight')
    // …and taking the keystroke back brings both back.
    await page.keyboard.press('Backspace')
    await ui.output(page).waitFor()
    assert.deepEqual(await highlights(page), marks, 'a slip on the keyboard does not cost the marks')

    const edited = `${BLOG_PROMPT} Audience: junior developers.`
    await typePrompt(page, edited)
    await parked.waitFor()
    await page.getByRole('button', { name: 'Show last fix' }).click()
    await ui.output(page).waitFor()
    assert.deepEqual(await highlights(page), marks, 'nor does an edit: the marks wait with the parked rewrite')
    assert.equal(await ui.output(page).evaluate((el) => el.textContent), FIX_RESPONSE.fixedPrompt)

    stub.queue(honoursMarks)
    await marking.fixAgain(page).click()
    await expectToast(page, 'Refined in')

    assert.equal(await parked.count(), 0, 'the new rewrite is not parked')
    assert.equal(await ui.output(page).innerText(), FIX_RESPONSE.fixedPrompt.replace(DISLIKED, REWORDED))
    assert.equal(await ui.historyCount(page).innerText(), '2 of 2')
    assert.equal(stub.last().original, BLOG_PROMPT, 'the refine is of the prompt the marked rewrite was made for')
    assert.deepEqual(stub.last().feedback, { previous: FIX_RESPONSE.fixedPrompt, keep: [], change: [DISLIKED] })
    assert.equal(await ui.editor(page).inputValue(), edited, "the user's edit is untouched")
  } finally {
    await close()
  }
})
