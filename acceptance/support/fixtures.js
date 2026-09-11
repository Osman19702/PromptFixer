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
