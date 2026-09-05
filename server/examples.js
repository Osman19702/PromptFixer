/**
 * Example prompts for the "Try a sample" flow and GET /api/examples.
 *
 * Each one is chosen to show a different preset or guard doing its job, so
 * `expected` describes what the linter and the rewrite should do with it —
 * a script for a demo, not test fixtures. Keep them in step with the rules in
 * analyze.js and metaprompt.js when those change.
 */

export const EXAMPLES = [
  {
    id: 'vague-code-request',
    name: 'Vague code request',
    useCase:
      "A developer pastes a one-liner bug report and expects working code back. Shows the Code preset pushing for language, framework, test expectations and 'return only the changed function' scoping.",
    prompt:
      'fix my login function, it breaks sometimes when users have weird characters in their password. make it clean and use best practices.',
    intent: 'code',
    strength: 'balanced',
    expected:
      "Lints at 73/C with 7 issues before any model call. Top issues: 'Quality asked for as a vibe, not a criterion' (evidence: best practices), 'No output format', 'No length or scope limit', 'No background or context', and 'Vague wording' (best, clean). Note that 'Audience not identified' does NOT fire because the Code preset suppresses it (analyze.js gates no-audience on intent !== 'code'), so switching Task type to General and back visibly changes the issue count in the metastrip. After Fix: the rewrite should introduce [language/framework] placeholders rather than guessing a stack, ask for the failing input examples, and scope the answer to the changed function. Check the Changes tab: 'Assumptions made' and 'Answer these to go further' should list the missing stack and the actual error, which is the tool refusing to invent facts (hard rule 2 in metaprompt.js).",
  },
  {
    id: 'blog-post-with-conflicting-instructions',
    name: 'Blog post with conflicting instructions',
    useCase:
      "The built-in sample (the 'Try a sample' button in the Your prompt pane). A marketing ask that contradicts itself and invites fabricated statistics. Shows the Writing preset and the conflict / ungrounded-facts rules.",
    prompt:
      'write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!',
    intent: 'writing',
    strength: 'balanced',
    expected:
      "Scores 60/D with 11 issues, the richest Issues tab of the demo. The single high-severity issue is 'Conflicting instructions' with evidence 'brief' + 'comprehensive' (the model will silently pick one). Also 'Asks for facts or sources with nothing to ground them' (cite stats), 'Time-relative wording with no fixed date' (latest), 'Emphasis by shouting' (the !!), 'Quality asked for as a vibe' (make it good), 'Audience not identified', 'No role'. After Fix, the viewer should see: the brief/comprehensive conflict resolved into a concrete word count; 'our new feature' turned into a [feature name] placeholder, not an invented product; the stats request either grounded ('only use figures from the material provided') or turned into a question in the Changes tab; the !! gone. Score should jump into the 85-95 range and the toast reads 'Fixed in Ns · 60 → NN'. Good moment to open the Diff tab: removals of 'good', 'professional', '!!' are highlighted, additions are the audience and length lines.",
  },
  {
    id: 'analysis-summary-of-a-transcript',
    name: 'Analysis / summary of a transcript',
    useCase:
      "An analyst asks for a summary of material they forgot to attach. Shows the 'missing input' rule, the Analysis preset's grounding guidance, and how the fixer adds a delimited slot instead of pretending the transcript exists.",
    prompt:
      'Summarize the customer interview transcript below and tell me what the main problems are. I need something I can share with the product team, so be thorough but keep it short.',
    intent: 'analysis',
    strength: 'balanced',
    expected:
      "Scores 62/D. Two high issues: 'References input that is not clearly attached' (evidence: transcript below, because rx.referencedInput matched but no fence/tag/--- delimiter exists) and 'Conflicting instructions' (short vs thorough). Context category is only 24/100, the lowest category bar in the ScorePanel across the whole demo, which makes the per-category delta easy to point at afterwards. After Fix, look for: a <transcript> ... </transcript> or ``` block with a placeholder inside it (this is exactly what the missing-input suggestion asks for), an instruction like 'if the transcript does not cover it, say so' from the Analysis preset guidance, a bounded output shape (e.g. N problems, each with a supporting quote), and the audience 'product team' preserved. The Context bar should be the biggest mover in the compare view. If the model returns a long rewrite, the retention guard may kick in and the 'What changed' banner will show '(first attempt rewrote too much; kept the retry)'.",
  },
  {
    id: 'agent-system-prompt',
    name: 'Agent system prompt',
    useCase:
      "A founder's first attempt at a support-bot system prompt: all prohibitions, no escalation path, no output contract. Shows the Agent preset turning negative rules into positive ones and the deliberate {{placeholder}} behaviour.",
    prompt:
      "You are a support bot for our app. Answer questions about billing and account stuff, be friendly, don't make things up, never talk about competitors and don't give refunds without checking.",
    intent: 'agent',
    strength: 'aggressive',
    expected:
      "Scores 69/C. Notice the top issue is 'No clear action requested' (high) even though the prompt is perfectly clear: 'answer' is not in analyze.js TASK_VERBS. Presenter can say the linter is deliberately dumb and deterministic, the model pass is where judgement lives. Also 'Mostly negative constraints' (don't, never, without) which is the issue the Agent preset is written to fix ('prefer positive rules over prohibitions, state precedence'). Strengths already listed: 'Sets a role or perspective', 'Includes situational context'. With Full rebuild, expect labelled sections (Role, Scope, Rules, Escalation, Output), each 'don't' paired with what to do instead (e.g. 'if asked about competitors, say X and redirect'), a refund rule that names who to escalate to as a [placeholder], and {{ }} placeholders for app name / policy links. Because Full rebuild has MIN_RETENTION 0 there will be no retention warning even though the text is mostly new; contrast this with the light-touch examples. Try the 'Target model: Claude' option here to show the <tags> style sections vs markdown headings under 'Any model'.",
  },
  {
    id: 'data-extraction-to-a-spreadsheet',
    name: 'Data extraction to a spreadsheet',
    useCase:
      "A non-technical user wants fields pulled out of emails and pasted into Excel. Shows the Extraction preset producing an exact schema, a null policy and a worked example, plus the 'Add an example' toggle.",
    prompt:
      'Pull the company name, contact email, and order total out of these emails and give it to me as data I can put in a spreadsheet.',
    intent: 'extraction',
    strength: 'balanced',
    expected:
      "Scores 70/C with 'No clear action requested' at the top ('pull' is not a recognised task verb) and 'No output format' (the word 'spreadsheet' is not in the format regex; 'csv' or 'table' would have been). After Fix the first word should be 'Extract' and the format issue should disappear because the rewrite names CSV or a JSON array with exact column names. Look for the three things the Extraction preset demands: field names with types, what to emit when a value is missing (empty string / null), and 'output the structure only, no prose'. Tick 'Add an example' before fixing so the rewrite includes one input-to-output sample; then untick and rerun to show the toggle is honoured. Because the emails are not attached, the rewrite should add a delimited <emails> slot rather than invent content. The Changes tab 'Techniques applied' chips should include something like 'output contract' or 'schema'.",
  },
  {
    id: 'image-generation-prompt',
    name: 'Image-generation prompt',
    useCase:
      'A chatty request written for a chat model but destined for Midjourney/SD. Shows the Image preset converting sentences into comma-separated visual descriptors and splitting out a negative prompt.',
    prompt:
      'Can you make me a really nice picture of a fox in a forest at night, kind of a fantasy style, very detailed and high quality, no text or watermark please.',
    intent: 'image',
    strength: 'aggressive',
    expected:
      "Scores 69/C with 'Vague wording' evidence: nice, kind of, high quality. The fixed prompt should look completely different in shape: no 'can you', no second person, a dense descriptor list (subject, action, setting, composition, lens, lighting, colour, medium, style) and a separate 'Negative prompt: text, watermark' line, because the user named things to avoid. Presenter caveat: the linter is built for instruction prompts, so the after-score for this example may be flat or lower (no task verb, 'No role', 'No output format' are all wrong for an image prompt and still fire). Tell viewers to judge this one on the Fixed and Diff tabs, not on the score delta; it is a fair demonstration that the score is a heuristic. Full rebuild is the right strength because balanced/light would try to keep the sentence structure that image models do not want.",
  },
  {
    id: 'non-prompt-input-a-complaint-sentence',
    name: 'Non-prompt input (a complaint sentence)',
    useCase:
      "Someone pastes a sentence that is not a prompt at all, e.g. feedback they were typing about the tool. Shows the light-touch directive 'If the text is not really a prompt, tidy it as written; never replace it with a different prompt' and the retention guard.",
    prompt:
      'I changed the strength but it still changes a lot',
    intent: 'general',
    strength: 'light',
    expected:
      "Scores exactly 50/D: every category is capped at 50 by the short-prompt ceiling (10 words < 12), and 'Prompt is very short' + 'No clear action requested' are both high. Light touch is the demo: MIN_RETENTION for light is 0.6, and the user message carries 'If the text is not really a prompt, tidy it as written; never replace it with a different prompt.' A correct result is the same sentence with punctuation and perhaps 'strength' clarified ('the Strength setting'), not a manufactured 'Write a prompt about...' request. If the model overreaches, viewers should see either the '(first attempt rewrote too much; kept the retry)' note in the 'What changed' banner, or, if the retry still fails, the yellow 'Rewrote more than the strength allows' warning banner on the Fixed tab. Both are the retention guard from server/index.js working as designed. Then switch Strength to Full rebuild and rerun to show the contrast: now the model is allowed to turn it into a prompt (and the Assumptions list will say so). This is the example that answers the question every viewer asks: 'what happens if I paste garbage?'",
  },
  {
    id: 'already-decent-prompt-at-light-touch',
    name: 'Already-decent prompt at light touch',
    useCase:
      'A well-formed comparison request from someone who already prompts well. Shows that light touch respects good work: minimal diff, no scaffolding, and the Strengths list in the Issues tab.',
    prompt:
      'Compare PostgreSQL and MySQL for a small SaaS team of 4 developers migrating off SQLite. Cover replication, JSON support, and hosting cost on AWS. Return a markdown table with one row per criterion, then at most 3 bullets recommending one, based only on the criteria above. Flag anything you are unsure about.',
    intent: 'analysis',
    strength: 'light',
    expected:
      "Scores 93/A with only 3 issues, all context/specificity lows and one medium: 'No background or context' (it has plenty, but none of the regex triggers like 'we are' / 'our' / 'my team' appear), 'Audience not identified', 'No example'. The Issues tab shows three Strengths: 'Output format is stated', 'Length or scope is bounded', 'Sets a role or perspective'. Under light touch the user message only passes non-low findings, so the model sees a single medium finding; expect a diff of a few words (maybe 'We are a team of 4...' to satisfy context, or a pinned date for 'hosting cost'), no headings, no role line, and a score that moves 93 to somewhere 95-100 or stays put. Word count in the Run details line ('52 → ~55 words') is the number to point at. If the fixed text is identical to the original that is explicitly allowed (normalizeResult treats it as fine). Rerun with Full rebuild afterwards to show the same prompt ballooning into sections, and let viewers decide which they would actually paste.",
  },
]
