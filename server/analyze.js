/**
 * Deterministic prompt linter.
 *
 * Runs entirely locally (no model call) and produces a category-weighted score
 * plus a list of concrete, actionable issues. The findings are also fed to the
 * rewriting model so the AI pass and the linter agree on what is wrong.
 */

export const CATEGORIES = {
  clarity: { label: 'Clarity', weight: 25, blurb: 'Is the ask unambiguous?' },
  specificity: { label: 'Specificity', weight: 25, blurb: 'Is it concrete enough to act on?' },
  context: { label: 'Context', weight: 15, blurb: 'Does the model have what it needs?' },
  format: { label: 'Format & limits', weight: 20, blurb: 'Is the output shape defined?' },
  structure: { label: 'Structure', weight: 15, blurb: 'Is it organised and scoped?' },
}

const SEVERITY_PENALTY = { high: 45, medium: 22, low: 9 }

const TASK_VERBS = [
  'use', 'write', 'create', 'analyze', 'analyse', 'summarize', 'summarise', 'translate',
  'explain', 'list', 'compare', 'generate', 'review', 'fix', 'refactor', 'design',
  'build', 'plan', 'draft', 'extract', 'classify', 'rewrite', 'optimize', 'optimise',
  'debug', 'test', 'document', 'convert', 'evaluate', 'critique', 'brainstorm',
  'outline', 'implement', 'describe', 'identify', 'calculate', 'suggest', 'recommend',
  'give', 'help', 'tell', 'show', 'return', 'make', 'improve', 'edit', 'proofread',
  'answer', 'find', 'check', 'produce', 'provide',
]

// Past forms that no suffix rule reaches. Regular inflections are derived.
const IRREGULAR_VERB_FORMS = {
  write: 'wrote|written', rewrite: 'rewrote|rewritten', give: 'gave|given', make: 'made',
  tell: 'told', show: 'shown', find: 'found', build: 'built',
}

/**
 * Every inflection of a task verb as one regex source: "summarize" also
 * matches summarizing/summarized, "plan" matches planning, "identify"
 * matches identifies/identified. The bare-suffix matcher this replaces only
 * saw forms where the stem is unchanged, so "writing" was invisible.
 */
function verbFormsSource(verb) {
  const stem = verb.endsWith('e') ? verb.slice(0, -1) : verb
  const last = stem[stem.length - 1]
  // Consonant doubling (plan -> planning) is optional so "editing" still works.
  const doubled = /[aeiou]/.test(last) ? '' : `${last}?`
  const forms = [`${verb}(?:s|es|d|ed)?`, `${stem}${doubled}(?:ing|ed)`]
  if (/[^aeiou]y$/.test(verb)) forms.push(`${verb.slice(0, -1)}(?:ies|ied)`)
  if (IRREGULAR_VERB_FORMS[verb]) forms.push(IRREGULAR_VERB_FORMS[verb])
  return `(?:${forms.join('|')})`
}

const TASK_VERB_PATTERNS = TASK_VERBS.map((verb) => ({
  verb,
  any: new RegExp(`\\b${verbFormsSource(verb)}\\b`, 'i'),
  all: new RegExp(`\\b${verbFormsSource(verb)}\\b`, 'gi'),
}))

// Preceded by a determiner, possessive or preposition (allowing one modifier)
// a verb-shaped word is a noun: "the design", "unit tests", "in this document".
const NOUN_POSITION =
  /\b(?:the|a|an|this|that|these|those|my|our|your|their|its|of|in|on|for|with|from|each|every|any|all|per|unit|no)(?:\s+[\w'-]+)?\s+$/i

/** True when at least one occurrence of the verb reads as an instruction. */
function isAsk(lower, pattern) {
  pattern.all.lastIndex = 0
  let match
  while ((match = pattern.all.exec(lower))) {
    if (!NOUN_POSITION.test(lower.slice(Math.max(0, match.index - 40), match.index))) return true
  }
  return false
}

/** Verbs that only earn their keep when a perspective narrows the judgement. */
const JUDGEMENT_VERBS = /\b(?:review(?:s|ed|ing)?|critique[sd]?|critiquing|evaluat(?:e|es|ed|ing)|assess(?:es|ed|ing)?|audit(?:s|ed|ing)?|grade[sd]?|grading|judge[sd]?|judging|advise|advice|recommend(?:s|ed|ing|ations?)?|feedback|opinion|second opinion)\b/i

const VAGUE_TERMS = [
  'some', 'a few', 'several', 'a couple', 'good', 'nice', 'better', 'best',
  'proper', 'appropriate', 'reasonable', 'etc', 'and so on', 'stuff', 'somehow',
  'a bit', 'kind of', 'sort of', 'fairly', 'various', 'optimal', 'modern',
  'clean', 'professional', 'high quality', 'user friendly', 'relevant',
]

const QUALITY_HANDWAVES = [
  'be creative', 'think outside the box', 'make it pop', 'do your best',
  'be smart', 'use your judgement', 'use your judgment', 'as you see fit',
  'be professional', 'make it good', 'make it amazing', 'world class',
  'world-class', 'best practices', 'blow my mind', 'make it perfect',
  'be thorough', 'go deep',
]

const CONFLICT_PAIRS = [
  [
    ['brief', 'concise', 'short', 'terse'],
    ['comprehensive', 'exhaustive', 'in-depth', 'in depth', 'detailed', 'thorough', 'as much detail'],
  ],
  [
    ['simple', 'beginner', 'eli5', 'plain language'],
    ['advanced', 'technical deep dive', 'expert-level', 'rigorous'],
  ],
  [
    ['formal', 'professional tone'],
    ['casual', 'funny', 'playful', 'informal'],
  ],
  [
    ['bullet points', 'bullets'],
    ['prose', 'paragraph form', 'essay'],
  ],
]

const rx = {
  format: /\b(json|yaml|xml|markdown|md|csv|tsv|html|table|bullet|numbered list|list|format(?:ted)?|schema|template|paragraphs?|sentences?|code block|diff|headings?)\b/i,
  // A bound is a count with a unit ("150-word", "three bullets", "5 rows"), a
  // comparative ("at most", "under 200"), or a scope phrase ("return only the
  // changed function", "no commentary"). Hyphenated and number-word forms count.
  limits:
    /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty|hundred)[-\s]*(?:words?|sentences?|paragraphs?|bullets?|bullet[-\s]?points?|points?|items?|lines?|characters?|chars?|pages?|slides?|examples?|options?|ideas?|rows?|columns?|sections?|steps?|cases?|tokens?|minutes?|entries|reasons?|risks?|issues?|findings?|recommendations?|questions?|suggestions?|tips?|ways|strategies|actions?|tasks?|features?|changes?|bugs?|tests?|files?|functions?|headlines?|titles?|names?|variations?|versions?|alternatives?)|under \d+|at most|no more than|max(?:imum)?|at least|up to \d+|between \d+|word limit|brief|concise|short|detailed|in-depth|return only|only (?:the|return|output|include)|no (?:commentary|explanations?|preamble|prose|extra text)|code only|nothing else)\b/i,
  audience: /\b(audience|for (?:beginners?|experts?|developers?|engineers?|kids|children|students?|executives?|managers?|non-?technical)|reader|layman|eli5|5th grade|junior|senior|stakeholders?)\b/i,
  context: /\b(context|background|we are|we're|i am|i'm|our |my (?:team|company|project|app|codebase|client|blog)|given|based on|the following|assume|currently|constraints?|tech stack)\b/i,
  // `example.com`-style domains are not examples of anything.
  examples: /\b(examples?(?!\.(?:com|org|net)\b)|e\.g\.|for instance|such as|sample|like this|few-?shot|reference implementation)\b/i,
  criteria: /\b(must|should|require[ds]?|criteria|ensure|constraints?|rules?|acceptance|valid|only if|do not include|avoid|make sure|needs to|has to)\b/i,
  role: /\b(you are|you're an?|act as|acting as|as an? (?:expert|experienced|senior|professional)|your role|assume the role|imagine you)\b/i,
  // A URL is source material too: the model is told where to look.
  grounding: /\b(provided|attached|below|above|from the (?:text|document|data|article|code)|only use|based (?:only )?on|do not invent|if you (?:don'?t|do not) know)\b|https?:\/\//i,
  // Bare "source", "reference" and "quote" are everyday engineering words
  // (source maps, single quotes, a reference implementation), so the nouns
  // only count when phrased as a request for evidence.
  citations: /\b(cite|citations?|according to|peer[- ]reviewed|(?:sources?|references?|statistics|stats|studies|papers?|quotes?|figures|evidence) (?:on|about|for|from|to (?:back|support|prove)|showing|supporting|that (?:show|support|prove))|(?:academic|scholarly|scientific|research|credible|reliable|real|verified) (?:sources?|papers?|studies|references?|statistics|stats|quotes?)|(?:with|include|add|provide|list) (?:the )?(?:sources?|references?|citations?|statistics|stats|studies)(?! (?:maps?|code|files?|control|trees?|folders?|branch|strings?|of truth|implementations?|counts?|tables?))|research (?:shows|says|suggests)|studies show)\b/i,
  urls: /https?:\/\/\S+/g,
  timeRelative: /\b(latest|current|currently|today|nowadays|right now|recent(?:ly)?|up[- ]to[- ]date|this (?:year|month|week)|state of the art)\b/i,
  hardDate: /\b(?:19|20)\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/,
  referencedInput: /\b(?:the )?(?:text|code|article|data|document|email|file|content|transcript|paragraph|snippet|list)\s+(?:below|above|attached|provided|that follows)\b|\bas follows\b/i,
  // Tag pairs are checked separately in hasDelimiter(): as a single regex the
  // `<tag>[\s\S]*</tag>` form backtracks quadratically on unclosed tags.
  delimiter: /```|~~~|"""|^-{3,}$|^={3,}$/m,
  openTag: /<[a-z][\w-]*>/,
  closeTag: /<\/[a-z][\w-]*>/,
  placeholders: /\[(?:insert|your|add|todo|xxx|tbd|name|topic|text|company|product)\b[^\]]*\]|\{\{[^}]*\}\}|<(?:your|insert|todo)[^>]*>|\b(?:TODO|TBD|XXX|FIXME)\b/,
  // Any lowercase bracketed phrase — [target audience], [next step], [date].
  // Case-sensitive on purpose so log tags like [ERROR] don't count; the
  // trailing lookahead skips markdown links; digits-only ([1]) never match.
  bracketSlots: /\[[a-z][a-z0-9 _/'-]{1,40}\](?!\()/g,
  intensifiers: /\b(?:very|really|extremely|super|totally|absolutely|highly|incredibly)\b/gi,
  negations: /\b(?:don'?t|do not|never|avoid|shouldn'?t|must not|without)\b/gi,
  absolutes: /\b(?:100% accurate|perfect(?:ly)?|guaranteed?|flawless|always correct|zero errors|bug-?free)\b/i,
  filler: /\b(?:could you please|would you please|i was wondering|if possible|if you can|maybe you (?:can|could)|kindly|just|simply|basically|obviously)\b/i,
  greeting: /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|greetings|yo)\b[\s,!.]*/i,
  structureMarks: /^\s*(?:[-*+•]|\d+[.)]|#{1,6}\s|<[a-z][\w-]*>)/m,
  markdownish: /^#{1,6}\s|\*\*[^*]+\*\*/m,
  reasoning: /\b(?:step[- ]by[- ]step|think(?:ing)? through|reason(?:ing)?|explain your (?:reasoning|thinking)|show your work)\b/i,
}

function countMatches(text, regex) {
  const m = text.match(regex)
  return m ? m.length : 0
}

function uniq(arr) {
  return [...new Set(arr)]
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findTerms(lower, terms) {
  const hits = []
  for (const term of terms) {
    const pattern = new RegExp(`(?:^|[^\\w-])${escapeRe(term)}(?:[^\\w-]|$)`, 'i')
    if (pattern.test(lower)) hits.push(term)
  }
  return hits
}

/** A fence, a rule line, or an opening tag with a closing tag somewhere after it. */
function hasDelimiter(text) {
  if (rx.delimiter.test(text)) return true
  const open = text.search(rx.openTag)
  return open !== -1 && rx.closeTag.test(text.slice(open))
}

/**
 * The prompt with code and markdown syntax removed, for the wording rules. A
 * TODO inside a code block, an ALL_CAPS constant or a "- [x]" checkbox is
 * content the model is meant to see, not a defect in the instructions.
 * Structure rules still read the full text.
 */
function toProse(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[(?: |x|X)\]/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}|_{2,3}/g, '')
}

// Upper-case words that are names of things, not shouting.
const ACRONYMS = new Set([
  'JSON', 'YAML', 'XML', 'HTML', 'CSS', 'CSV', 'TSV', 'SQL', 'API', 'APIS', 'URL', 'URLS', 'URI',
  'PDF', 'ISO', 'UTC', 'REST', 'HTTP', 'HTTPS', 'ID', 'IDS', 'UUID', 'CLI', 'SDK', 'UI', 'UX',
  'AI', 'LLM', 'LLMS', 'OK', 'USA', 'UK', 'EU', 'GDPR', 'CEO', 'CTO', 'SEO', 'FAQ', 'PR', 'CI',
  'CD', 'AWS', 'GCP', 'IDE', 'OS', 'RAM', 'CPU', 'GPU', 'SVG', 'PNG', 'JPG', 'GIF', 'MD',
])

// "in prose, not bullet points" resolves a choice rather than making two, and
// "short story" is a genre, not a length. Both used to count as conflicts.
const NEGATION_BEFORE = /\b(?:not|no|never|avoid|without|instead of|rather than|than|don'?t|do not|isn'?t|aren'?t|no longer)\b(?:\s+[\w'-]+){0,2}[\s,]*$/
const CONFLICT_COMPOUNDS =
  /\bshort(?:er|est)? (?:stor(?:y|ies)|films?|answers?|forms?|circuits?|terms?|cuts?|hands?|lists?)\b|\bin (?:short|brief),|\b(?:design|creative|project|client) briefs?\b|\bbriefings?\b|\bsimple (?:present|past|future)\b|\bplain(?:text| text)\b/gi

/**
 * Terms from `terms` that occur in `lower` outside a compound noun and not
 * within three words after a negation or preference marker.
 */
function conflictHits(lower, terms) {
  const cleaned = lower.replace(CONFLICT_COMPOUNDS, ' ')
  const hits = []
  for (const term of terms) {
    const pattern = new RegExp(`(?:^|[^\\w-])${escapeRe(term)}(?=[^\\w-]|$)`, 'gi')
    let match
    while ((match = pattern.exec(cleaned))) {
      const before = cleaned.slice(Math.max(0, match.index - 40), match.index + 1)
      if (!NEGATION_BEFORE.test(before)) {
        hits.push(term)
        break
      }
    }
  }
  return hits
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4))
}

/**
 * @param {string} rawPrompt
 * @param {{ intent?: string, rewrite?: boolean, addRole?: boolean, includeExample?: boolean }} [options]
 *   `rewrite: true` when scoring a rewrite the tool produced (placeholders become a
 *   reminder, not a defect); `addRole` / `includeExample` mirror the fix options and
 *   make the matching absence a finding.
 */
export function analyzePrompt(rawPrompt, options = {}) {
  const text = String(rawPrompt ?? '').trim()
  const lower = text.toLowerCase()
  const words = text.match(/[\p{L}\p{N}'’-]+/gu) || []
  const wordCount = words.length
  const lines = text.split(/\r?\n/)
  const sentences = text
    .split(/(?<=[.!?])[\s\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  // Wording rules read the prose only; a list item or a code line is not a
  // sentence, so those also break on newlines.
  const prose = toProse(text)
  const proseLower = prose.toLowerCase()
  const proseWords = prose.match(/[\p{L}\p{N}'’_-]+/gu) || []
  const proseSentences = prose
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const intent = options.intent || 'general'
  // An image prompt is a descriptor list, not an instruction: the rules that
  // presuppose a verb, a reader, a format or sentences do not apply, and their
  // suggestions would contradict the rewrite guidance for that intent.
  const instructionShaped = intent !== 'image'

  const issues = []
  const strengths = []
  const add = (issue) => issues.push(issue)

  if (!text) {
    return {
      empty: true,
      score: 0,
      grade: 'F',
      categories: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0])),
      issues: [
        {
          id: 'empty',
          title: 'Prompt is empty',
          category: 'clarity',
          severity: 'high',
          detail: 'There is nothing to analyse yet.',
          suggestion: 'Write what you want the model to do, then run the fixer.',
          evidence: [],
        },
      ],
      strengths: [],
      stats: { words: 0, sentences: 0, lines: 0, characters: 0, estimatedTokens: 0 },
    }
  }

  // --- length ---------------------------------------------------------------
  if (wordCount < 12) {
    add({
      id: 'too-short',
      title: 'Prompt is very short',
      category: 'specificity',
      // Steps down before it switches off at 12 words, so one added word never
      // swings the score by a whole high-severity penalty.
      severity: wordCount <= 7 ? 'high' : 'medium',
      detail: `Only ${wordCount} word${wordCount === 1 ? '' : 's'}. The model has to guess your goal, audience, depth and output shape.`,
      suggestion: 'State the goal, who it is for, what to include, and the output format.',
      evidence: [],
    })
  } else if (wordCount < 30) {
    add({
      id: 'short',
      title: 'Prompt is thin on detail',
      category: 'specificity',
      severity: 'low',
      detail: `${wordCount} words. Usable, but a lot is left to the model's default assumptions.`,
      suggestion: 'Add the constraints that actually matter to you, so you do not have to iterate.',
      evidence: [],
    })
  } else if (wordCount >= 60) {
    strengths.push('Enough detail to work with')
  }

  // --- vague wording --------------------------------------------------------
  const vagueHits = findTerms(proseLower, VAGUE_TERMS)
  if (vagueHits.length) {
    add({
      id: 'vague-terms',
      title: 'Vague wording the model must interpret',
      category: 'specificity',
      severity: vagueHits.length >= 3 ? 'medium' : 'low',
      detail: `Words like these mean something different to you than to the model: ${vagueHits.slice(0, 6).join(', ')}.`,
      suggestion: 'Replace each one with a number, a name, or a concrete criterion.',
      evidence: vagueHits.slice(0, 8),
    })
  }

  const handwaveHits = findTerms(lower, QUALITY_HANDWAVES)
  if (handwaveHits.length) {
    add({
      id: 'quality-handwave',
      title: 'Quality asked for as a vibe, not a criterion',
      category: 'specificity',
      severity: 'medium',
      detail: `"${handwaveHits[0]}" does not tell the model what to change, so it mostly just adds words.`,
      suggestion:
        'Describe the observable property you want instead: "no sentence over 20 words" beats "be concise and professional".',
      evidence: handwaveHits.slice(0, 5),
    })
  }

  // --- output format & limits ----------------------------------------------
  if (!rx.format.test(text) && instructionShaped) {
    add({
      id: 'no-format',
      title: 'No output format specified',
      category: 'format',
      severity: 'medium',
      detail: 'Nothing says whether you want prose, a table, JSON, bullets or code.',
      suggestion:
        'State the shape you want back: prose, bullets, a table with named columns, JSON with named keys, or code only.',
      evidence: [],
    })
  } else {
    strengths.push('Output format is stated')
  }

  if (!rx.limits.test(text)) {
    // A word count only makes sense for free-form prose. For code, agents,
    // extraction and image prompts the useful bound is *scope*, and it is a
    // nicety rather than a defect — otherwise every rewrite gets "at most 200
    // words" bolted on, which is what users complained about.
    const proseIntent = intent === 'writing' || intent === 'analysis' || intent === 'general'
    add({
      id: 'no-limits',
      title: proseIntent ? 'No length or scope limit' : 'No scope limit',
      category: 'format',
      severity: proseIntent && wordCount >= 12 ? 'medium' : 'low',
      detail: proseIntent
        ? 'Without a bound the model picks its own length, which is usually longer than you wanted.'
        : 'A scope bound keeps the answer to the part you actually want changed or produced.',
      suggestion: proseIntent
        ? 'Bound it in the unit that fits the task: a word count, a number of bullets or sections, or a reading time.'
        : 'Bound the scope, not the words: "return only the changed function", "one row per file", "no commentary".',
      evidence: [],
    })
  } else {
    strengths.push('Length or scope is bounded')
  }

  if (!rx.criteria.test(text) && wordCount > 20 && instructionShaped) {
    add({
      id: 'no-criteria',
      title: 'No success criteria or constraints',
      category: 'format',
      severity: 'low',
      detail: 'There is no way for the model, or for you, to tell whether the answer is correct.',
      suggestion: 'Add a short Requirements list, and say what must not appear in the answer.',
      evidence: [],
    })
  }

  // --- context --------------------------------------------------------------
  if (!rx.context.test(text) && wordCount > 15) {
    add({
      id: 'no-context',
      title: 'No background or context',
      category: 'context',
      severity: 'medium',
      detail: 'The model does not know your situation, so it answers for a generic average case.',
      suggestion:
        'Add a line or two of context: who you are, what already exists, and what this output feeds into.',
      evidence: [],
    })
  } else if (rx.context.test(text)) {
    strengths.push('Includes situational context')
  }

  if (!rx.audience.test(text) && wordCount > 25 && intent !== 'code' && instructionShaped) {
    add({
      id: 'no-audience',
      title: 'Audience not identified',
      category: 'context',
      severity: 'low',
      detail: 'Reading level, jargon and framing all hinge on who this is for.',
      suggestion: 'Name the reader: their role and how technical they are.',
      evidence: [],
    })
  }

  const refMatch = text.match(rx.referencedInput)
  if (refMatch && !hasDelimiter(text)) {
    // "Summarize the text below:" followed by the pasted paragraphs is the
    // most common prompt shape there is. The input is present; what is
    // missing is only the fence, and that is a minor structure point, not
    // missing context.
    // Pasted input starts on a new line or after a colon. The rest of the
    // sentence that mentions "the transcript below" is still instruction —
    // "…below and tell me what the main problems are" is not the transcript.
    const afterRef = text.slice(refMatch.index + refMatch[0].length)
    const boundary = afterRef.search(/\r?\n|^\s*:/)
    const trailingWords = boundary === -1 ? 0 : (afterRef.slice(boundary).match(/\S+/g) || []).length
    if (trailingWords >= 15) {
      add({
        id: 'undelimited-input',
        title: 'Pasted input is not delimited',
        category: 'structure',
        severity: 'low',
        detail: 'The input is present, but nothing separates it from the instructions.',
        suggestion:
          'Wrap the pasted text in a fence or tag so the model can tell instructions from data, e.g. <document> ... </document>.',
        evidence: [refMatch[0].trim()],
      })
    } else {
      add({
        id: 'missing-input',
        title: 'References input that is not clearly attached',
        category: 'context',
        severity: 'high',
        detail: 'The prompt points at text below or attached, but there is no delimited block holding it.',
        suggestion:
          'Wrap the input in a fence or tag so the model can tell instructions from data, e.g. <document> ... </document>.',
        evidence: [refMatch[0].trim()],
      })
    }
  }

  // Code prompts talk about sources, references and quotes as things in the
  // code; a URL in any prompt is the grounding the rule is asking for.
  if (intent !== 'code' && rx.citations.test(text.replace(rx.urls, ' ')) && !rx.grounding.test(text)) {
    add({
      id: 'ungrounded-facts',
      title: 'Asks for facts or sources with nothing to ground them',
      category: 'context',
      severity: 'medium',
      detail:
        'Requesting citations or statistics without supplying source material is the fastest route to fabricated references.',
      suggestion:
        'Either paste the source material, or add: "Only use facts from the provided text; if it is not there, say so."',
      evidence: [],
    })
  }

  if (rx.timeRelative.test(text) && !rx.hardDate.test(text)) {
    add({
      id: 'time-relative',
      title: 'Time-relative wording with no fixed date',
      category: 'context',
      severity: 'low',
      detail: 'Latest and current resolve against the model training cutoff, not against today.',
      suggestion: 'Pin an explicit date, or state what counts as current.',
      evidence: uniq(
        (text.match(new RegExp(rx.timeRelative.source, 'gi')) || []).map((s) => s.toLowerCase())
      ).slice(0, 4),
    })
  }

  // The rewrite is told not to add examples reflexively, so the absence is
  // only reported where one demonstrably pays off: structured output, a
  // system prompt, or a tone or style that is easier shown than described.
  const exampleHelps =
    options.includeExample ||
    intent === 'extraction' ||
    intent === 'agent' ||
    /\b(?:tone|voice|style|in the style of|schema|template|match(?:ing)? (?:the|our|my))\b/i.test(text)
  if (!rx.examples.test(text) && wordCount > 30 && exampleHelps) {
    add({
      id: 'no-examples',
      title: 'No example of what good looks like',
      category: 'specificity',
      severity: 'low',
      detail: 'For this kind of output one example pins down tone, depth and format faster than a paragraph of description.',
      suggestion: 'If the shape or tone is hard to describe, show one short sample; a precise description is fine otherwise.',
      evidence: [],
    })
  } else if (rx.examples.test(text)) {
    strengths.push('Gives examples or references')
  }

  // --- clarity --------------------------------------------------------------
  for (const [aList, bList] of CONFLICT_PAIRS) {
    const a = conflictHits(lower, aList)
    const b = conflictHits(lower, bList)
    if (a.length && b.length) {
      add({
        id: `conflict-${a[0].replace(/\s+/g, '-')}`,
        title: 'Conflicting instructions',
        category: 'clarity',
        severity: 'high',
        detail: `You ask for "${a[0]}" and "${b[0]}" in the same prompt. The model will silently pick one.`,
        suggestion: 'Drop one, or say which wins when they collide.',
        evidence: [a[0], b[0]],
      })
    }
  }

  const danglingRefs = uniq(
    (text.match(/(?:^|[.!?]\s+)(?:it|this|that|they|these|those)\b/gi) || []).map((s) =>
      s.trim().replace(/^[.!?]\s*/, '')
    )
  )
  if (danglingRefs.length >= 2) {
    add({
      id: 'ambiguous-reference',
      title: 'Sentences start with an unanchored pronoun',
      category: 'clarity',
      severity: 'low',
      detail: `"${danglingRefs[0]}" opens a sentence without a clear referent, and that compounds over a long prompt.`,
      suggestion: 'Name the thing instead of pointing at it.',
      evidence: danglingRefs.slice(0, 4),
    })
  }

  const found = uniq([
    ...(prose.match(new RegExp(rx.placeholders.source, 'gi')) || []),
    ...(prose.match(rx.bracketSlots) || []),
  ])
    // {{variables}} are the recommended way to write a system prompt's inputs.
    .filter((p) => !(intent === 'agent' && p.startsWith('{{')))
    .slice(0, 5)
  if (found.length) {
    if (options.rewrite) {
      // A rewrite deliberately marks what it could not know instead of
      // inventing it. That is the right behaviour, so here it is a reminder,
      // not a defect — otherwise the after-score punishes honesty.
      add({
        id: 'placeholders',
        title: 'Placeholders to fill in before use',
        category: 'clarity',
        severity: 'low',
        detail: 'The rewrite marked details it could not know rather than inventing them.',
        suggestion: 'Fill each one in, or delete the sentence if that detail does not matter.',
        evidence: found,
      })
    } else {
      add({
        id: 'placeholders',
        title: 'Unfilled placeholders left in the prompt',
        category: 'clarity',
        severity: 'high',
        detail: 'Template slots like [insert topic] or TODO get taken literally and end up in the output.',
        suggestion: 'Fill every placeholder, or make it an explicit variable you substitute in code.',
        evidence: found,
      })
    }
  }

  const shoutyWords = proseWords.filter(
    (w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w) && !ACRONYMS.has(w) && !w.includes('_')
  )
  if (shoutyWords.length > 4 || countMatches(prose, /!{2,}/g) > 0) {
    add({
      id: 'shouting',
      title: 'Emphasis by shouting',
      category: 'clarity',
      severity: 'low',
      detail: 'Caps and repeated exclamation marks do not increase compliance; a clearly stated hard rule does.',
      suggestion: 'Move the important part into a numbered Requirements list.',
      evidence: uniq(shoutyWords).slice(0, 5),
    })
  }

  if (rx.filler.test(prose)) {
    add({
      id: 'filler',
      title: 'Filler and hedging language',
      category: 'clarity',
      severity: 'low',
      detail: 'Softeners like "if possible", "just" or "kindly" add tokens and weaken the instruction.',
      suggestion: 'Use direct imperatives. Politeness costs you precision here.',
      evidence: uniq(
        (prose.match(new RegExp(rx.filler.source, 'gi')) || []).map((s) => s.toLowerCase())
      ).slice(0, 5),
    })
  }

  if (rx.greeting.test(text)) {
    add({
      id: 'greeting',
      title: 'Conversational opener',
      category: 'clarity',
      severity: 'low',
      detail: 'A greeting at the top of a reusable prompt is dead weight.',
      suggestion: 'Start with the instruction.',
      evidence: [(text.match(rx.greeting) || [''])[0].trim()].filter(Boolean),
    })
  }

  const intensifierCount = countMatches(prose, rx.intensifiers)
  if (intensifierCount >= 3) {
    add({
      id: 'intensifiers',
      title: 'Intensifiers instead of specifics',
      category: 'specificity',
      severity: 'low',
      detail: `${intensifierCount} uses of words like "very" or "really". They signal emphasis without adding information.`,
      suggestion: 'Swap each for the actual threshold you have in mind.',
      evidence: uniq((prose.match(rx.intensifiers) || []).map((s) => s.toLowerCase())).slice(0, 5),
    })
  }

  if (rx.absolutes.test(prose)) {
    add({
      id: 'absolutes',
      title: 'Unachievable guarantee requested',
      category: 'specificity',
      severity: 'low',
      detail:
        'Demanding "100% accurate" or "perfect" output does not change reliability, but it does encourage confident-sounding wrong answers.',
      suggestion: 'Ask for verifiable behaviour: "flag anything you are unsure about rather than guessing".',
      evidence: [(prose.match(rx.absolutes) || [''])[0]].filter(Boolean),
    })
  }

  // A comma-separated descriptor list is the right shape for an image prompt.
  const longSentence = instructionShaped && proseSentences.find((s) => (s.match(/\S+/g) || []).length > 45)
  if (longSentence) {
    add({
      id: 'run-on',
      title: 'Run-on sentence',
      category: 'clarity',
      severity: 'low',
      detail: 'One sentence runs past 45 words. Instructions buried mid-sentence get dropped.',
      suggestion: 'Break it into one instruction per line.',
      evidence: [longSentence.slice(0, 120) + (longSentence.length > 120 ? '…' : '')],
    })
  }

  const negationCount = countMatches(text, rx.negations)
  if (negationCount >= 3) {
    add({
      id: 'negative-only',
      title: 'Mostly negative constraints',
      category: 'clarity',
      severity: 'low',
      detail: `${negationCount} don't / never / avoid style rules. Telling the model what to avoid leaves the target undefined.`,
      suggestion: 'Pair each prohibition with the positive behaviour you want instead.',
      evidence: uniq((text.match(rx.negations) || []).map((s) => s.toLowerCase())).slice(0, 5),
    })
  }

  // --- structure ------------------------------------------------------------
  const verbsUsed = TASK_VERB_PATTERNS.filter((p) => p.any.test(lower)).map((p) => p.verb)
  // Only verbs in an instruction position count as separate asks; "the
  // design" or "unit tests" is a noun that happens to share the spelling.
  const asksMade = TASK_VERB_PATTERNS.filter((p) => isAsk(lower, p)).map((p) => p.verb)
  if (asksMade.length >= 4) {
    add({
      id: 'multi-task',
      title: 'Several distinct tasks in one prompt',
      category: 'structure',
      severity: 'medium',
      detail: `Detected ${asksMade.length} different asks (${asksMade.slice(0, 5).join(', ')}). Quality drops on the later ones.`,
      suggestion: 'Keep one primary task per prompt, or number the steps and state the order explicitly.',
      evidence: asksMade.slice(0, 6),
    })
  }
  if (verbsUsed.length === 0 && instructionShaped) {
    add({
      id: 'no-task-verb',
      title: 'No clear action requested',
      category: 'clarity',
      severity: 'high',
      detail: 'No recognisable instruction verb, so it is unclear what the model should produce.',
      suggestion: 'Open with the verb: Write..., Extract..., Compare...',
      evidence: [],
    })
  }

  if (wordCount > 110 && !rx.structureMarks.test(text) && lines.filter((l) => l.trim()).length < 4) {
    add({
      id: 'unstructured',
      title: 'Long prompt with no structure',
      category: 'structure',
      severity: 'high',
      detail: `${wordCount} words in a solid block. Requirements in the middle are the ones that get ignored.`,
      suggestion: 'Split into labelled sections (Context, Task, Requirements, Output format) or XML-style tags.',
      evidence: [],
    })
  } else if (rx.structureMarks.test(text) || rx.markdownish.test(text)) {
    strengths.push('Uses lists or headings')
  }

  // Same reasoning as no-examples: the rewrite is told not to add a role
  // reflexively, so it is only reported where a perspective changes the
  // answer — a system prompt, or a judgement call such as a review.
  const roleHelps = options.addRole || intent === 'agent' || JUDGEMENT_VERBS.test(text)
  if (!rx.role.test(text) && wordCount > 25 && roleHelps && instructionShaped) {
    add({
      id: 'no-role',
      title: 'No role or perspective set',
      category: 'structure',
      severity: 'low',
      detail:
        'A judgement like this depends on who is judging: "a staff engineer reviewing for maintainability" gives a different answer from "a security auditor".',
      suggestion: 'If a particular perspective should shape the answer, name it in one line; otherwise leave it out.',
      evidence: [],
    })
  } else if (rx.role.test(text)) {
    strengths.push('Sets a role or perspective')
  }

  const seen = new Map()
  for (const s of proseSentences) {
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    if (key.length < 12) continue
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1)
  if (dupes.length) {
    add({
      id: 'repetition',
      title: 'Repeated instruction',
      category: 'structure',
      severity: 'low',
      detail: 'The same sentence appears more than once.',
      suggestion: 'Say it once, in the requirements list.',
      evidence: dupes.slice(0, 3).map(([k]) => k.slice(0, 80)),
    })
  }

  if (rx.reasoning.test(text)) strengths.push('Asks for explicit reasoning or steps')

  // --- scoring --------------------------------------------------------------
  // Several rules are gated on length so they do not nag on tiny prompts. Left
  // alone that hands a three-word prompt a free 100 in every ungated category,
  // so a short prompt is also held to a ceiling it cannot exceed: below ~35
  // words there is simply not room to establish context, format and scope.
  // The ceiling ramps five points per word from 50 at five words and reaches
  // 100 at fifteen — the length where the context/format/scope rules start
  // firing and can carry the judgement themselves. It scales the category
  // rather than clamping it: a clamp hid every penalty smaller than the
  // headroom, so a broken short prompt scored the same as a clean one. A
  // longer ramp was tried and rejected: it made a light-touch rewrite that
  // merely dropped two filler words from a 25-word prompt score six points
  // lower than the original, which no rewrite guard can explain to a user.
  const ceiling = Math.min(100, 50 + 5 * Math.max(0, wordCount - 5))

  const categories = {}
  for (const key of Object.keys(CATEGORIES)) {
    const penalty = issues
      .filter((i) => i.category === key)
      .reduce((sum, i) => sum + (SEVERITY_PENALTY[i.severity] ?? 10), 0)
    categories[key] = Math.max(0, Math.round(((100 - penalty) * ceiling) / 100))
  }
  const totalWeight = Object.values(CATEGORIES).reduce((s, c) => s + c.weight, 0)
  const score = Math.round(
    Object.entries(CATEGORIES).reduce((sum, [key, cfg]) => sum + categories[key] * cfg.weight, 0) /
      totalWeight
  )

  const severityRank = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity])

  return {
    empty: false,
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F',
    categories,
    issues,
    strengths: uniq(strengths),
    stats: {
      words: wordCount,
      sentences: sentences.length,
      lines: lines.length,
      characters: text.length,
      estimatedTokens: estimateTokens(text),
    },
  }
}
