/**
 * The meta-prompt: how PromptFixer asks a model to rewrite the user's prompt.
 *
 * The presets here are the single source of truth — the UI fetches them from
 * /api/presets rather than hardcoding its own copy.
 */

export const INTENTS = [
  {
    id: 'general',
    label: 'General',
    hint: 'No particular domain',
    guidance: 'Keep the rewrite domain-neutral. Do not invent a specialism the user did not ask for.',
  },
  {
    id: 'code',
    label: 'Code & engineering',
    hint: 'Write, review or debug code',
    guidance: [
      'Require the language, framework and version when they matter.',
      'Ask for runnable code with no placeholder bodies, and specify whether explanation should accompany it.',
      'Push for edge cases, error handling and how the result will be tested.',
      'Prefer "return only the changed function" style scoping over "rewrite the file".',
    ].join(' '),
  },
  {
    id: 'writing',
    label: 'Writing & content',
    hint: 'Posts, copy, emails, docs',
    guidance: [
      'Pin down audience, tone, reading level and length in words.',
      'Require a specific angle or thesis rather than a topic alone.',
      'Ban filler openers and generic conclusions explicitly if the user cares about voice.',
    ].join(' '),
  },
  {
    id: 'analysis',
    label: 'Analysis & research',
    hint: 'Summarise, compare, reason',
    guidance: [
      'Insist the answer is grounded in supplied material, and state what to do when the data does not cover something.',
      'Ask for the reasoning or criteria behind conclusions, and for uncertainty to be flagged rather than smoothed over.',
    ].join(' '),
  },
  {
    id: 'agent',
    label: 'Agent / system prompt',
    hint: 'Reusable system instructions',
    guidance: [
      'Write it as durable instructions for a system prompt, not a one-off request: second person, present tense.',
      'Cover role, scope boundaries, tool-use rules, refusal and escalation behaviour, and output contract.',
      'Keep any user-supplied variables as clearly marked placeholders such as {{input}}.',
      'Prefer positive rules over prohibitions, and state precedence when rules can conflict.',
    ].join(' '),
  },
  {
    id: 'extraction',
    label: 'Data extraction',
    hint: 'Structured output from text',
    guidance: [
      'Define an exact output schema with field names, types and what to emit when a value is absent.',
      'Require output to be the structure only, with no prose wrapper.',
      'Include one worked example of input to output.',
    ].join(' '),
  },
  {
    id: 'image',
    label: 'Image generation',
    hint: 'Midjourney, SD, DALL-E',
    guidance: [
      'Rewrite as a dense visual description: subject, action, setting, composition, lens, lighting, colour, medium, style.',
      'Use comma-separated descriptors rather than sentences and instructions.',
      'Do not address the model in second person; image models are not instruction-followers.',
      'Suggest a separate negative-prompt line if the user named things to avoid.',
    ].join(' '),
  },
]

export const TARGET_MODELS = [
  {
    id: 'generic',
    label: 'Any model',
    guidance: 'Use portable markdown structure that works everywhere. Avoid vendor-specific syntax.',
  },
  {
    id: 'claude',
    label: 'Claude',
    guidance: [
      'Claude follows XML-ish tags reliably: use <context>, <task>, <requirements>, <output_format> style sections.',
      'Put long reference material before the instructions, and restate the task after it.',
      'A short explicit role line helps; verbose persona theatre does not.',
    ].join(' '),
  },
  {
    id: 'gpt',
    label: 'GPT',
    guidance: [
      'Use compact markdown headings and numbered requirements.',
      'State the output contract in one unambiguous sentence near the end.',
    ].join(' '),
  },
  {
    id: 'gemini',
    label: 'Gemini',
    guidance: 'Use clearly labelled sections and repeat hard output constraints at the end of the prompt.',
  },
  {
    id: 'local',
    label: 'Small / local model',
    guidance: [
      'Small models degrade fast on long prompts: keep it under roughly 200 words and one single task.',
      'Be blunt and literal, include one short example, and avoid nested conditional rules.',
    ].join(' '),
  },
]

export const STRENGTHS = [
  {
    id: 'light',
    label: 'Light touch',
    guidance: [
      'Make the minimum edits that remove real ambiguity. Preserve the user\'s wording, voice and length wherever it is already unambiguous.',
      'Do not add sections, roles or scaffolding that were not implied by the original.',
    ].join(' '),
  },
  {
    id: 'balanced',
    label: 'Balanced',
    guidance: [
      'Fix the reported issues and add the missing essentials (format, limits, key context slots).',
      'Keep the result recognisably the user\'s prompt: aim for at most roughly twice the original length.',
    ].join(' '),
  },
  {
    id: 'aggressive',
    label: 'Full rebuild',
    guidance: [
      'Restructure into a properly engineered prompt with labelled sections, explicit requirements and an output contract.',
      'Still never invent facts about the user\'s situation: use clearly marked placeholders for anything you do not know.',
    ].join(' '),
  },
]

/**
 * How much of the original must survive a rewrite, per strength — the fraction
 * of the original's distinct content words that appear in the result. Below
 * this, /api/fix retries once with a corrective instruction and warns the user
 * if the retry is still under. Small local models need this guard: given a
 * vague input they will happily write a different prompt from scratch.
 */
export const MIN_RETENTION = { light: 0.6, balanced: 0.3, aggressive: 0 }

/**
 * How much a rewrite may grow, per strength: at most `ratio` × the original's
 * word count, with `slack` extra words so a one-line prompt can still gain a
 * sentence. Retention alone cannot catch a model that keeps every word and
 * bolts a role, headings and rules onto the end — that is what this is for.
 * Full rebuild has no ceiling.
 */
// Balanced is deliberately loose: real balanced rewrites of one-line prompts
// run 3-5x in practice, and a false "added scaffolding" warning is worse than a
// missed one. Light touch is where growth actually signals a problem.
export const MAX_GROWTH = { light: { ratio: 1.5, slack: 20 }, balanced: { ratio: 5, slack: 100 }, aggressive: null }

/** Whitespace-separated words, the unit the user thinks in. */
const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length

/** Largest word count the strength allows for a rewrite of `original`; Infinity when unbounded. */
export function maxWords(original, strength) {
  const limit = MAX_GROWTH[strength] === undefined ? MAX_GROWTH.balanced : MAX_GROWTH[strength]
  if (!limit) return Infinity
  const words = wordCount(original)
  return Math.max(Math.ceil(words * limit.ratio), words + limit.slack)
}

// Scripts written without spaces between words. Splitting on whitespace turns
// a whole Japanese or Thai clause into one "word", so any edit inside it looks
// like the clause was dropped; character bigrams keep the comparison local.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu

/**
 * Distinct lowercase content words of a text (3+ characters, or character
 * bigrams for unspaced scripts). Shared with the library's similarity search
 * so "how much of this survived" and "how alike are these" agree on what a
 * word is.
 */
export const contentWords = (text) => {
  const out = new Set()
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  for (const word of cleaned.split(/\s+/)) {
    const runs = word.match(UNSPACED)
    if (!runs) {
      if (word.length >= 3) out.add(word)
      continue
    }
    // Latin fragments around the run (e.g. "AIモデル") count as usual.
    for (const rest of word.split(UNSPACED)) if (rest.length >= 3) out.add(rest)
    for (const run of runs) {
      const chars = [...run]
      if (chars.length < 2) {
        out.add(run)
        continue
      }
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
    }
  }
  return out
}

/** Fraction (0..1) of the original's distinct content words present in the rewrite. */
export function retention(original, fixed) {
  const src = contentWords(original)
  if (!src.size) return 1
  const dst = contentWords(fixed)
  let kept = 0
  for (const w of src) if (dst.has(w)) kept++
  return kept / src.size
}

/**
 * Substrings that occur in our own instructions and essentially never in a
 * user's prompt. Both the first-attempt and the retry message are covered:
 * the scrub only ever runs after a retry, so it is the retry message a model
 * pastes back.
 */
const LEAK_MARKERS = [
  'STRENGTH: LIGHT TOUCH',
  'STRENGTH: BALANCED',
  '<linter_findings>',
  '</linter_findings>',
  'A static linter already scored',
  'Return the JSON object now',
  'You will fix one prompt',
  'The user added instructions for how they want it fixed',
  'Your previous attempt was rejected',
  '<original_prompt>',
  '</original_prompt>',
  '<rejected_attempt>',
  '</rejected_attempt>',
  '<user_notes>',
  '</user_notes>',
  '<instructions>',
  '</instructions>',
  '→ Open with the verb',
  // Few-shot examples from the library. A model that pastes one back would
  // otherwise hand the user somebody else's prompt as their rewrite. Only the
  // wrapper and its preamble count: a bare <example> tag is something the
  // Claude and extraction presets legitimately ask a rewrite to contain.
  '<examples>',
  '</examples>',
  'These are earlier rewrites the user kept',
]
// The marks block of a "fix again". As with the examples, only the wrappers
// and the preamble count: a user's own prompt may well use <keep> or <change>
// tags, so the bare passage tags identify nothing. A list of its own because
// these only mean a leak when the message had a marks block in it: on an
// ordinary fix a <user_feedback> slot is something a rewrite may well contain.
const FEEDBACK_LEAK_MARKERS = [
  '<previous_rewrite>',
  '</previous_rewrite>',
  '<user_feedback>',
  '</user_feedback>',
  'The user reviewed your previous rewrite',
]
const FINDING_LINE = /^\s*-\s*\[(high|medium|low)\/[a-z]+\]/i
const hasFindingLines = (text) => String(text).split('\n').some((l) => FINDING_LINE.test(l))

// Blocks we can drop whole. <original_prompt> is deliberately not here: its
// body is the user's text, and a model that pastes the entire message back
// would otherwise be scrubbed down to nothing.
const LEAK_BLOCKS = [
  /<linter_findings>[\s\S]*?<\/linter_findings>/g,
  /<rejected_attempt>[\s\S]*?<\/rejected_attempt>/g,
  /<user_notes>[\s\S]*?<\/user_notes>/g,
  // The example bodies are other prompts: the lines inside carry no marker,
  // so only dropping the whole block gets them out.
  /<examples>[\s\S]*?<\/examples>/g,
]
// Same for the marks block of a "fix again": the previous rewrite and the
// marked passages are plain prose, and a pasted copy would double the rewrite.
const FEEDBACK_LEAK_BLOCKS = [
  /<previous_rewrite>[\s\S]*?<\/previous_rewrite>/g,
  /<user_feedback>[\s\S]*?<\/user_feedback>/g,
]
// The marks block as buildUserPrompt() writes it: the wrapper, then nothing but
// passages. This is what tells our block from a <user_feedback> slot of the
// user's own once the bare tags are theirs — counting the tags would not: an
// honest rewrite may mention the tag once more in a sentence, and a model can
// paste the marks into the slot without adding a tag. The closing tag is
// optional because a reply that ran out of tokens stops mid-block.
const MARKS_BLOCK = /<user_feedback>\s*(?:<(keep|change)>[\s\S]*?<\/\1>\s*)+(?:<\/user_feedback>)?/g

/**
 * Remove our own boilerplate if a model pasted it into the rewrite. Last
 * resort, after a retry. Anything the user's original already contains is
 * theirs and stays — a marker they wrote, or a whole bullet list shaped like
 * our findings — even when the model has edited the line.
 *
 * @param feedback  The marks of a "fix again", when the message had any. Only
 *                  then is the marks block something a model can have pasted;
 *                  without it the scrub is what it was before marks existed.
 */
export function scrubLeakedInstructions(text, original = '', feedback) {
  const src = String(original)
  const marks = usableFeedback(feedback)
  // The rewrite the user marked is theirs too, and the model was told to start
  // from it: a <user_feedback> slot in there has to survive being fixed again.
  const theirs = (s) => src.includes(s) || marks.previous.includes(s)
  const markers = LEAK_MARKERS.filter((m) => !src.includes(m))
  if (marks) markers.push(...FEEDBACK_LEAK_MARKERS.filter((m) => !theirs(m)))
  const dropFindingLines = !hasFindingLines(src)
  let out = String(text)
  for (const block of LEAK_BLOCKS) out = out.replace(block, (m) => (src.includes(m) ? m : ''))
  if (marks) {
    const drop = (m) => (theirs(m) ? m : '')
    const [previousRewrite, userFeedback] = FEEDBACK_LEAK_BLOCKS
    out = out.replace(previousRewrite, drop).replace(MARKS_BLOCK, drop)
    // Any other <user_feedback> block is ours only while the tags are: once the
    // user has a slot of their own, a block that is not the marks block is that
    // slot with its body reworded, or a sentence that names the tag running
    // into it — and dropping either would take the user's slot with it.
    if (!(theirs('<user_feedback>') && theirs('</user_feedback>'))) out = out.replace(userFeedback, drop)
  }
  return out
    .split('\n')
    .filter((line) => !markers.some((m) => line.includes(m)) && !(dropFindingLines && FINDING_LINE.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Runs of whitespace collapsed to one space — the form marked passages are compared in. */
export const collapseSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Whether `passage` occurs in `text`. Case-sensitive, but blind to how the
 * whitespace falls: a model that re-wraps a kept sentence has still kept it,
 * and a selection dragged across a line break still points at its text.
 */
export function containsPassage(text, passage) {
  const needle = collapseSpace(passage)
  return needle !== '' && collapseSpace(text).includes(needle)
}

/**
 * Where `needle` starts in `hay`, left to right. Occurrences never overlap
 * ("aa" is in "aaa" once) unless `overlapping` asks for every place the needle
 * could sit. An indexOf() loop would do, but V8's search goes quadratic on a
 * crafted needle — 20 ms for one 2,000-character mark against a 60k rewrite,
 * and a request brings dozens of marks. This one (Knuth–Morris–Pratt) reads
 * each character once whatever it is given.
 */
export function passageStarts(hay, needle, overlapping = false) {
  const h = String(hay)
  const n = String(needle)
  const found = []
  if (!n || n.length > h.length) return found
  // fall[i]: how much of the needle still matches once n[0..i] has and the next character does not.
  const fall = new Int32Array(n.length)
  for (let i = 1, k = 0; i < n.length; i++) {
    while (k && n.charCodeAt(i) !== n.charCodeAt(k)) k = fall[k - 1]
    if (n.charCodeAt(i) === n.charCodeAt(k)) k++
    fall[i] = k
  }
  for (let i = 0, k = 0; i < h.length; i++) {
    const c = h.charCodeAt(i)
    while (k && c !== n.charCodeAt(k)) k = fall[k - 1]
    if (c === n.charCodeAt(k)) k++
    if (k === n.length) {
      found.push(i + 1 - n.length)
      k = overlapping ? fall[k - 1] : 0
    }
  }
  return found
}

/**
 * The marks a rewrite did not honour, as `{ missingKeep, unchangedChange }`.
 * The one place this is decided: the guard asks here, and the `meta.feedback`
 * the user is shown is the guard's own answer, so they cannot disagree.
 *
 * A kept passage has to be there. A passage to change has to occur FEWER times
 * than in the rewrite it was marked on — marks travel as text, not positions,
 * so "the words are still somewhere" proves nothing: they may occur three
 * times with one marked, or stand inside a passage the user asked to keep.
 */
export function missedMarks(fixed, feedback) {
  const marks = usableFeedback(feedback)
  if (!marks) return { missingKeep: [], unchangedChange: [] }
  const out = collapseSpace(fixed)
  const before = collapseSpace(marks.previous)
  const count = (text, passage) => passageStarts(text, collapseSpace(passage)).length
  return {
    missingKeep: marks.keep.filter((p) => !count(out, p)),
    unchangedChange: marks.change.filter((p) => {
      const left = count(out, p)
      // Gone altogether is changed, even if the mark pointed at nothing.
      return left > 0 && left >= count(before, p)
    }),
  }
}

// A rejection reason quotes the passages it is about, but the retry message
// still carries them in full inside <user_feedback> — the quote only has to
// say which one, and forty marks must not turn the reason into a second prompt.
const QUOTE_MAX_CHARS = 120
const QUOTED_PASSAGES = 3
const quoted = (passages) => {
  // Collapsed, so the rejection sentence stays on the one line the scrub drops;
  // escaped like the passage in its tag, so both spellings of it agree.
  const shown = passages
    .slice(0, QUOTED_PASSAGES)
    .map((p) => `"${clip(collapseSpace(p), QUOTE_MAX_CHARS).replace(PASSAGE_TAGS, '&lt;')}"`)
  const rest = passages.length - shown.length
  return shown.join(', ') + (rest > 0 ? ` and ${rest} more` : '')
}

/**
 * Checks a rewrite against what the chosen strength allows: it must keep enough
 * of the user's words, it must not grow past the strength's ceiling, and it
 * must not contain our instructions. On a "fix again" (`options.feedback`, the
 * user's marks on an earlier rewrite) it must also honour every mark.
 * `reasons` are written for the model — they go straight into the retry
 * message.
 */
export function validateRewrite(original, fixed, options = {}) {
  const minRetention = MIN_RETENTION[options.strength] ?? MIN_RETENTION.balanced
  const kept = retention(original, fixed)
  const src = String(original)
  const out = String(fixed)
  // A marker the user themselves wrote is not a leak, and neither is a list
  // shaped like our findings when their prompt already had one — a model that
  // edits such a line must not be punished for it.
  // A library example handed back verbatim is somebody else's prompt, not a
  // rewrite of this one — and it can share enough words to pass retention.
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const copiedExample =
    flat(out) !== '' &&
    (options.examples || []).some((e) => flat(e.before) === flat(out) || flat(e.after) === flat(out))
  // The marks block can only have been pasted back when the message had one,
  // and a marker in the rewrite the user marked is theirs, like one in their
  // prompt: fixing that rewrite again must not be a leak for ever after.
  const marks = usableFeedback(options.feedback)
  const theirs = (s) => src.includes(s) || marks.previous.includes(s)
  // Their tags do not make every block theirs: a rewrite that keeps its own
  // <user_feedback> slot and has our marks block pasted after it — or into it —
  // trips no marker, so the block is known by its shape.
  const pastedMarks =
    marks !== null &&
    (FEEDBACK_LEAK_MARKERS.some((m) => out.includes(m) && !theirs(m)) ||
      (out.match(MARKS_BLOCK) || []).some((block) => !theirs(block)))
  const leaked =
    copiedExample ||
    LEAK_MARKERS.some((m) => out.includes(m) && !src.includes(m)) ||
    pastedMarks ||
    (hasFindingLines(out) && !hasFindingLines(src))
  const originalWords = wordCount(src)
  const words = wordCount(out)
  const limit = maxWords(src, options.strength)

  const reasons = []
  if (copiedExample) {
    reasons.push(
      "it returned one of the earlier examples instead of a rewrite — the examples show how much to change, not what to write; edit the user's own prompt"
    )
  } else if (leaked) {
    reasons.push(
      'it copied the instructions (the STRENGTH line, the linter findings or the closing line) into fixedPrompt — only the improved prompt belongs there'
    )
  }
  if (kept < minRetention) {
    reasons.push(
      `only ${Math.round(kept * 100)}% of the user's words survived, and at this strength at least ${Math.round(minRetention * 100)}% must`
    )
  }
  if (words > limit) {
    reasons.push(
      `it added ${words - originalWords} words of scaffolding — the rewrite has ${words} words, and at this strength at most ${limit} are allowed`
    )
  }
  // The marks are the most explicit thing the user has said about this text,
  // so a rewrite that ignores one is rejected like any other failure. A leaked
  // attempt is never shown as it is — the user gets the scrub of it (see
  // /api/fix) — so that is the text the marks are judged on: a kept passage
  // that only survives inside a pasted marks block is not one the user will see.
  const scrubbed = marks && leaked ? (copiedExample ? '' : scrubLeakedInstructions(out, src, marks)) : out
  // An attempt with no rewrite in it has honoured nothing: a copied example,
  // our message with nothing added, or our message around the user's own
  // prompt. Judged as text, that last one would pass for a rewrite that dropped
  // every passage to change, and beat a usable retry on retention. The pasted
  // tag is what tells it from a model that went back to the original on
  // purpose and let one stray line of ours in — that reply did follow the marks.
  // Either tag: the tail of the message, pasted from the prompt down, has only the closing one.
  const pastedOriginal = ['<original_prompt>', '</original_prompt>'].some((tag) => out.includes(tag) && !src.includes(tag))
  const noRewrite =
    Boolean(marks && leaked) &&
    (scrubbed === '' || (pastedOriginal && collapseSpace(scrubbed) === collapseSpace(src)))
  const { missingKeep, unchangedChange } = noRewrite
    ? { missingKeep: marks.keep, unchangedChange: marks.change }
    : missedMarks(scrubbed, marks)
  if (missingKeep.length) {
    reasons.push(
      missingKeep.length === 1
        ? `it dropped a passage the user marked to keep — ${quoted(missingKeep)} must appear in fixedPrompt word for word`
        : `it dropped ${missingKeep.length} passages the user marked to keep — ${quoted(missingKeep)} must each appear in fixedPrompt word for word`
    )
  }
  if (unchangedChange.length) {
    reasons.push(
      unchangedChange.length === 1
        ? `it left a passage the user marked for change as it was — ${quoted(unchangedChange)} must be reworded, replaced or removed`
        : `it left ${unchangedChange.length} passages the user marked for change as they were — ${quoted(unchangedChange)} must each be reworded, replaced or removed`
    )
  }
  return {
    ok: reasons.length === 0,
    reasons,
    retention: kept,
    minRetention,
    leaked,
    copiedExample,
    words,
    originalWords,
    maxWords: limit,
    missingKeep,
    unchangedChange,
  }
}

/**
 * Which of two attempts to show the user. Clean beats un-leaked beats leaked;
 * within a rank the attempt that ignored fewer of the user's marks wins, then
 * whichever kept more of the user's words, and the first attempt wins an exact
 * tie — the retry has to earn its place.
 */
export function pickBest(first, second) {
  if (!second) return first
  const rank = (a) => (a.check.ok ? 2 : a.check.leaked ? 0 : 1)
  // Zero without feedback, so an ordinary fix is ranked exactly as before.
  const misses = (a) => (a.check.missingKeep?.length || 0) + (a.check.unchangedChange?.length || 0)
  if (rank(second) !== rank(first)) return rank(second) > rank(first) ? second : first
  if (misses(second) !== misses(first)) return misses(second) < misses(first) ? second : first
  if (second.check.retention > first.check.retention) return second
  return first
}

/**
 * Strength directives go in the *user* message, next to the findings. A 4B
 * model follows the concrete list in front of it over a line of guidance in
 * the system prompt, so the constraint has to sit where the list is.
 */
/**
 * Findings whose only fix is *new information* — context, audience, a format,
 * a limit, criteria, an example, a role. Light touch never sees these: a model
 * told to "add context" with nothing to draw on invents it.
 */
export const ADDITIVE_FINDINGS = new Set([
  'no-context',
  'no-audience',
  'no-format',
  'no-limits',
  'no-criteria',
  'no-examples',
  'no-role',
  'ungrounded-facts',
])

const STRENGTH_DIRECTIVES = {
  light: [
    'STRENGTH: LIGHT TOUCH.',
    'Correct spelling and grammar and fix only the findings listed below.',
    "Keep the user's own sentences and words — the fixed prompt must read as the same text, lightly edited.",
    'Do not add a role, headings, format rules, word limits or examples, and do not add any fact, number or context about the user\'s situation that is not already in their text.',
    'If the text is not really a prompt, tidy it as written; never replace it with a different prompt.',
  ].join(' '),
  balanced: [
    'STRENGTH: BALANCED.',
    "Keep the user's intent and key phrases; add only the missing essentials (format, limits, context slots).",
  ].join(' '),
  aggressive: '',
}

const OUTPUT_CONTRACT = `Return ONE JSON object and nothing else. No markdown fence, no commentary before or after.

{
  "fixedPrompt": string,        // the rewritten prompt, ready to paste. This is the deliverable.
  "summary": string,            // one sentence, max 25 words, on what you changed overall
  "changes": [                  // 2-8 entries, the substantive edits only
    {
      "type": string,           // one of: clarity, specificity, context, format, structure, scope, safety
      "what": string,           // what you changed, max 15 words
      "why": string             // the concrete failure this prevents, max 30 words
    }
  ],
  "assumptions": [string],      // 0-5 things you had to assume; empty array if none
  "questions": [string],        // 0-4 questions whose answers would most improve the prompt further
  "techniques": [string]        // 0-5 named prompting techniques you applied, e.g. "output contract", "few-shot example"
}`

/**
 * The same contract as a JSON schema. The local provider compiles this to a
 * GBNF grammar so the model physically cannot emit anything else; cloud
 * providers ignore it and rely on the prose contract above.
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    fixedPrompt: { type: 'string' },
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { enum: ['clarity', 'specificity', 'context', 'format', 'structure', 'scope', 'safety'] },
          what: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    techniques: { type: 'array', items: { type: 'string' } },
  },
}

export function buildSystemPrompt(options = {}) {
  const intent = INTENTS.find((i) => i.id === options.intent) || INTENTS[0]
  const target = TARGET_MODELS.find((m) => m.id === options.targetModel) || TARGET_MODELS[0]
  const strength = STRENGTHS.find((s) => s.id === options.strength) || STRENGTHS[1]

  const rules = [
    'Rewrite the prompt. Do not answer it, and do not produce the output the prompt is asking for.',
    'Never invent specifics about the user, their product, their data or their deadlines. When a detail is genuinely required and unknown, write a square-bracket placeholder such as [product name] or [target audience] inside a sentence that will read naturally once filled in, and list it under questions. Never write a sentence made only of placeholders, never add a placeholder for a detail the task does not depend on, and prefer leaving an optional detail out over inventing one.',
    'Add a length or scope bound only when the task produces free-form prose and the user gave none. Never add a word count to a request for code, a question, a one-line instruction or a system prompt; there, a scope bound such as "return only the changed function" is the right kind. When you add a bound, derive it from the task, not from examples in the findings.',
    'Findings are advice, not orders. If a finding (missing audience, missing context, no example) would not change the answer for this task, ignore it rather than bolt on a placeholder or a generic sentence.',
    'Preserve the user\'s actual intent exactly. Fixing a prompt does not mean changing what they asked for.',
    'Keep the prompt in the same language the user wrote it in.',
    'Every requirement you add must be checkable by looking at the output.',
    'Cut words that do not change the model\'s behaviour. A shorter prompt that is fully specified beats a padded one.',
    'Do not add "think step by step", a role line, or examples reflexively — only when they measurably help this task.',
  ]

  if (options.preserveTone) {
    rules.push('The user wants their voice preserved: keep their phrasing and register, and fix only structure and precision.')
  }
  if (options.includeExample) {
    rules.push('Include one short illustrative example of the desired output inside the rewritten prompt.')
  }
  if (options.addRole) {
    rules.push('Open the rewritten prompt with a single concrete role line.')
  }

  return `You are a prompt engineer. You take a rough prompt and return a precise one that gets the intended result on the first try.

## Task type
${intent.label} — ${intent.guidance}

## Target model
${target.label} — ${target.guidance}

## Rewrite strength
${strength.label} — ${strength.guidance}

## Hard rules
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Output contract
${OUTPUT_CONTRACT}`
}

/**
 * Longest before/after a few-shot example may be. The examples are there to
 * show the *degree* of change, which the first few hundred characters already
 * do; a whole saved prompt would crowd the user's own text out of a small
 * model's context.
 */
export const EXAMPLE_MAX_CHARS = 600

const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const OPENING =
  'You will fix one prompt. Everything inside <instructions> is guidance for you. The text to fix is only what sits inside <original_prompt> at the end — nothing from <instructions> may appear in fixedPrompt.'

// "Nothing from <instructions> may appear" would forbid the very text a "fix
// again" has to start from, and a 4B model follows the first thing it reads —
// so the carve-out is made here, in the opening line, not further down.
const OPENING_WITH_FEEDBACK =
  "You will fix one prompt. Everything inside <instructions> is guidance for you. The text to fix sits inside <original_prompt> at the end, and you have already rewritten it once: fixedPrompt is that rewrite, the text inside <previous_rewrite>, revised as the user's marks ask. Apart from the text inside <previous_rewrite>, nothing from <instructions> may appear in fixedPrompt."

// A marked passage is the user's text dropped between our tags. If it holds
// one of those tags itself, the mark would end early and the rest of it would
// read as instructions; an escaped bracket keeps it a literal.
// The slash takes its trailing spaces with it: with a \s* on either side of an
// optional slash, a "<" before a long run of spaces is split every possible
// way, and one 60k passage held the event loop for seconds.
const PASSAGE_TAGS = /<(?=\s*(?:\/\s*)?(?:keep|change|user_feedback|previous_rewrite)\s*>)/gi
// The previous rewrite is only escaped where it could close its own wrapper or
// fake the marks block: a rewrite that uses <keep> tags of its own should reach
// the model as it was written.
const WRAPPER_TAGS = /<(?=\s*(?:\/\s*)?(?:user_feedback|previous_rewrite)\s*>)/gi

/** The user's marks as `{ previous, keep, change }` with at least one passage, or null. */
function usableFeedback(feedback) {
  if (!feedback || typeof feedback !== 'object') return null
  const previous = String(feedback.previous ?? '')
  const passages = (list) => (Array.isArray(list) ? list : []).map((p) => String(p ?? '').trim()).filter(Boolean)
  const keep = passages(feedback.keep)
  const change = passages(feedback.change)
  return previous.trim() && (keep.length || change.length) ? { previous, keep, change } : null
}

/**
 * How the passages to change whose words also stand inside a kept passage sit
 * in the rewrite they were marked on. Marks are text, not positions, so this
 * happens whenever the user disliked words in one place and loved a passage
 * holding them in another — and what the model must be told, and what the
 * guard will take, depends on where else those words stand:
 *  - `free`: somewhere on their own. The kept passage wins where it holds
 *    them, and they are changed where it does not.
 *  - `repeated`: nowhere on their own, but a kept passage holding them stands
 *    in a second place, clear of them: two places that read the same, one to
 *    leave and one to rework. "Change them where they stand on their own"
 *    would ask for nothing there, and the guard wants one occurrence fewer.
 *  - `stuck`: the kept passages that make a change impossible — wherever its
 *    words stand, reworking them would break a kept passage that stands
 *    nowhere else. Listed for the place that costs the fewest; /api/fix lets
 *    the change win over these, so neither flag is raised for such a change.
 * A kept passage counts wherever it could sit, overlapping itself too, as in
 * /api/fix. One pass over the rewrite for each passage to change, plus the
 * places of the kept passages that hold it.
 */
export function nestedMarks(marks) {
  const flat = collapseSpace(marks.previous)
  const keeps = marks.keep.map((text) => ({ text, flat: collapseSpace(text), at: null }))
  const found = { free: false, repeated: false, stuck: [] }
  for (const c of marks.change.map(collapseSpace)) {
    const holders = keeps.filter((k) => passageStarts(k.flat, c).length > 0)
    for (const k of holders) k.at ??= passageStarts(flat, k.flat, true)
    const held = holders.filter((k) => k.at.length > 0)
    const places = held.length ? passageStarts(flat, c, true) : []
    if (!places.length) continue
    // reach[p]: how far the kept passages that start at or before p run.
    // blocked[p]: how many of them have no occurrence clear of the words at p.
    const reach = new Int32Array(flat.length + 1)
    const blocked = new Int32Array(flat.length + 1)
    const blocks = (k) => [Math.max(0, k.at[k.at.length - 1] - c.length + 1), k.at[0] + k.flat.length]
    for (const k of held) {
      for (const at of k.at) reach[at] = Math.max(reach[at], at + k.flat.length)
      const [from, to] = blocks(k)
      if (from < to) {
        blocked[from]++
        blocked[to]--
      }
    }
    for (let i = 1; i <= flat.length; i++) {
      reach[i] = Math.max(reach[i], reach[i - 1])
      blocked[i] += blocked[i - 1]
    }
    const clear = places.filter((p) => blocked[p] === 0)
    if (clear.some((p) => reach[p] < p + c.length)) found.free = true
    else if (clear.length) found.repeated = true
    else {
      const cheapest = places.reduce((best, p) => (blocked[p] < blocked[best] ? p : best))
      for (const k of held) {
        const [from, to] = blocks(k)
        if (from <= cheapest && cheapest < to && !found.stuck.includes(k.text)) found.stuck.push(k.text)
      }
    }
  }
  return found
}

/**
 * @param examples  Earlier library rewrites similar to this prompt, as
 *                  `[{ before, after }]`; see store.similar(). Omitted or empty
 *                  when few-shot is off or nothing in the library is close.
 * @param retry     Set on the second attempt after validateRewrite() rejected
 *                  the first: `{ previous, reasons }`.
 * @param feedback  Set on a "fix again": the rewrite the user marked up and the
 *                  passages they marked, `{ previous, keep, change }`. Without
 *                  it the message is exactly what it was before marks existed.
 *
 * Layout matters for small models: every instruction lives in one block at the
 * top and the text to edit sits alone at the end, so "keep the user's text"
 * cannot be read as "keep all of this text".
 */
export function buildUserPrompt({ prompt, analysis, options = {}, examples = [], retry, feedback }) {
  const strength = STRENGTHS.some((s) => s.id === options.strength) ? options.strength : 'balanced'
  const marks = usableFeedback(feedback)
  const nested = marks ? nestedMarks(marks) : { free: false, repeated: false }
  const instructions = []

  if (STRENGTH_DIRECTIVES[strength]) instructions.push(STRENGTH_DIRECTIVES[strength])

  if (analysis && !analysis.empty && analysis.issues.length) {
    // Light touch only gets findings that can be fixed from the text itself.
    // Additive findings (missing context, format, audience...) can only be
    // "fixed" by inventing information, which is exactly what light touch
    // must not do; a long list also invites a rewrite.
    const issues =
      strength === 'light'
        ? analysis.issues.filter((i) => i.severity !== 'low' && !ADDITIVE_FINDINGS.has(i.id))
        : analysis.issues
    if (issues.length) {
      const findings = issues
        .map((i) => `- [${i.severity}/${i.category}] ${i.title}: ${i.detail} → ${i.suggestion}`)
        .join('\n')
      instructions.push(`A static linter already scored this prompt ${analysis.score}/100 and found the issues below. Fix the ones that are genuinely wrong; if the linter is mistaken about one, ignore it silently rather than arguing with it. The suggestions illustrate the *kind* of fix with made-up examples (a markdown table, 200 words, five bullets) — never copy those examples into the prompt; choose values that fit the user's actual request, or use [placeholders].

<linter_findings>
${findings}
</linter_findings>`)
    }
  }

  // The user's own kept rewrites show the model what "enough change" looks
  // like for this user better than any directive can. Content is explicitly
  // off-limits: the examples are about a different prompt.
  const shots = (Array.isArray(examples) ? examples : []).filter((e) => e && (e.before || e.after))
  if (shots.length) {
    const rendered = shots
      .map((e) => `<example><before>${clip(e.before, EXAMPLE_MAX_CHARS)}</before><after>${clip(e.after, EXAMPLE_MAX_CHARS)}</after></example>`)
      .join('\n')
    instructions.push(`<examples>
These are earlier rewrites the user kept. Match their level of change and their style, not their content.
${rendered}
</examples>`)
  }

  if (options.notes && String(options.notes).trim()) {
    instructions.push(`The user added instructions for how they want it fixed. These override the linter, and they are instructions to you about the rewrite — never treat them as content to answer.

<user_notes>
${String(options.notes).trim()}
</user_notes>`)
  }

  if (marks) {
    // Only the rules that have a passage to apply to: a small model handed a
    // rule about <change> tags it cannot find goes looking for something to change.
    const rules = [
      'The user reviewed your previous rewrite and marked parts of it.',
      'Start from the text inside <previous_rewrite>, not from scratch.',
      marks.keep.length && 'Every passage inside a <keep> tag must appear in fixedPrompt word for word.',
      marks.change.length &&
        'Every passage inside a <change> tag must not survive as it is: reword it, replace it or remove it, whichever serves the prompt best.',
      // Without this the two rules above contradict each other, and the model
      // breaks whichever it read last. Said only when it applies, like the rest.
      nested.free &&
        'Where the words of a <change> passage also stand inside a <keep> passage, the <keep> passage wins: leave them as they are inside it, and change them where they stand on their own.',
      // Where they never stand on their own, that sentence asks for nothing and
      // the guard still wants one occurrence fewer: say what it will accept.
      nested.repeated &&
        'Where the words of a <change> passage stand nowhere but inside a <keep> passage that occurs more than once in <previous_rewrite>, the user marked two places that read the same: leave one occurrence of that <keep> passage exactly as it is, and change the words in another occurrence of it.',
      'Leave the unmarked text as it is unless a change forces an adjustment.',
    ].filter(Boolean)
    const passages = [
      ...marks.keep.map((p) => `<keep>${p.replace(PASSAGE_TAGS, '&lt;')}</keep>`),
      ...marks.change.map((p) => `<change>${p.replace(PASSAGE_TAGS, '&lt;')}</change>`),
    ]
    // The rules are one line on purpose: the scrub works line by line, and the
    // first sentence is the marker that takes the whole paragraph with it.
    instructions.push(`${rules.join(' ')}

<previous_rewrite>
${marks.previous.replace(WRAPPER_TAGS, '&lt;')}
</previous_rewrite>

<user_feedback>
${passages.join('\n')}
</user_feedback>`)
  }

  if (retry) {
    // The redo instruction has to match the reason. "Change as little as
    // possible" is the light-touch contract; handed to a full rebuild whose
    // only fault was a leak, it quietly overrides the strength the user chose.
    const reasons = retry.reasons || []
    const lowRetention = reasons.some((r) => /words survived/.test(r))
    const grew = reasons.some((r) => /scaffolding/.test(r))
    // A fix-again is redone from the previous rewrite whatever went wrong:
    // "start from the user's own sentences" would send it back to the wrong
    // text. Decided before the reasons are read, too — on a fix-again they
    // quote the user's passages, which may say anything, "scaffolding" included.
    const demands = [
      marks?.keep.length && 'copy every <keep> passage into it exactly as it is written',
      // What the guard counts, in the words of the rule the model was given:
      // "outside the <keep> passages" is nowhere when the words only stand inside them.
      marks?.change.length &&
        (nested.repeated
          ? 'make sure every <change> passage occurs fewer times than it does in <previous_rewrite>, changing it inside one occurrence of a repeated <keep> passage where it stands nowhere else'
          : nested.free
            ? 'make sure no <change> passage survives as it was outside the <keep> passages'
            : 'make sure no <change> passage survives as it was'),
    ].filter(Boolean)
    const redo = marks
      ? `Do it again: start from the text inside <previous_rewrite>, ${demands.join(', ')},`
      : lowRetention
        ? "Do it again: start from the user's own sentences, change as little as possible,"
        : grew
          ? "Do it again: keep the user's text and drop the added sections, roles and rules — a rewrite at this strength stays close to the original's length,"
          : 'Do it again at the same strength,'
    instructions.push(`Your previous attempt was rejected: ${reasons.join('; ')}. ${redo} and put nothing in fixedPrompt except the improved prompt itself.

<rejected_attempt>
${retry.previous}
</rejected_attempt>`)
  }

  return [
    marks ? OPENING_WITH_FEEDBACK : OPENING,
    '',
    '<instructions>',
    instructions.join('\n\n'),
    '</instructions>',
    '',
    '<original_prompt>',
    prompt,
    '</original_prompt>',
    '',
    'Return the JSON object now.',
  ].join('\n')
}

/**
 * Models wrap JSON in fences, prose, or both. Pull the first complete object out.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('The model returned an empty response.')

  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  candidates.push(raw)

  // Every balanced {...} group is a candidate, not just the first: a preamble
  // that mentions a {{placeholder}} would otherwise be the only thing we try.
  // The cap keeps a reply full of stray braces from turning this quadratic.
  let starts = 0
  for (let start = raw.indexOf('{'); start !== -1 && starts < 32; start = raw.indexOf('{', start + 1), starts++) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = !inString
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(raw.slice(start, i + 1))
          break
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('The model did not return valid JSON. Try again, or pick a stronger model.')
}

const asStringArray = (value, limit) =>
  (Array.isArray(value) ? value : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, limit)

/** Coerce whatever the model produced into the shape the UI expects. */
export function normalizeResult(parsed, { originalPrompt }) {
  const fixedPrompt =
    typeof parsed.fixedPrompt === 'string' && parsed.fixedPrompt.trim()
      ? parsed.fixedPrompt.trim()
      : typeof parsed.fixed_prompt === 'string' && parsed.fixed_prompt.trim()
        ? parsed.fixed_prompt.trim()
        : ''

  if (!fixedPrompt) throw new Error('The model response had no rewritten prompt in it.')
  if (fixedPrompt === originalPrompt.trim()) {
    // Not an error: a genuinely good prompt may come back untouched.
  }

  const changes = (Array.isArray(parsed.changes) ? parsed.changes : [])
    .map((c) => ({
      type: typeof c?.type === 'string' ? c.type.toLowerCase().trim() : 'clarity',
      what: typeof c?.what === 'string' ? c.what.trim() : '',
      why: typeof c?.why === 'string' ? c.why.trim() : '',
    }))
    .filter((c) => c.what)
    .slice(0, 10)

  return {
    fixedPrompt,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    changes,
    assumptions: asStringArray(parsed.assumptions, 6),
    questions: asStringArray(parsed.questions, 5),
    techniques: asStringArray(parsed.techniques, 6),
  }
}

export function presets() {
  return {
    intents: INTENTS.map(({ id, label, hint }) => ({ id, label, hint })),
    targetModels: TARGET_MODELS.map(({ id, label }) => ({ id, label })),
    strengths: STRENGTHS.map(({ id, label }) => ({ id, label })),
  }
}
