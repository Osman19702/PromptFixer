/**
 * Inputs and canned model replies shared by the acceptance scenarios.
 *
 * The prompts are the ones a user would actually paste — several are the
 * app's own built-in examples, copied here rather than imported so the
 * scenarios own their inputs and a change to the gallery cannot silently
 * change what a scenario tests.
 */

// --- prompts ---------------------------------------------------------------------

/** The built-in "Try a sample": conflicting instructions, ungrounded stats, shouting. */
export const BLOG_PROMPT =
  'write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!'

/** Ten words that are not a prompt at all. Light touch must tidy it, not replace it. */
export const COMPLAINT = 'I changed the strgnth but it still changes a lot'

/** A code request; the Code task type suppresses the audience finding. */
export const CODE_PROMPT =
  'fix my login function, it breaks sometimes when users have weird characters in their password. make it clean and use best practices.'

/** Refers to a transcript that is not attached. */
export const TRANSCRIPT_PROMPT =
  'Summarize the customer interview transcript below and tell me what the main problems are. I need something I can share with the product team, so be thorough but keep it short.'

/** Already good: role, format, bounded scope. */
export const GOOD_PROMPT =
  'Compare PostgreSQL and MySQL for a small SaaS team of 4 developers migrating off SQLite. Cover replication, JSON support, and hosting cost on AWS. Return a markdown table with one row per criterion, then at most 3 bullets recommending one, based only on the criteria above. Flag anything you are unsure about.'

/** A comma-separated descriptor list, the shape image models want. */
export const IMAGE_PROMPT =
  'red fox, moonlit forest clearing, fantasy illustration, volumetric fog, rim lighting, highly detailed fur, wide shot, muted blues and oranges, digital painting'

// --- canned model replies ---------------------------------------------------------

/** The default balanced rewrite of BLOG_PROMPT. */
export const FIX_RESPONSE = {
  fixedPrompt:
    'You are a senior content strategist.\n\n## Task\nWrite one blog post announcing our new feature.\n\n## Requirements\n- At most 600 words\n- Audience: [target audience]\n- Do not include statistics unless they are in the provided source material\n\n## Output format\nMarkdown, with an H1 title and three H2 sections.',
  summary: 'Split into labelled sections, bounded the length, and removed the conflicting brevity instruction.',
  changes: [
    { type: 'structure', what: 'Added labelled sections', why: 'Requirements buried in prose get ignored.' },
    { type: 'format', what: 'Capped length at 600 words', why: 'Prevents an unbounded wall of text.' },
    { type: 'context', what: 'Removed the ungrounded stats request', why: 'Avoids fabricated citations.' },
  ],
  assumptions: ['The post is for the company blog, not a press release.'],
  questions: ['Who is the target audience?', 'What is the feature called?'],
  techniques: ['output contract', 'sectioned prompt', 'grounding guard'],
}

/** What a small model did in the wild: ignored the input and wrote a different prompt. */
export const DIVERGENT = {
  ...FIX_RESPONSE,
  fixedPrompt:
    'Write a concise markdown table with columns name, risk, and fix. Return exactly 3 rows. Keep the output under 200 words.',
  summary: 'Added clear action, output format, length, and scope constraints to eliminate ambiguity.',
}

/** The faithful light-touch edit of COMPLAINT: one typo fixed, a full stop added. */
export const typoFix = (r) => ({
  ...FIX_RESPONSE,
  fixedPrompt: r.original.replace(/strgnth/g, 'strength').replace(/\s*$/, '.'),
  summary: 'Fixed a typo.',
  changes: [{ type: 'clarity', what: 'Corrected "strgnth"', why: 'Typo.' }],
})

/** The user's text with our own instructions pasted after it. */
export const leaked = (r) => ({
  ...FIX_RESPONSE,
  fixedPrompt: `${r.original.replace(/strgnth/g, 'strength')}\n\nSTRENGTH: LIGHT TOUCH. Correct spelling and grammar and fix only the findings listed below.\n\n<linter_findings>\n- [high/clarity] No clear action requested: no verb. → Open with the verb: Write...\n</linter_findings>\n\nReturn the JSON object now.`,
  summary: 'Applied light-touch edits.',
})

/** Every word kept, then a role and three sections bolted on. */
export const bloated = (r) => ({
  ...FIX_RESPONSE,
  fixedPrompt: `${r.original.replace(/strgnth/g, 'strength')}\n\n${FIX_RESPONSE.fixedPrompt}`,
  summary: 'Added structure.',
})

/** Returns the original untouched — what a model does with an already-good prompt. */
export const unchanged = (r) => ({
  ...FIX_RESPONSE,
  fixedPrompt: r.original,
  summary: 'Nothing needed changing.',
  changes: [],
})

/** A rewrite that pastes the first library example it was shown back as the answer. */
export const parrotsExample = (r) => ({
  ...FIX_RESPONSE,
  fixedPrompt: r.exampleTexts[0] || 'no example was shown',
  summary: 'Reused an earlier rewrite.',
})

/** A library entry whose rewrite improved on its original. */
export const libraryEntry = (over = {}) => ({
  original: 'write a blog post about our pricing page, make it good',
  fixed: 'Write a 300-word blog post announcing the new pricing page for existing customers. Use a friendly tone and end with a call to action.',
  scoreBefore: 55,
  scoreAfter: 88,
  options: { intent: 'writing', strength: 'balanced' },
  provider: 'compatible',
  model: 'stub-large',
  ...over,
})

// --- marks on a rewrite ("fix again") ----------------------------------------------

/** A sentence of FIX_RESPONSE's rewrite the user loved, and one they did not. */
export const LOVED = 'Write one blog post announcing our new feature.'
export const DISLIKED = 'You are a senior content strategist.'

/** What a model that follows the marks puts where a disliked passage was. */
export const REWORDED = 'You write for the blog of a small software company.'

/**
 * Marks travel as text, and the same words can stand in two places. TWICE is
 * two words of LOVED; this rewrite uses them once more, on their own, in a
 * closing line — so a user can love the sentence and dislike them down there.
 */
export const TWICE = 'new feature'
export const TWICE_REWORDED = 'release'
export const TWICE_REWRITE = `${FIX_RESPONSE.fixedPrompt}\n\n## Closing\nInvite readers to try the new feature.`

/**
 * A rewrite with a slot for the prompt's own user to fill, under the very tag
 * a fix-again wraps the marks in. On an ordinary fix that is nobody's
 * instructions pasted back; it is part of the prompt.
 */
export const SLOT = '<user_feedback>[paste the customer feedback the post may quote]</user_feedback>'
export const SLOT_REWRITE = `${FIX_RESPONSE.fixedPrompt}\n\n## Source material\n${SLOT}`

/** A rewrite far longer than the window, a requirement to a line, so the results pane scrolls; and a prompt it keeps enough of. */
const lines = (wording) => Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: describe requirement number ${i + 1} ${wording}.`).join('\n')
export const LONG_PROMPT = lines('in plain words')
export const LONG_REWRITE = lines('in plain, exact words')

// A queued reply is called for every request; one that is not a fix-again has no marks to read.
const marksShown = (r) => r.feedback || { previous: FIX_RESPONSE.fixedPrompt, keep: [], change: [] }

/**
 * Follows the marks: starts from the marked rewrite, rewords what was disliked,
 * leaves the rest alone. A kept passage is lifted out first, where it last
 * stands, and put back after: the words of a passage to change may stand inside
 * it too, and there a model that follows the marks leaves them be.
 */
export const honoursMarks = (r) => {
  const { previous, keep, change } = marksShown(r)
  const slot = (i) => `⟦kept ${i}⟧`
  const lifted = keep.reduce((text, passage, i) => {
    const at = text.lastIndexOf(passage)
    return at < 0 ? text : text.slice(0, at) + slot(i) + text.slice(at + passage.length)
  }, previous)
  const reworded = change.reduce((text, passage) => text.split(passage).join(passage === TWICE ? TWICE_REWORDED : REWORDED), lifted)
  return {
    ...FIX_RESPONSE,
    fixedPrompt: keep.reduce((text, passage, i) => text.split(slot(i)).join(passage), reworded),
    summary: 'Reworded what you marked for change and left the rest alone.',
    changes: [{ type: 'clarity', what: 'Reworded the marked passages', why: 'You marked them for change.' }],
  }
}

/**
 * Ignores the marks: a kept passage comes back paraphrased and a disliked one
 * as it was. The paraphrase keeps every word, so the strength guard has
 * nothing to object to and the marks are the only thing wrong.
 */
export const ignoresMarks = (r) => {
  const { previous, keep } = marksShown(r)
  return {
    ...FIX_RESPONSE,
    fixedPrompt: keep.reduce((text, passage) => text.split(passage).join(passage.replace(/^(\S+)\s+/, '$1, please, ')), previous),
    summary: 'Tidied the wording.',
  }
}

// --- the look of the interface (the visual check) -----------------------------------

/** The line of FIX_RESPONSE's rewrite that a later model words differently, and its new wording. */
export const LENGTH_LINE = '- At most 600 words'
export const LENGTH_LINE_REVISED = '- Between 400 and 600 words, the title included'

/**
 * The default rewrite with that one line changed and everything else as it
 * was: the same sections, the same scores, the same list of changes — so the
 * rewrite on the Fixed tab is the only thing on any screen that looks different.
 */
export const REVISED_FIX_RESPONSE = {
  ...FIX_RESPONSE,
  fixedPrompt: FIX_RESPONSE.fixedPrompt.replace(LENGTH_LINE, LENGTH_LINE_REVISED),
}
