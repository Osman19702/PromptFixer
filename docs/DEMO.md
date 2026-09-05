# PromptFixer demo

Eight prompts through the local model (Qwen3 4B Instruct (2507)), with the linter's before/after scores. Nothing
below was edited by hand. Average improvement in this run: +12 points; 0 of 8 needed the
guard's retry; 0 ended with a warning.

Load any of them in the app from **Try an example** in the editor pane, or fetch them from
`GET /api/examples`.

## The five-minute walkthrough

1. 0:00 Open PromptFixer. Point at the top bar: brand 'PromptFixer lint · score · rewrite', the provider select (show the green status dot and, for the local provider, the tier select with '✓' next to the downloaded model), and the Library button. Say: linting and scoring are deterministic and happen locally with no model call; only 'Fix prompt' talks to a model.
2. 0:20 The editor is empty, so the 'Try a sample' button is visible in the Your prompt pane header. Click it. The blog-post sample loads and within ~350 ms the metastrip under the editor updates: 27 words, ~40 tokens, score 60/100, 11 issues. Say: this is live linting, it re-runs on every keystroke.
3. 0:45 The result pane opens on the Issues tab (count badge 11). Walk down the ScorePanel: overall 60/D and the five category bars (Clarity 46, Specificity 47, Context 60, Format & limits 69, Structure 91). Then the IssueList, sorted high to low: 'Conflicting instructions' with evidence chips 'brief' and 'comprehensive'; 'Asks for facts or sources with nothing to ground them'; 'Emphasis by shouting'. Read one issue's detail + suggestion aloud to show they are actionable, not generic.
4. 1:15 Set the presets: Task type = Writing & content, Target model = Any model, Strength = Balanced. Press Ctrl+Enter (or click 'Fix prompt ⌃⏎'). The button shows a spinner and 'Fixing…' with a Cancel button beside it; with the local provider the local chip in the metastrip shows model · CUDA · tok/s afterwards.
5. 1:40 The Fixed tab opens automatically and a toast says 'Fixed in N.Ns · 60 → NN'. Read the 'What changed' summary banner, then the compare ScorePanel (each category bar now shows its delta against the before score). Scroll the fixed prompt: point at the [feature name] placeholder (tool never invents your product), the resolved word count, the removed '!!'.
6. 2:05 Click the Diff tab. Removed words are highlighted on the left/inline (good, professional, !!), additions on the right. Say: this is exactly what changed, nothing hidden.
7. 2:20 Click the Changes tab (badge shows the count). Show the Changes list with type pills (clarity / specificity / format ...), 'what' and 'why' per entry; 'Assumptions made'; 'Answer these to go further' (the stats question); 'Techniques applied' chips; 'Run details' (model, seconds, tokens in/out, 52 → NN words).
8. 2:40 Click Apply. The fixed text replaces the editor content, an 'Undo apply' button appears in the Your prompt header, and the metastrip re-lints the new text, now showing the after-score live. Click 'Undo apply' to show it reverts. Click Save, then open Library to show the entry (before/after score, provider, model); close it.
9. 3:05 Click Clear. Paste example 7, the complaint sentence 'I changed the strength but it still changes a lot'. Metastrip: 10 words, score 50, 4 issues; Issues tab top item is 'No clear action requested'. Set Task type = General, Strength = Light touch. Fix. Show that the output is the same sentence tidied, not a new prompt. If the '(first attempt rewrote too much; kept the retry)' note or the yellow 'Rewrote more than the strength allows' banner appears, explain the retention guard: light touch requires 60% of your words to survive, the server retries once, then warns.
10. 3:35 Switch Strength to Full rebuild and Fix again on the same text. Contrast: now it becomes a real prompt and 'Assumptions made' says what it assumed. Say: strength is a contract about how much of your text survives, not a quality dial.
11. 3:55 Clear. Paste example 8 (the PostgreSQL vs MySQL prompt). Metastrip: 52 words, 93/A, 3 issues; Issues tab lists three Strengths ('Output format is stated', 'Length or scope is bounded', 'Sets a role or perspective'). Task type = Analysis & research, Strength = Light touch. Fix. Show a tiny diff and Run details '52 → ~55 words'. Say: a good prompt is left alone.
12. 4:20 Clear. Paste example 4 (support bot). Task type = Agent / system prompt, Target model = Claude, Strength = Full rebuild, tick 'Add a role line' is unnecessary (it already has one) so instead click '+ Instructions' and type 'escalate refunds to a human, keep under 200 words' in the notes input. Fix. Show: XML-style sections for Claude, every 'don't' paired with a positive rule, {{app name}} placeholders, the notes honoured (refund escalation line, length). Point at the Issues tab afterwards: 'Mostly negative constraints' is gone.
13. 4:45 Close with the remaining three examples on screen as pre-saved Library entries (Code, Extraction, Image) so viewers can open each from the Library modal and see before/after scores without waiting on inference. For the image entry say explicitly that the score is a heuristic tuned for instruction prompts; judge that one on the Fixed text. Mention .env / provider choice: same UI, cloud or fully offline.

Screens worth capturing:

- 01-empty-state.png — fresh app: top bar with provider/model selects and Library; Your prompt pane showing the placeholder text and the 'Try a sample' button; result pane on Issues tab with the 'Start typing' empty state.
- 02-sample-live-lint.png — after clicking 'Try a sample': editor with the blog prompt; metastrip reading 27 words · ~40 tokens · score 60/100 · 11 issues; presets row (Task type / Target model / Strength) and the toggle row (Keep my voice, Add an example, Add a role line, + Instructions).
- 03-issues-tab-before.png — Issues tab, badge 11: ScorePanel with 60/D and five category bars; IssueList with 'Conflicting instructions' (chips: brief, comprehensive) expanded to show detail and suggestion.
- 04-fixing-in-flight.png — 'Fix prompt' button in its spinner 'Fixing…' state with the Cancel button beside it (local provider: capture the local chip with model · CUDA afterwards).
- 05-fixed-tab.png — Fixed tab immediately after the run: the toast 'Fixed in N.Ns · 60 → NN' still visible bottom-right, 'What changed' info banner, compare ScorePanel with per-category deltas, the fixed prompt in the output block with the [feature name] placeholder visible.
- 06-diff-tab.png — Diff tab for the blog prompt with removed words (good, professional, !!) and added lines highlighted.
- 07-changes-tab.png — Changes tab: change rows with type pills and why-text, 'Assumptions made', 'Answer these to go further', 'Techniques applied' chips, 'Run details' metastrip (model, seconds, tokens, words before → after).
- 08-apply-undo.png — after clicking Apply: the fixed text in the editor, 'Undo apply' button in the Your prompt header, metastrip showing the new live score, 'Applied to the editor' toast.
- 09-library-modal.png — Library modal open with the saved blog entry showing scores before/after, provider and model.
- 10-complaint-light-touch.png — complaint sentence at Light touch: score 50 in the metastrip, Issues tab top item 'No clear action requested', and the Fixed tab showing the tidied sentence; include the '(first attempt rewrote too much; kept the retry)' note or the yellow 'Rewrote more than the strength allows' banner if either appears.
- 11-complaint-full-rebuild.png — same sentence at Full rebuild: Fixed tab plus the Changes tab's 'Assumptions made' list, side-by-side with 10 if possible.
- 12-decent-prompt-light.png — PostgreSQL vs MySQL prompt: metastrip 52 words · 93/100 · 3 issues, Issues tab Strengths list, and the Diff tab showing only a handful of changed words.
- 13-agent-claude-notes.png — support-bot prompt with Task type = Agent, Target model = Claude, '+ Instructions' notes input filled in, and the Fixed tab showing <tag>-style sections and {{placeholders}}.
- 14-extraction-example-toggle.png — extraction prompt with 'Add an example' ticked and the Fixed tab showing the schema, null policy and the worked input→output example.
- 15-image-descriptors.png — image prompt at Full rebuild: Fixed tab showing the comma-separated descriptor list and separate 'Negative prompt' line; Issues tab visible enough to show that the score delta is not the point here.
- 16-local-model-banner.png (optional, for the offline story) — provider = Local with the 'Download the local model' or 'X is on disk / Load now' banner in the result pane, and the tier select showing sizes in GB.

## The examples

### Vague code request

*A developer pastes a one-liner bug report and expects working code back. Shows the Code preset pushing for language, framework, test expectations and 'return only the changed function' scoping. · Code & engineering · Balanced* — score **79 → 97** (+18), 1 attempt, 39% of the original vocabulary kept.

**Before**

```text
fix my login function, it breaks sometimes when users have weird characters in their password. make it clean and use best practices.
```

**After**

```text
Fix the login function to handle passwords containing weird characters (e.g., @, #, $) without breaking. Return only the updated function code. Ensure no sentence exceeds 20 words. Use explicit hashing (e.g., bcrypt) and salt. Do not include error handling or comments. Requirements: 1. Passwords with special chars must be accepted. 2. No hardcoded salts or passwords. 3. Must use bcrypt with salt rounds of 10. 4. No try-catch blocks or logging.
```

**What the model changed:** Added format, scope, specificity, and success criteria to ensure clear, actionable output.

**What to notice:** Lints at 73/C with 7 issues before any model call. Top issues: 'Quality asked for as a vibe, not a criterion' (evidence: best practices), 'No output format', 'No length or scope limit', 'No background or context', and 'Vague wording' (best, clean). Note that 'Audience not identified' does NOT fire because the Code preset suppresses it (analyze.js gates no-audience on intent !== 'code'), so switching Task type to General and back visibly changes the issue count in the metastrip. After Fix: the rewrite should introduce [language/framework] placeholders rather than guessing a stack, ask for the failing input examples, and scope the answer to the changed function. Check the Changes tab: 'Assumptions made' and 'Answer these to go further' should list the missing stack and the actual error, which is the tool refusing to invent facts (hard rule 2 in metaprompt.js).

### Blog post with conflicting instructions

*The built-in sample (the 'Try a sample' button in the Your prompt pane). A marketing ask that contradicts itself and invites fabricated statistics. Shows the Writing preset and the conflict / ungrounded-facts rules. · Writing & content · Balanced* — score **61 → 92** (+31), 1 attempt, 57% of the original vocabulary kept.

**Before**

```text
write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!
```

**After**

```text
Write a brief blog post about [product name]'s new feature for a technical audience of mid-level developers. The post must be under 200 words and include only facts from the provided text; if no stats are available, state so. Use clear, professional language with no sentence exceeding 15 words. Format the output as bullet points with three key benefits. Requirements: include at least one data point on AI trends from 2023; avoid jargon or speculation. Do not mention future plans or unverified claims.
```

**What the model changed:** Added audience, format, length, concrete criteria, and safety constraints to resolve ambiguity and ensure accuracy.

**What to notice:** Scores 60/D with 11 issues, the richest Issues tab of the demo. The single high-severity issue is 'Conflicting instructions' with evidence 'brief' + 'comprehensive' (the model will silently pick one). Also 'Asks for facts or sources with nothing to ground them' (cite stats), 'Time-relative wording with no fixed date' (latest), 'Emphasis by shouting' (the !!), 'Quality asked for as a vibe' (make it good), 'Audience not identified', 'No role'. After Fix, the viewer should see: the brief/comprehensive conflict resolved into a concrete word count; 'our new feature' turned into a [feature name] placeholder, not an invented product; the stats request either grounded ('only use figures from the material provided') or turned into a question in the Changes tab; the !! gone. Score should jump into the 85-95 range and the toast reads 'Fixed in Ns · 60 → NN'. Good moment to open the Diff tab: removals of 'good', 'professional', '!!' are highlighted, additions are the audience and length lines.

### Analysis / summary of a transcript

*An analyst asks for a summary of material they forgot to attach. Shows the 'missing input' rule, the Analysis preset's grounding guidance, and how the fixer adds a delimited slot instead of pretending the transcript exists. · Analysis & research · Balanced* — score **71 → 97** (+26), 1 attempt, 57% of the original vocabulary kept.

**Before**

```text
Summarize the customer interview transcript below and tell me what the main problems are. I need something I can share with the product team, so be thorough but keep it short.
```

**After**

```text
Summarize the customer interview transcript below and identify the main problems. This summary is for the product team, so be clear, actionable, and concise. Keep all sentences under 20 words. Output in bullet points. Do not include speculation or assumptions. Audience: product managers with mid-level technical knowledge. 

<document>
Transcript: [Customer interview transcript here]
</document>
```

**What the model changed:** Added output format, length constraint, audience, and input delimitation to ensure clarity and actionable results.

**What to notice:** Scores 62/D. Two high issues: 'References input that is not clearly attached' (evidence: transcript below, because rx.referencedInput matched but no fence/tag/--- delimiter exists) and 'Conflicting instructions' (short vs thorough). Context category is only 24/100, the lowest category bar in the ScorePanel across the whole demo, which makes the per-category delta easy to point at afterwards. After Fix, look for: a <transcript> ... </transcript> or ``` block with a placeholder inside it (this is exactly what the missing-input suggestion asks for), an instruction like 'if the transcript does not cover it, say so' from the Analysis preset guidance, a bounded output shape (e.g. N problems, each with a supporting quote), and the audience 'product team' preserved. The Context bar should be the biggest mover in the compare view. If the model returns a long rewrite, the retention guard may kick in and the 'What changed' banner will show '(first attempt rewrote too much; kept the retry)'.

### Agent system prompt

*A founder's first attempt at a support-bot system prompt: all prohibitions, no escalation path, no output contract. Shows the Agent preset turning negative rules into positive ones and the deliberate {{placeholder}} behaviour. · Agent / system prompt · Full rebuild* — score **81 → 90** (+9), 1 attempt, 72% of the original vocabulary kept.

**Before**

```text
You are a support bot for our app. Answer questions about billing and account stuff, be friendly, don't make things up, never talk about competitors and don't give refunds without checking.
```

**After**

```text
You are a support bot for our app. Answer questions about billing and account settings. Be friendly, clear, and concise. Use simple language for non-technical users. Only provide accurate information based on verified policies. If unsure, say 'I cannot confirm that' and do not speculate. Never mention competitors or offer refunds without explicit policy review. Return only the response in prose, no extra commentary or markdown.
```

**What the model changed:** Clarified role, added audience, fixed vague language with specific rules, and defined output format

**What to notice:** Scores 69/C. Notice the top issue is 'No clear action requested' (high) even though the prompt is perfectly clear: 'answer' is not in analyze.js TASK_VERBS. Presenter can say the linter is deliberately dumb and deterministic, the model pass is where judgement lives. Also 'Mostly negative constraints' (don't, never, without) which is the issue the Agent preset is written to fix ('prefer positive rules over prohibitions, state precedence'). Strengths already listed: 'Sets a role or perspective', 'Includes situational context'. With Full rebuild, expect labelled sections (Role, Scope, Rules, Escalation, Output), each 'don't' paired with what to do instead (e.g. 'if asked about competitors, say X and redirect'), a refund rule that names who to escalate to as a [placeholder], and {{ }} placeholders for app name / policy links. Because Full rebuild has MIN_RETENTION 0 there will be no retention warning even though the text is mostly new; contrast this with the light-touch examples. Try the 'Target model: Claude' option here to show the <tags> style sections vs markdown headings under 'Any model'.

### Data extraction to a spreadsheet

*A non-technical user wants fields pulled out of emails and pasted into Excel. Shows the Extraction preset producing an exact schema, a null policy and a worked example, plus the 'Add an example' toggle. · Data extraction · Balanced* — score **85 → 94** (+9), 1 attempt, 65% of the original vocabulary kept.

**Before**

```text
Pull the company name, contact email, and order total out of these emails and give it to me as data I can put in a spreadsheet.
```

**After**

```text
Extract the company name, contact email, and order total from each email. Return only a JSON array of objects with these fields: company_name, contact_email, order_total. Each object must contain exactly these three fields. Do not include any commentary, explanations, or extra text. The output must be valid JSON. Audience: non-technical operations staff. This data feeds into a monthly sales report spreadsheet.
```

**What the model changed:** Added output format, scope, context, and success criteria to ensure precision and usability.

**What to notice:** Scores 70/C with 'No clear action requested' at the top ('pull' is not a recognised task verb) and 'No output format' (the word 'spreadsheet' is not in the format regex; 'csv' or 'table' would have been). After Fix the first word should be 'Extract' and the format issue should disappear because the rewrite names CSV or a JSON array with exact column names. Look for the three things the Extraction preset demands: field names with types, what to emit when a value is missing (empty string / null), and 'output the structure only, no prose'. Tick 'Add an example' before fixing so the rewrite includes one input-to-output sample; then untick and rerun to show the toggle is honoured. Because the emails are not attached, the rewrite should add a delimited <emails> slot rather than invent content. The Changes tab 'Techniques applied' chips should include something like 'output contract' or 'schema'.

### Image-generation prompt

*A chatty request written for a chat model but destined for Midjourney/SD. Shows the Image preset converting sentences into comma-separated visual descriptors and splitting out a negative prompt. · Image generation · Full rebuild* — score **89 → 94** (+5), 1 attempt, 45% of the original vocabulary kept.

**Before**

```text
Can you make me a really nice picture of a fox in a forest at night, kind of a fantasy style, very detailed and high quality, no text or watermark please.
```

**After**

```text
A detailed fantasy fox in a dense forest at night, glowing bioluminescent moss, intricate fur textures, realistic lighting, cinematic composition, 8K resolution, ultra-detailed, no text, no watermark, style: fantasy realism, deep shadows, ambient moonlight, vibrant greens and deep purples, sharp focus, natural forest atmosphere
```

**What the model changed:** Replaced vague terms with concrete descriptors and added specific style, lighting, and technical details for clarity and precision

**What to notice:** Scores 69/C with 'Vague wording' evidence: nice, kind of, high quality. The fixed prompt should look completely different in shape: no 'can you', no second person, a dense descriptor list (subject, action, setting, composition, lens, lighting, colour, medium, style) and a separate 'Negative prompt: text, watermark' line, because the user named things to avoid. Presenter caveat: the linter is built for instruction prompts, so the after-score for this example may be flat or lower (no task verb, 'No role', 'No output format' are all wrong for an image prompt and still fire). Tell viewers to judge this one on the Fixed and Diff tabs, not on the score delta; it is a fair demonstration that the score is a heuristic. Full rebuild is the right strength because balanced/light would try to keep the sentence structure that image models do not want.

### Non-prompt input (a complaint sentence)

*Someone pastes a sentence that is not a prompt at all, e.g. feedback they were typing about the tool. Shows the light-touch directive 'If the text is not really a prompt, tidy it as written; never replace it with a different prompt' and the retention guard. · General · Light touch* — score **58 → 58** (0), 1 attempt, 100% of the original vocabulary kept.

**Before**

```text
I changed the strength but it still changes a lot
```

**After**

```text
I changed the strength but it still changes a lot
```

**What the model changed:** No action was requested; prompt is already minimal and self-contained

**What to notice:** Scores exactly 50/D: every category is capped at 50 by the short-prompt ceiling (10 words < 12), and 'Prompt is very short' + 'No clear action requested' are both high. Light touch is the demo: MIN_RETENTION for light is 0.6, and the user message carries 'If the text is not really a prompt, tidy it as written; never replace it with a different prompt.' A correct result is the same sentence with punctuation and perhaps 'strength' clarified ('the Strength setting'), not a manufactured 'Write a prompt about...' request. If the model overreaches, viewers should see either the '(first attempt rewrote too much; kept the retry)' note in the 'What changed' banner, or, if the retry still fails, the yellow 'Rewrote more than the strength allows' warning banner on the Fixed tab. Both are the retention guard from server/index.js working as designed. Then switch Strength to Full rebuild and rerun to show the contrast: now the model is allowed to turn it into a prompt (and the Assumptions list will say so). This is the example that answers the question every viewer asks: 'what happens if I paste garbage?'

### Already-decent prompt at light touch

*A well-formed comparison request from someone who already prompts well. Shows that light touch respects good work: minimal diff, no scaffolding, and the Strengths list in the Issues tab. · Analysis & research · Light touch* — score **95 → 95** (0), 1 attempt, 100% of the original vocabulary kept.

**Before**

```text
Compare PostgreSQL and MySQL for a small SaaS team of 4 developers migrating off SQLite. Cover replication, JSON support, and hosting cost on AWS. Return a markdown table with one row per criterion, then at most 3 bullets recommending one, based only on the criteria above. Flag anything you are unsure about.
```

**After**

```text
Compare PostgreSQL and MySQL for a small SaaS team of 4 developers migrating off SQLite. Cover replication, JSON support, and hosting cost on AWS. Return a markdown table with one row per criterion, then at most 3 bullets recommending one, based only on the criteria above. Flag anything you are unsure about.
```

**What the model changed:** No changes needed; prompt was already clear, grammatically correct, and fully specified.

**What to notice:** Scores 93/A with only 3 issues, all context/specificity lows and one medium: 'No background or context' (it has plenty, but none of the regex triggers like 'we are' / 'our' / 'my team' appear), 'Audience not identified', 'No example'. The Issues tab shows three Strengths: 'Output format is stated', 'Length or scope is bounded', 'Sets a role or perspective'. Under light touch the user message only passes non-low findings, so the model sees a single medium finding; expect a diff of a few words (maybe 'We are a team of 4...' to satisfy context, or a pinned date for 'hosting cost'), no headings, no role line, and a score that moves 93 to somewhere 95-100 or stays put. Word count in the Run details line ('52 → ~55 words') is the number to point at. If the fixed text is identical to the original that is explicitly allowed (normalizeResult treats it as fine). Rerun with Full rebuild afterwards to show the same prompt ballooning into sections, and let viewers decide which they would actually paste.


## How it was measured

Each prompt was sent to `/api/fix` with the task type and strength above, provider `local`,
library examples off. "Before" is the linter's score of the original; "after" re-lints the rewrite
with placeholders treated as reminders rather than defects. Retention is the share of the original's
distinct content words that survived. Hardware: i7-9750H, GTX 1660 Ti (Vulkan), 17.6 tokens/s over the run.
