# Acceptance test-driven development for PromptFixer

> **Status (2026-09-17):** the scenarios in Part 3 exist as Gherkin in `acceptance/features/` and
> as executable tests in `acceptance/*.acceptance.test.js` (`npm run test:acceptance`). The first
> iteration's results, including the product defects it found, are in `docs/ATDD-REPORT.md`. Two
> groups have been added since: Group M (marking a rewrite and fixing it again) and Group N (the
> visual check with Elastishot). That makes 113 scenarios in fourteen groups — 102 automated, 11
> waiting on the nightly machine, the packaged installer or a person; `npm run test:trace` prints
> the list. Parts 1 and 2 describe the conversion as it was planned and are kept as written, apart
> from the counts and the visual seam.

This document converts PromptFixer's development strategy to ATDD. It has three parts: an honest
read of where the test strategy stands today, the target shape and the way of working that gets us
there, and the acceptance test cases themselves — end-to-end scenarios in prose, covering every
requirement the product currently makes, written in the language of the person using the app rather
than the language of the code.

---

## Part 1 — Where we are today

PromptFixer has roughly 130 automated tests across twelve files, all on Node's built-in test runner
with no external framework, and they are better than most projects this size manage. They are fast,
they are hermetic — the provider is stubbed by a local HTTP server, data and model directories are
freshly created per run under the OS temp directory, ports are OS-assigned so two runs never collide
— and `server/e2e.test.js` is, in everything but name, already an acceptance suite: it boots the
real server and drives the real HTTP API through a stub provider, with no key and no model download
required.

Three things stop it from being ATDD.

The first is that the tests are written in the vocabulary of the implementation. `pickBest() prefers
clean over diverged over leaked, then higher retention, then the first attempt` is an excellent test
and a poor specification: it tells you what a function returns, not what a user gets, and it cannot
be read by the person who decides what "a good rewrite" means. When the guard is refactored — and it
has been, twice — the test has to be rewritten even though the promise to the user never changed.

The second is that almost all of them were written after the code, as regression guards. You can
read the history of the product in the test names: the retention guard, the growth ceiling, the leak
scrubber and the placeholder-in-a-rewrite rule all exist because something went wrong in real use.
That is a healthy reflex, but it means there is no artifact anywhere in the repository that states
what the product must do before it is built. "Done" is currently a judgement call.

The third is a genuine coverage hole rather than a stylistic one. Nothing exercises the React
components or the Electron window. `server/ui.test.js` is a good compromise — the logic worth testing
was extracted into `src/lib/ui.ts` so it could be tested as pure functions — but it tests the model
behind the screen, not the screen. Nothing anywhere asserts that clicking **Fix prompt** produces a
visible result, that **Undo apply** appears where the README says it appears, or that the installed
desktop app opens at all. The five-minute walkthrough in `docs/DEMO.md` is the closest thing we have
to an end-to-end specification, and it is executed by a human reading it aloud.

So the conversion is not "throw away the tests and start again". Most of what exists survives
unchanged. What changes is that a new outermost tier appears, roughly twenty of the existing tests
are promoted into it and renamed, the rest stay exactly where they are as technical tests, and the
definition of done grows a clause.

---

## Part 2 — The target shape

### Four tiers, with a clear rule for which tier a test belongs to

The **acceptance tier** is new. It lives in `acceptance/`, one file per capability, and it drives the
product through the seams a real user touches: the HTTP API for server behaviour, the built React app
in a real browser for the interface, the packaged Electron app for the desktop story, and the CLI as
a spawned subprocess for the CI linter. Group N adds a fifth seam, and its user is a developer of
PromptFixer rather than a user of it: the Elastishot command line and the two npm scripts around it
(`npm run visual`, `npm run visual:approve`), run as subprocesses against the built app, with the
report they write as the thing asserted on. An acceptance test never imports an internal module. If a
scenario needs to reach into `metaprompt.js` to assert something, that scenario is in the wrong tier.
These are owned by the whole team; the SDET owns the harness underneath them.

The **component tier** is what `server/*.test.js` mostly is today — tests that boot the server or
call a module directly, stub the provider, and check behaviour that spans a few units. These stay.

The **unit tier** is the linter rules, the diff algorithm, the retention and growth arithmetic, the
store's parsing tolerance, the model catalog's RAM rounding. These stay too, and they are where
permutations belong: thirty rules times a dozen inputs each is a unit-tier job, not an acceptance-tier
job.

The **exploratory tier** is not automated and should stop pretending it might be one day. Rewrite
quality on a real model, GPU backend selection on real hardware, how the installer behaves on a
machine that already has an old version — these are time-boxed charters run by a person, with notes,
not scripts.

The budget matters more than the tiering. Part 3 defines one hundred and thirteen scenarios, and they
are not all equally cheap. A hundred and two run on every pull request: the seventy-three that drive
the API, the CLI and the diff take about a minute between them, the twenty browser scenarios about
two, and the two that open the desktop window from source about ten seconds; the files run side by
side, so until Group N arrived the whole gate finished in about eighty seconds. The seven visual
scenarios are the expensive ones — each starts the Elastishot command line and a browser of its own,
and the group needs about three and a half minutes — so they now set the length of the gate, at about
four minutes. The remaining eleven — the real-model scenarios, the packaged desktop app and one
manual charter — are nightly or done by a person because they cannot be made fast. The pull-request
gate is therefore capped at eight minutes and the whole set at around a hundred scenarios, a ceiling
Groups M and N have used up: the next group has to displace something or push it down a tier rather
than add to the pile. Anything that does not fit pushes down a tier — permutations
in particular, which belong in the unit tier and never here. An acceptance suite that grows without a
ceiling becomes slow, then flaky, then ignored, and an ignored suite is worse than no suite because
it still costs time to maintain.

### The way of working

For each story, three people have the conversation before anyone opens an editor: whoever decides
what the product should do, whoever will implement it, and the SDET. For PromptFixer a fourth voice
is sometimes needed — anything that touches the linter rules or the metaprompt is a
prompt-engineering judgement, and the person who owns those rules should be in the room, because
"is a missing audience a defect for a code prompt?" is exactly the kind of question that produced two
of our existing rules and is not answerable by a developer alone.

The conversation produces concrete examples, not restatements of intent. "The tool should respect the
strength setting" is not an example. "A user on Light touch pastes a fifteen-word complaint; the model
returns a completely different prompt; the user must end up with their own sentence tidied, and must
be told the first attempt overshot" is an example, and it is the thing that goes in the feature file.

Those examples are written into `acceptance/` before implementation, and they fail. Implementation
then proceeds with ordinary red-green-refactor at the unit level; the acceptance test is the outer
loop and may stay red for a day while the inner loop cycles thirty times. The scenario passing is the
demo: at review, the scenario name is read out and the run is shown, rather than someone clicking
through the app narrating what they meant.

### Definition of done

A story is not *started* until its acceptance scenarios exist in `acceptance/` and fail for the right
reason. It is not *done* until those scenarios pass, `npm test` passes, `npm run typecheck` passes,
and — for anything touching the linter or the metaprompt — `docs/DEMO.md` has been regenerated and
the before/after scores have not silently regressed. That last clause is the closest thing we have to
a quality metric for the rewriting itself, and it should be part of the gate rather than something
someone remembers to check.

### How scenarios must be written

Name the actor and the observable outcome. Never name a function, a field, a route or a file. Assert
on what the user can see or what a consumer of the API receives, never on a private field or an
internal call count. Prefer the user's noun: "task type", not `intent`; "strength", not
`MIN_RETENTION`; "the model copied its instructions into the answer", not "leak detection fired".
When a scenario cannot be written without naming an internal, that is a signal the behaviour is not
actually user-visible and belongs one tier down.

### The harness work this requires, stated honestly

This is the real cost of the conversion, and it is roughly a sprint of work before a single product
behaviour changes.

`acceptance/support/app.js` needs to boot the server in-process on port 0 with a temp data directory
and a temp model directory and hand back a client. This already exists, inline, inside
`server/e2e.test.js`; it needs extracting, not writing.

The stub provider needs to become scriptable per scenario. Today it selects its behaviour by looking
for markers like `ALWAYS_DIVERGE` and `LEAK_ONCE` inside the prompt text, which is ingenious and also
implementation coupling wearing a disguise — the test has to know how the user prompt is assembled in
order to smuggle a marker through it. Replace it with an explicit `stub.respondWith([...])` queued
per scenario, so a scenario reads "given the model returns a completely different prompt, then
returns a faithful edit" instead of "given the prompt contains ALWAYS_DIVERGE".

The browser tier is entirely new. Playwright against `npm run build && npm start` is the cheapest
route, and it is the only way to cover the fourteen interface scenarios below. Budget for the fact
that this is the first time anything in this repository has rendered a component.

The desktop tier is also new — Playwright's Electron support, and deliberately only the six scenarios
in Group K, because a packaged-app test is the slowest and most fragile thing we will own.

A deterministic stand-in for the local model is needed so the local provider path runs in CI without a
2.5 GB download: either a very small GGUF committed as a fixture, or a fake `node-llama-cpp` module.
The genuine model gets one nightly smoke scenario on the GPU machine instead.

Two environment constraints are non-negotiable and already bite us. Test runs must keep using fresh
temp directories and OS-assigned ports — the existing suite does this and it must not regress, because
a shared path gets populated by whatever ran last. And the nightly real-model run shares the GPU with
the installed build, so it must be serialised against a developer actually using the app rather than
scheduled blindly.

### CI gates

Pull requests run the unit tier, the component tier, and the acceptance tier for the API, the CLI,
the browser and the visual check — Group N approves its own pictures at the start of the run, so it
needs no committed baselines and passes on a fresh clone — plus the two desktop scenarios that open
the window from source (K2 and K3), which need no installer and no model. `.github/workflows/ci.yml`
is that gate, and it answers to every push to any branch, not only to a pull request: the unit and
component tiers in one job, the acceptance tier in another, and in a third a comparison of every
screen with the commit the push landed on, whose Elastishot report the run keeps next to the
acceptance results. The nightly run adds the
desktop scenarios that need the packaged app (K1 and K4) or a loaded model (F10), and the single
real-model smoke test on the GPU box. Packaging is verified nightly, and never from inside the synced
project folder.

---

## Part 3 — The acceptance test cases

One hundred and thirteen scenarios in fourteen groups: twelve on scoring, ten on the fix journey, ten
on the strength contract, six on learning from the library, seven on the library itself, eleven on
the local model, six on providers and privacy, fourteen on the interface, three on the diff, six on
the CI linter, six on the desktop app, four on configuration and limits, eleven on marking a rewrite
and fixing it again and seven on the interface looking the same from one run to the next. Each is
written as a narrative rather than a table because the narrative is what the three of us agreed in
the room; the identifiers exist only so that
a commit, a bug report or a coverage gap can point at one unambiguously. Every scenario names the
condition under which it fails, because a scenario that cannot fail is documentation, not a test.

### Group A — Scoring a prompt, with no model involved

**A1 — A pasted prompt is scored before anything is contacted.** Given a fresh install with no API
key configured and no local model on disk, when a user pastes a prompt into the editor, then within
a few hundred milliseconds they see an overall score out of one hundred, a letter grade, five
category bars labelled Clarity, Specificity, Context, Format and limits, and Structure, and a list
of specific issues — and no outbound network request is made at any point. This is the product's
central claim: the coaching half works offline, for free, instantly. It fails if scoring requires a
provider to be configured, if a defective prompt produces an empty issue list, or if any socket is
opened.

**A2 — The same prompt always produces the same score.** Given the same prompt text and the same
task type, when it is analysed repeatedly, across separate processes and separate machines, then the
score, the category breakdown and the ordered issue list are identical every time. Determinism is
what makes the before/after comparison meaningful and what makes the CI linter usable as a gate. It
fails if iteration order, a timestamp or a locale leaks into the result.

**A3 — Every finding tells the user what to do about it.** Given any prompt that produces issues,
when the user reads the issue list, then each entry has a human-readable title, a severity, a
category, and a suggestion phrased as an action they could take, with the offending words quoted
back as evidence where the rule identified specific words; and the list is ordered from most severe
to least. It fails if any rule can emit a finding with no suggestion, since an unactionable finding
is just criticism.

**A4 — A small edit never swings the score wildly.** Given a prompt of any length, when the user
adds one neutral word, then the overall score moves by at most a few points. The score is a coaching
signal, not a cliff edge, and a rewrite that merely deletes two filler words must never score lower
than the original — a guard the user cannot see cannot be explained to them either. It fails if the
short-prompt headroom ramp is changed in a way that makes trivial edits move the score sharply.

**A5 — A broken short prompt scores below a clean short prompt.** Given two prompts of the same
length, one with a clear verb, a stated output shape and a bounded scope and one with none of those,
when both are scored, then the clean one scores materially higher. Length must not be able to
dominate quality. It fails if the headroom ceiling for short prompts flattens both to the same
number.

**A6 — The task type changes which findings apply.** Given a prompt about fixing a login function,
when the user switches the task type from General to Code and engineering, then the "audience not
identified" finding disappears — code prompts do not need an audience — and the "no length or scope
limit" finding drops from a defect to a low-priority note; and switching back restores both, with
the issue count under the editor visibly changing as they switch. It fails if task type has no
observable effect, or if the change is not reflected until the next fix.

**A7 — Code inside a prompt is not linted as if it were prose.** Given a prompt containing a fenced
code block, inline code spans and markdown tokens, when it is scored, then no wording rule fires on
anything inside the code — no "shouting" from a constant, no "vague wording" from a variable name —
while the structure rules still see the whole prompt and can still report that it is unstructured or
does multiple things. It fails if code content produces phantom findings, or if excluding it also
blinds the structural rules.

**A8 — A prompt that refers to input it did not attach is a serious finding.** Given "Summarize the
customer interview transcript below" with nothing delimited after it, when it is scored, then the
top finding is a high-severity report that the prompt references input that is not clearly attached,
and the suggestion tells the user to add a delimited block. Given the same prompt with the material
present but not delimited, the finding downgrades to a low-priority note about structure rather than
a high-severity missing input. It fails if pasted material immediately below the instruction is
reported as missing.

**A9 — A descriptor-style image prompt is not punished for being one.** Given an image-generation
prompt written as a comma-separated list of descriptors, when it is scored with the Image task type,
then it is not penalised for lacking a task verb, a role or an output format, because none of the
three applies to that form. It fails if the general-purpose rules are applied unconditionally. Note
for the room: the score for image prompts is a heuristic tuned for instruction prompts, and the
scenario asserts the absence of false findings, not the presence of a particular number.

**A10 — A good prompt is told what it got right.** Given a well-formed prompt that states a role, an
output format and a bounded scope, when it is scored, then it lands in the A band and the panel
lists the things it does well rather than manufacturing complaints to fill space. It fails if a
strong prompt still shows a wall of low-severity noise.

**A11 — An oversized prompt is refused politely rather than hanging the app.** Given a prompt of
exactly sixty thousand characters, when it is scored, then it returns within the interactive budget.
Given one character more, then it is refused with a message naming the actual length and the limit,
and the app remains responsive for everyone else. This exists because not all of the linter's
patterns are linear and one oversized body would otherwise block the event loop for every concurrent
user. It fails if the cap is enforced on the fix route but not the analyse route, or if the refusal
arrives as a timeout.

**A12 — An empty editor is an empty state, not an error.** Given no text at all, when the app is
open, then the result pane shows an invitation to start typing and the example gallery, and nothing
anywhere reports a failure. It fails if an empty prompt produces an error toast or a zero score
presented as a judgement.

### Group B — Fixing a prompt

**B1 — The whole journey, end to end.** Given a prompt that scores 60 out of 100 with eleven issues,
when the user selects a task type and a strength and presses Fix prompt, then they receive a
rewritten prompt, a one-sentence summary of what changed, an itemised list of changes each carrying
both what was done and why, any assumptions the model made, any questions it wants answered before
it could do better, the techniques it applied, and a before-and-after score in which both sides were
measured with identical settings. That last clause is the one that matters most: if the two analyses
used different options the comparison would be theatre. It fails if the after-score is computed with
different settings from the before-score, or if any part of the result is missing when the model
returns a valid answer.

**B2 — The rewrite addresses the problems the user was shown.** Given a prompt whose issue list the
user has read, when they fix it, then the findings they saw are the findings the model was given, and
issues visible before the fix are either resolved in the rewrite or explained in the changes list. It
fails if the linter and the rewriter disagree about what is wrong, which would make the issue list
misleading rather than merely incomplete.

**B3 — The tool never invents facts about the user's situation.** Given a prompt that says "our new
feature" without naming it, when it is fixed, then the rewrite contains a clearly marked placeholder
rather than an invented product name, and the missing information appears as a question in the
changes list. And critically: a placeholder the model deliberately added is scored as a reminder, not
as a defect, so the after-score does not punish the rewrite for being honest. It fails if the model's
restraint costs it points, because that would train the tool to fabricate.

**B4 — Failure has a face.** Given any provider failure — unreachable, rate-limited, rejected key,
out of context, misconfigured endpoint — when the user presses Fix, then they see one specific
sentence naming the provider and what they can do about it, the application stays usable, and their
prompt text is untouched in the editor. It fails if a stack trace, a raw JSON body or an HTTP status
code reaches the screen, or if the editor loses the user's work.

**B5 — A fix can be cancelled and the machine is handed back.** Given a fix in flight, when the user
presses Cancel, then generation stops; with the local provider the GPU is released so the next fix
starts immediately instead of queueing behind an abandoned run; no corrective retry is started after
a cancellation; and the button becomes available again once the model has genuinely settled rather
than the instant the request aborts. It fails if a cancelled run keeps generating, or if the button
re-enables into a state where the next fix will fail.

**B6 — A stalled provider gives up in bounded time.** Given a provider that accepts the connection
and never sends headers, and separately a provider that sends headers and then stalls the body
indefinitely, when a fix is attempted, then in both cases the attempt is abandoned at the timeout
with a message saying so and marked as worth retrying. The second half of this exists because a
header-only timeout leaves a stalled body hanging forever. It fails if only the connection is
timed out.

**B7 — A truncated reply is reported as a truncated reply.** Given a provider that stops at its
output limit mid-answer, when the fix is attempted, then the user is told the reply was cut off and
that retrying may help, rather than being told the model returned malformed data. The distinction
matters because the two have completely different remedies. It fails if truncation surfaces as a
parse error.

**B8 — Nonsense from the client is coerced, never a server error.** Given requests carrying options
as a string, as an array, as null, with repeated query parameters, or with unknown extra fields, when
they are sent, then each either succeeds with sensible defaults or is refused with a clear
client-side error; none of them produces a server error. It fails if any malformed input reaches a
property read that throws.

**B9 — An empty prompt is refused before any model is contacted.** Given whitespace only, when the
user presses Fix, then it is refused immediately with an explanation and no provider call is made.
It fails if the request reaches the provider, since that costs money or GPU time for nothing.

**B10 — The last ten fixes stay comparable.** Given a session in which the user has run several
fixes, when they use the previous and next controls in the results pane, then the counter reads
correctly, it clamps at both ends rather than wrapping or going out of range, only the ten most
recent are kept, and the Fixed, Diff, Issues and Changes tabs all follow the selection together.
It fails if any tab shows a different run from the others.

### Group C — The strength contract and the rewrite guard

**C1 — Strength is a promise about the user's own words.** Given the three strength settings, when
the user reads the interface, then they are told plainly what each one guarantees: Light touch keeps
at least sixty per cent of their distinct content words, Balanced at least thirty per cent, and Full
rebuild makes no such promise. Strength is a contract about how much of their text survives, not a
quality dial, and the interface must say so. It fails if the guarantee is enforced but never stated.

**C2 — A Light touch rewrite that throws the user's words away is retried, and the faithful attempt
is kept.** Given a fifteen-word complaint at Light touch, when the model first returns an entirely
different prompt and then, told what was wrong with it, returns the user's own sentence with the typo
fixed, then the user receives the second attempt, is told in one clause that the first one overshot,
and never sees the discarded attempt. It fails if the divergent attempt is shown, or if the retry is
not given the specific reason the first was rejected.

**C3 — When both attempts overshoot, the user is warned and still gets the better one.** Given a
model that ignores the strength twice, when the fix completes, then the user receives the better of
the two attempts, a warning banner names the strength and the percentage of their words that
survived, and the advice offered is never the strength they are already using. Telling someone on
Balanced to try Balanced is the kind of small insult that makes people stop reading warnings. It
fails if the result is withheld, or if the advice is unconditional.

**C4 — Light touch is never asked to do the impossible.** Given a prompt whose findings include
missing context, missing audience, missing format and missing limits, when it is fixed at Light
touch, then the model is not shown those findings at all, because the only way to satisfy them is to
invent material the user did not provide — which Light touch forbids. It fails if a Light touch
rewrite can be blamed for not adding what it was never allowed to add.

**C5 — Keeping every word and bolting scaffolding onto it is also a violation.** Given a rewrite that
preserves one hundred per cent of the user's vocabulary and then appends a role line, three headings
and a requirements list, when it is checked at Light touch, then it is rejected for growth, retried,
and — if the retry does the same — warned about with wording that says the model added too much,
not that it removed too much. Retention alone cannot catch this, and a warning that describes the
wrong failure is worse than none. It fails if the two failure kinds share a message.

**C6 — Full rebuild is genuinely unbounded.** Given the same complaint sentence at Full rebuild, when
it is fixed, then it comes back as a real, restructured prompt with no warning of any kind, and the
changes list states the assumptions that restructuring required. Placed next to C2 this is the
scenario that demonstrates the contract is real in both directions. It fails if any growth or
retention warning appears at Full rebuild.

**C7 — The tool's own instructions never reach the user.** Given a model that pastes the system
prompt or the linter findings into its answer, when the fix runs, then it is retried; if the retry
does it too, the boilerplate is stripped, every line the user themselves wrote survives the strip
intact, the user is warned to check the result carefully, and if nothing usable remains after
stripping they are shown their original prompt unchanged with an explanation. Under no circumstances
is an empty rewrite returned. It fails if a single line of the user's text is lost to the scrubber,
or if the output block is ever empty.

**C8 — A user's own finding-shaped text is not mistaken for our boilerplate.** Given a user whose
prompt legitimately contains bracketed severity tags or a list that reads like linter output, when
they request a light edit, then they get their text back, edited, with no leak warning — including
after the model has slightly reworded those lines. It fails if the leak detector matches on shape
alone rather than on provenance.

**C9 — When two attempts both fall short, the choice between them is predictable.** Given a first and
a second attempt that fail in different ways, when the better one is selected, then a clean result
beats a divergent one, a divergent one beats one that leaked instructions, between two of the same
kind the one that kept more of the user's words wins, and on a genuine tie the first attempt wins.
The user never sees this logic; they see that the tool behaves the same way twice on the same input.
It fails if the selection is unstable across runs.

**C10 — A failed corrective retry never becomes a server error.** Given a first attempt that
overshot and a retry that throws — the connection dropped, the provider errored — when the fix
completes, then the user receives the first attempt with a warning that also mentions the retry
failed and why. A retry exists only to improve an answer we already hold; losing the answer because
the improvement failed is the wrong trade. It fails if the request returns an error status.

### Group D — Learning from the user's own library

**D1 — The tool learns how much change this user actually likes.** Given a library containing
rewrites the user chose to save, when they fix a new prompt that resembles one of them, then up to
two of their own before-and-after pairs are shown to the model as examples of the amount and style of
change they prefer, and the result line tells them examples were used and how many. It fails if the
feature is silent about having been applied — an invisible influence on the output is not acceptable.

**D2 — Only examples worth imitating are used.** Given a library entry whose rewrite scored no better
than its original, when a similar prompt is fixed, then that entry is never offered as an example.
And given that the prompt being fixed is itself already in the library, then it is never offered as
an example of itself. It fails if a bad rewrite can teach the model to produce more bad rewrites, or
if the tool shows the model the answer it is being asked to produce.

**D3 — The same task type is preferred.** Given two library entries of similar textual resemblance,
one sharing the current task type and one not, when examples are selected, then the matching task
type is preferred. It fails if selection ranks on vocabulary overlap alone.

**D4 — The user can turn it off, and it never costs anything.** Given the toggle unticked, when a fix
runs, then no examples are sent and the result line stops mentioning them. And given no network
connection at all, when a fix runs with the toggle on, then example selection still works, because it
reads only the local library. It fails if disabling it has no observable effect, or if it makes any
network call.

**D5 — A retry sees the same examples as the first attempt.** Given a fix that needs a corrective
retry, when the retry runs, then it is shown the same examples the first attempt saw, so the only
variable between the two attempts is the correction. It fails if examples are re-selected per
attempt, which would make the retry's behaviour unexplainable.

**D6 — A rewrite that parrots an example back is caught.** Given a model that pastes example text
into its answer, when the fix runs, then it is handled as an instruction leak under C7 rather than
returned as the user's rewrite. It fails if example content can reach the output block.

### Group E — The prompt library

**E1 — Save it, find it, reopen it, delete it.** Given a completed fix, when the user saves it, opens
the library, types a word from the original, opens the matching entry, and then deletes it, then each
step does what it says: the entry appears with its before and after scores, the provider and the
model; the search narrows the list; the entry reopens; the deletion takes effect immediately and does
not require a restart to be visible. It fails at any step, and each step is asserted separately so a
failure names itself.

**E2 — A hand-edited library file loads anyway.** Given a library file a user has edited by hand and
broken — a truncated file, a null entry, a number where a string belongs, a missing field — when the
app starts, then it opens normally, the readable entries are all present, and the unreadable ones are
dropped without a word. Losing one bad entry silently is right; refusing to start is not. It fails if
any malformed shape crashes the read.

**E3 — A crash during a save cannot corrupt the library.** Given the app is killed mid-save, when it
is restarted, then the library on disk is either exactly the previous version or exactly the new one,
never a half-written file. It fails if any interleaving can produce a file that E2 then has to
salvage.

**E4 — The library is bounded and drops the oldest first.** Given five hundred entries, when another
is saved, then the newest is present and the oldest is gone, and the count stays at the cap. It fails
if the cap is enforced on read rather than on write, or if the wrong end is trimmed.

**E5 — A library moves between machines.** Given a library on one machine, when the user exports it,
then they get a JSON file whose name carries the export date, and when they import that file on
another machine, then entries they do not already have are added, entries whose identifier already
exists are skipped and never overwritten, malformed entries are dropped, and the confirmation states
how many were imported and how many skipped. Importing the same file a second time adds nothing.
Importing the raw library file from disk works as well as importing an export, because both carry
the same envelope. It fails if an import can overwrite work the user already had, which is the one
outcome that would make people stop using the feature.

**E6 — Importing the wrong file says so in plain words.** Given a JSON file that is not a library, or
a file that is not JSON at all, when the user imports it, then they are told what shape was expected,
and nothing in their library changes. It fails if the error is a parse message or a status code.

**E7 — The library lives where the documentation says it lives.** Given the installed desktop app,
the app run from source, and browser mode, when each writes a library, then it lands in the per-user
data directory, the per-user data directory, and the project data folder respectively; and given the
data-directory override is set, then all three honour it. And given the app is uninstalled and
reinstalled, then the library and the downloaded model are both still there. It fails if any mode
writes inside the installation directory, since that is what an uninstall deletes.

### Group F — The local model

**F1 — A first-run user with no model is told exactly what to do.** Given a fresh install with the
local provider selected and nothing downloaded, when the app opens, then a banner names the model, its
size in gigabytes and offers a Download button, and Fix prompt is disabled with a visible reason
rather than failing when pressed. Meanwhile linting and scoring work fully. It fails if the user can
press a button that cannot succeed.

**F2 — The download is visible, resumable and cancellable.** Given a download in progress, when the
user watches it, then they see bytes transferred and a percentage; when they cancel it, then the app
returns cleanly to the not-downloaded state with the Download button back and no error reported;
when they interrupt it and start again, then it resumes rather than starting from zero. It fails if
a cancellation leaves an error state the user has to clear, since cancelling is not a failure.

**F3 — A download that produced no usable file says so.** Given a download that completes but leaves
a file of the wrong size or no file at all, when it finishes, then the state is an error with a
message, not a ready state that fails on first use. It fails if completion is inferred from the
transfer ending rather than from the file being verified.

**F4 — The machine picks a sensible model on its own.** Given a machine with less than eight
gigabytes of memory, when no choice has been made, then the smallest tier is recommended; given a
machine sold as eight gigabytes, whose operating system reports slightly less because of firmware
reservation, then the default tier is still recommended, because the threshold should mean what the
catalogue says it means. Given an explicit choice in configuration, then it always wins over the
recommendation. It fails if a marketed-8GB machine is pushed to the small model.

**F5 — Switching models is safe at any moment.** Given a download in progress, when the user selects
a different tier, then the switch is refused with an explanation rather than silently relabelling the
running download as the new model; given a generation in progress, then the switch waits for it and
then applies; given an unrecognised model identifier, then it is rejected. It fails if a switch can
leave the app believing it holds a model it does not hold.

**F6 — Loading is never confused about which model it is loading.** Given a load in flight for one
tier, when a request arrives for a different tier, then it is not satisfied by the load in flight;
and given a request for a tier that is not on disk while another tier is loading, then it fails
clearly rather than waiting on an unrelated load. It fails if any request can be answered by the
wrong model.

**F7 — The GPU is used when it exists and its absence is not a failure.** Given a machine with a
supported GPU, when the model loads, then the status shows the backend in use; given a machine with
none, then it loads on CPU, the app works, and the interface says so rather than appearing to hang.
It fails if a CPU-only machine gets an error instead of a slower experience.

**F8 — A prompt too long for the model is refused with advice, not truncated.** Given a prompt that
exceeds the local model's shared input-and-output budget, when the user presses Fix, then they are
told the prompt is too long for the local model and offered the alternatives — shorten it, or use a
cloud provider for this one — before any generation starts. And given a model whose usable context
resolves smaller than expected, then the reply length is clamped to fit rather than every prompt
being rejected. It fails if the prompt is silently cut, since a silently truncated prompt produces a
confidently wrong rewrite.

**F9 — The result is always structurally valid.** Given the smallest supported model on a difficult
prompt, when it generates, then the user receives a structured result or a clear error, never a
malformed one, because the output is constrained to the result shape during generation rather than
parsed hopefully afterwards. It fails if any generation can produce a user-visible parse failure.

**F10 — Quitting releases the model.** Given a loaded model, when the user closes the window, then
the model is unloaded and the process exits; and given an unload that hangs, then the app still exits
within a bounded time rather than sitting invisible in the process list holding the GPU. It fails if
a second launch has to contend with the first for video memory.

**F11 — Nothing leaves the machine.** Given the local provider and the network physically
disconnected, when the user lints a prompt, fixes it, saves it to the library and exports the
library, then all four succeed. This is the product's headline promise and it deserves a scenario
that tests it the way a sceptical user would.

### Group G — Providers and privacy

**G1 — The app offers only providers that can actually work.** Given a configuration with some keys
present and some absent, when the user opens the provider list, then the usable ones are selectable
and the rest are visibly unavailable with the reason; and given no configuration at all, then the
local provider is selected by default. It fails if a user can select a provider that will certainly
fail.

**G2 — Keys never reach the browser.** Given every configured provider, when the full surface of the
API is exercised — configuration, model lists, analysis, fixes, errors, the library, the local model
routes — then no response body, no error message and no log line contains any key. The existing suite
does this with a canary value that nothing legitimate could echo; that technique should be carried
into the acceptance tier unchanged. It fails on a single occurrence anywhere.

**G3 — A client cannot redirect a keyed provider.** Given a request that supplies its own endpoint
address, when the provider carries an API key, then the supplied address is ignored entirely, because
honouring it would send the user's key to a machine of the caller's choosing. Given a key-less local
endpoint, then an address may be supplied but must be a valid HTTP or HTTPS URL. It fails if any
keyed provider can be pointed anywhere by the request body.

**G4 — Model lists are live where possible and honest where not.** Given a provider that answers,
when the model list is requested, then it shows the live list; given a provider that rejects the key,
then the user is told the key was rejected rather than being shown a plausible fallback list that
hides the problem; given a provider that cannot be reached, then the fallback list is shown and
labelled as a fallback. It fails if a rejected key is indistinguishable from a working one.

**G5 — The journey is the same on every provider.** Given the same prompt and settings, when it is
fixed on the local provider and on an OpenAI-compatible endpoint, then the shape of the result, the
guard behaviour and the before-and-after comparison are identical; only the run details differ. It
fails if any provider has a special path through the fix flow.

**G6 — The API is reachable only from this machine.** Given the server running, when a request
arrives from a non-local origin, then it is refused. It fails if the app is reachable from the
network, since it holds the user's keys.

### Group H — The editor and the results interface

**H1 — The first thirty seconds.** Given a user who has never seen the app, when they open it, then
they see an empty editor with a placeholder that explains what to paste, a small gallery of example
prompts and a button that loads a sample; and when they click one, then the prompt, its task type and
its strength are set, and the score and issues appear — without them having read any documentation.
It fails if a new user has to configure anything before seeing the product work.

**H2 — All eight built-in examples load and lint.** Given each of the eight examples in turn, when it
is chosen, then the prompt text, the task type and the strength are set and every other option the
user had already chosen is left alone, and the result pane populates. It fails if choosing an example
resets unrelated settings, which would quietly discard the user's own configuration.

**H3 — A broken example list is an empty gallery, not a broken app.** Given the examples cannot be
fetched, or arrive malformed, when the app opens, then the gallery is simply absent and everything
else works. It fails if a missing convenience feature can prevent the app from starting.

**H4 — Editing after a fix does the honest thing.** Given a completed fix on screen, when the user
edits the prompt in the editor, then the Issues tab switches to the live analysis of what is now in
the editor and the fix result is parked where it can still be reached, rather than continuing to
display issues for text that no longer exists. It fails if stale analysis is shown as if it were
current, which is the single easiest way for this app to lie to someone.

**H5 — A deliberately pinned older result keeps its tab.** Given the user has stepped back to an
earlier fix in the history, when they continue to edit, then the pinned result owns the Issues tab
and does not jump forward. It fails if navigation and editing fight over the same tab.

**H6 — Apply and undo.** Given a fix result, when the user presses Apply, then the fixed text
replaces the editor content, the live score re-runs against it, and an Undo control appears; when
they press Undo, then the original text returns and the control disappears. And given they have
edited the applied text, then Undo is no longer offered — because reverting to something they never
had would be a lie. It fails if Undo survives an edit, or if it can be used twice.

**H7 — Copy puts the rewrite on the clipboard.** Given a fix result, when the user presses Copy, then
the fixed prompt exactly as displayed is on the clipboard and the user is told it happened. It fails
if the copied text differs from the displayed text in any character.

**H8 — Fix is disabled when it cannot succeed, and says why.** Given each of an empty editor, no
configured provider, a missing local model, a download in progress, and the brief settling window
after a cancellation, when the user looks at the Fix button, then it is disabled and the reason is
visible. It fails if the button is enabled in any state where pressing it produces an error.

**H9 — A remembered model choice is reconciled with the server.** Given the user previously chose a
model tier and the server is now on a different one, when the app opens, then the user's choice is
sent to the server rather than merely displayed in the dropdown. It fails if the interface shows one
model and the next fix uses another.

**H10 — Warnings read like sentences a person wrote.** Given each kind of guard warning, when it is
shown, then the headline matches the kind — rewrote too much, added too much, copied its instructions
— and where the kind is unrecognised the raw explanation is shown rather than a blank or a generic
heading. It fails if a new warning kind renders as an empty banner.

**H11 — The app is usable from the keyboard.** Given a keyboard only, when the user tabs through the
interface, then focus moves in a sensible order and every control is reachable; Ctrl+Enter runs a fix;
Enter on a delete button inside a library row deletes that entry rather than opening it; and Escape
closes the drawer. That third clause exists because a nested control that activates its parent
deletes the wrong thing or opens the wrong entry. It fails if any control is unreachable or if a
nested activation escapes to its container.

**H12 — Text meets contrast requirements.** Given every foreground and background pairing the
interface actually uses, including the faintest secondary text on each surface, when contrast is
measured, then every pair meets the AA threshold. It fails on a single pairing, and the scenario
enumerates the surfaces rather than sampling them.

**H13 — The window works at a small size.** Given a window of 1024 by 720, when the app is used, then
nothing is clipped, no pane scrolls horizontally, and every control remains reachable. It fails if
any content requires horizontal scrolling of the page body.

**H14 — Every action without a visible result reports itself.** Given saving to the library,
importing, exporting, copying and applying, when each completes, then a short confirmation appears
stating the outcome — including the counts for an import. It fails if any of them completes silently,
leaving the user unsure whether it worked.

### Group I — Showing what changed

**I1 — The user can see exactly what changed and nothing is hidden.** Given an original and a
rewrite, when the user opens the Diff tab, then removals and additions are distinguishable at the
level of individual words, and given identical texts, then the diff shows them as identical rather
than as a wholesale replacement. It fails if the diff ever implies more change than occurred, since
the diff is the evidence behind the guard's claims.

**I2 — One changed word in a long document is one changed word.** Given a prompt of well over a
thousand words with a single word inserted, and separately a document of thousands of lines with one
line changed, when each is diffed, then the result identifies the single change and renders within a
comfortable interactive budget. It fails if a long input degrades to a paragraph-level or
whole-document diff, which would make the Diff tab useless exactly when it matters most.

**I3 — A region too large to align is reported, not hidden.** Given a change too large to align word
by word, when it is diffed, then the user is told that region was replaced wholesale rather than
being shown a silently truncated or empty diff. It fails if the fallback is invisible.

### Group J — The CI linter

**J1 — A team can gate its prompts in CI with no server, no model and no key.** Given a checkout with
dependencies installed and no network, when the linter is run over a directory of prompt files with a
minimum score and a severity threshold, then it exits zero for a passing set, and for a failing set it
exits one and names the offending file and what was wrong with it. It fails if anything about it
requires a running server or a downloaded model.

**J2 — The gate uses the same rules as the app.** Given the same text and the same task type, when it
is scored by the linter and by the app, then the score, the categories and the issues are identical.
This is the entire justification for the feature: a gate that disagrees with the tool is worthless. It
fails on any divergence.

**J3 — Directories are searched the way the documentation says.** Given a directory tree containing
markdown, text and prompt files alongside other file types, when the linter is pointed at the
directory, then it recurses, picks up exactly those three extensions, treats each file as one prompt,
and ignores the rest. It fails if any other file type is linted or any of the three is skipped.

**J4 — A file can declare its own task type.** Given a file whose first line is the task-type comment,
when it is linted, then that task type is used and the comment is removed before scoring so it cannot
affect the result; and given files without one, then the task type supplied on the command line
applies, or the general default if none was given. It fails if the comment contributes to the score,
which would make declaring a task type cost points.

**J5 — Machine-readable output is machine-readable.** Given the JSON flag, when the linter runs, then
standard output contains exactly one parseable object carrying every file's score, categories and
issues, and nothing else — no progress lines, no summary; and given the quiet flag, then only the
summary line is printed. A CI job must be able to pipe the output straight into a comment. It fails
if any stray line reaches standard output.

**J6 — A misconfigured job is distinguishable from failing prompts.** Given no paths, an unknown flag,
an unknown task type or a path that does not exist, when the linter runs, then it exits with the
usage code and prints usage on standard error; and only a genuine quality failure exits with the
failure code. A CI job must be able to tell "your prompts are bad" from "your pipeline is broken". It
fails if the two share an exit code.

### Group K — The desktop application

**K1 — Install, run, uninstall, reinstall.** Given the built installer on a clean machine, when it is
run, then the app installs, opens to a working editor, and stores its model and its library outside
the installation directory; and when it is uninstalled and reinstalled, then both are still there. It
fails if an uninstall takes the user's library or a multi-gigabyte model with it.

**K2 — The window opens our interface and nothing else.** Given the app running, when a same-origin
navigation occurs, then it proceeds; when a file is dragged into the window, then the navigation is
blocked and the file is not opened externally; when an external link is followed, then it is blocked
in the window and handed to the system browser; and when an origin that merely resembles ours is
navigated to, then it is blocked. That last clause exists because a prefix check treats a lookalike
host as our own. It fails if any non-local content can render inside the application window.

**K3 — Quitting is deterministic.** Given a loaded model, when the user quits, then the quit is held
until the model has unloaded and then completes; and given an unload that fails, is missing entirely,
or hangs, then the app still quits within a bounded time. It fails if the app can be quit twice into
an inconsistent state or can refuse to quit at all.

**K4 — Configuration is read from where the documentation says.** Given the packaged app, when it
starts, then the per-user configuration file overrides the desktop defaults and any file in the
working directory is ignored. Given the app run from source, then the project file takes precedence
over the per-user one, and a shell variable takes precedence over both. This is four sentences in the
README and four scenarios here, because configuration that is read from an unexpected place is one of
the hardest classes of bug to diagnose from a user's description. It fails on any precedence
inversion.

**K5 — The app finds a free port and its interface finds the app.** Given a port already in use, when
the desktop app starts, then it takes another one and the interface connects to it; and given two
copies started at once, then both work. It fails if the desktop app collides with a running
development server.

**K6 — An unknown API route is a not-found, not the application shell.** Given a request to an API
path that does not exist, when it is made, then it returns not-found rather than the interface HTML.
A typo in a client call must fail loudly rather than resolving to a page that parses as nothing. It
fails if the catch-all route swallows API paths.

### Group L — Configuration, limits and errors

**L1 — Everything has a working default.** Given no configuration file at all, when the app starts,
then it starts, selects the local provider, reports which providers are available, and is fully
usable for linting immediately and for fixing as soon as a model is present. It fails if any
configuration is mandatory.

**L2 — Port precedence and the development proxy.** Given a port in the shell and a different one in
the configuration file, when the server starts, then the shell wins; given only the configuration
file, then it wins; given neither, then the documented default applies; given a port of zero, then it
means "assign one" rather than "unset"; and in every case the development proxy connects to whatever
the server actually used. It fails if the proxy has to be edited by hand after changing the port.

**L3 — Errors have one consistent shape.** Given any failure from any route, when the client receives
it, then it carries a message, the provider where one applies, a code, and whether retrying is worth
it — so the interface can decide what to show from structured fields rather than by matching on error
strings. It fails if any route returns an error the client has to parse textually.

**L4 — The advertised limits are real.** Given each documented limit — sixty thousand characters per
prompt, five hundred library entries, a two-minute provider timeout, ten remembered fixes — when the
user walks up to the boundary and one step past it, then the boundary case works and the case beyond
it is refused or trimmed with an explanation. Every number the README states to a user gets a
scenario, because an advertised limit that is not enforced is a promise the product breaks quietly.

### Group M — Marking a rewrite and fixing it again

**M1 — The model is shown what I marked, and the result says how many marks it was given.** Given a
rewrite in which the user has marked one passage "Keep it — I loved it" and another "Change it — I
didn't like it", when they fix again, then the model is shown the rewrite they marked and both
passages, each under its own verdict; it is still asked to fix the user's original prompt, with the
findings they were shown the first time; the new rewrite contains the kept passage word for word and
no longer contains the other as it was; the run details say how many passages of each kind were
applied and that none was ignored; and the before score is still the score of what the user wrote.
That last clause is B1's, restated: a refinement measured against the previous rewrite instead of
the original would make every second attempt look like no improvement at all. And given a rewrite in
which two words of the kept sentence stand once more on their own, marked for change there, when the
user fixes again, then the model is shown both marks and is told that inside the kept sentence the
kept sentence wins, and a rewrite that rewords those words where they stood alone is accepted at the
first attempt, with no warning. Marks are made on places but travel as text, so "these words are
still somewhere in the rewrite" says nothing about the place the user pointed at. It fails if the
marks reach the model as one undifferentiated list, if fixing again quietly changes what the scores
and the diff are measured against, or if disliking words in one place costs the user the sentence
they kept in another — or earns a retry and a warning for a rewrite that did as it was told.

**M2 — A rewrite that drops a passage I kept is retried, and the faithful attempt is kept.** Given a
model that first paraphrases the sentence the user asked it to keep and leaves the one they disliked
as it was, and then, told so, follows the marks, when the user fixes again, then they receive the
second attempt with no warning, the run details show two attempts, and the retry was told which
passage it had dropped and which it had left as it was — each in quotation marks, under its own
verdict — and was shown the marks again. "Keep this" is the most explicit instruction a user can
give this tool, so ignoring it is treated exactly like throwing their words away under C2. It fails
if a paraphrase of a kept passage is accepted as keeping it, if the retry names a passage under the
wrong verdict, or if it is sent without the marks it is supposed to honour.

**M3 — When the model ignores my marks twice, I still get a result and I am told what was not
honoured.** Given a model that ignores the marks on both attempts, when the fix completes, then the
user still receives a rewrite, a warning says in plain numbers how many kept passages are missing
and how many passages to change are still there, the run details name those passages, and on screen
the warning carries its own headline while the "refined with your marks" note counts only the marks
that were actually followed. A passage to change is "still there" when the rewrite holds it as often
as the marked rewrite did: the words may stand in several places with one of them marked (M1), so
one occurrence fewer is a change and none at all always is. A note that says "one kept, one changed"
directly underneath a warning that says neither happened is the kind of contradiction that teaches
people to ignore both. It fails if the result is withheld, if the warning renders under a blank or
generic heading, or if the note claims credit for a mark the warning admits was ignored.

**M4 — Nonsense marks are coerced, never a server error.** Given marks that arrive as a string, a
number, a list, null, or holding things that are not text, when they are sent, then each request
succeeds as an ordinary fix. Given marks that all point at words which are not in the rewrite, then
it is likewise an ordinary fix — the model is shown no marks and the result mentions none — because
a mark has to point at something. Given a passage marked twice, or padded with spaces, among marks
that point at nothing, then the model is shown it once, trimmed, and nothing else. Given a passage
marked both to keep and to change whose words stand in only one place in the rewrite — or a kept
passage that stands nowhere but inside the passage to change — then the change wins, since a
complaint is the more specific of the two; but given the same words standing in two places and
marked both ways, then the model is shown both marks, and rewording one of the two places honours
both. Marks travel as text but are made on places, so a keep is dropped only when it cannot be told
apart from a change. Given twenty-five passages marked the same way, or one mark 2,500 characters
long, then the model is shown the first twenty, and the first 2,000 characters, and the result
counts twenty — the two limits the README states, held to L4's rule that an advertised number is an
enforced one; the interface stops at the same twenty (M6). And given a marked rewrite longer than a
prompt may be, then it is refused with a message naming the length and the limit, before any model
is contacted. It fails if any malformed shape reaches a property read that throws, if a mark that
matches nothing is passed on to a model that will then go looking for it, if a keep on a different
place is silently discarded because a change uses the same words, or if either limit is a number
only the README knows about.

**M5 — A fix without marks is the fix it always was.** Given no marks, when the user fixes a prompt,
then the model is shown no earlier rewrite and no marks and the result says nothing about them; and
given they have since fixed again with marks, when they fix the same prompt once more without any,
then the model is asked exactly what it was asked the first time and the result is the same. And
given a model whose rewrite holds a `<user_feedback>` slot of its own, for the prompt's user to
fill, when the user fixes with no marks, then the rewrite comes back with the slot intact, after one
attempt and with no warning; and when they mark that rewrite and fix again, the slot is still where
it was, again with no warning. That tag is the one a fix-again wraps the marks in, and a rewrite
that contains it is our instructions pasted back only if the request carried marks — and not even
then if it was already in the rewrite the model was told to start from. The feature is an addition
to the fix journey, not a change to it, and every scenario in Groups B to D depends on that. It
fails if marks linger between requests, if an unmarked fix is told to start from anything but the
user's own prompt, or if the machinery of marks makes the guard suspicious of an ordinary rewrite.

**M6 — I mark what I loved and what I did not.** Given a completed fix on the Fixed tab, when
nothing is selected, then both marking buttons are disabled; when the user selects words outside the
rewrite, or drags from outside into it, then they stay disabled; when a selection starts in the
rewrite and runs on into a toast, then they are disabled too, but when it merely ends where a triple
click leaves it — parked at the start of whatever follows the rewrite, with nothing outside it
selected — then the line can be marked; when they double-click a word of the rewrite and press "Keep
it — I loved it", then exactly that word — not the space a double-click drags along — is highlighted
as kept and the selection is gone; when they drag across a sentence and press "Change it — I didn't
like it", then that sentence is highlighted differently; and the bar counts one kept and one to
change and offers "Fix again with my marks". Given a rewrite longer than the window, scrolled until
the marking bar has stuck above it, when the user drags a selection upwards onto the bar — from
plain text or from a highlight — then the selection stays inside the rewrite and both buttons can be
pressed, and the bar takes the mouse again when the press ends, even a press whose end is never
reported because the window lost the focus. And given twenty kept passages, when another is
selected, then "Keep it — I loved it" is disabled and says that twenty is the most the model is
shown, while the other button is not; removing one highlight makes room. This one is driven with a
real mouse, because the defects it guards against are physical: pressing a button is itself a mouse
press, and a press that clears the selection leaves the button with nothing to mark; a bar that
stays put sits exactly where an upward drag ends. The two selections no mouse can be trusted to make
twice are built in the page instead. It fails if a selection that is not wholly inside the rewrite
can be marked, if the highlight is not the text the user selected, if a drag that strays onto the
bar selects the bar or leaves it dead, or if the bar counts a mark the server will never read (M4).

**M7 — A mark can be changed and taken back.** Given a rewrite with two passages kept and one to
change, when the user drags across a kept passage again and presses the other button, then the newer
verdict replaces the older one; when they click a highlight, then it is removed and the count
follows; when they reach a highlight with the keyboard and press Enter, then it is removed too and
focus moves to a highlight that is left rather than to the top of the page; when they press
Ctrl+Enter in the rewrite or on the bar while a mark is showing, then no fix is started and the mark
is still there — the key is "Fix prompt" everywhere else, and a fresh fix throws marks away; when
they press Clear marks from the keyboard, then every highlight is gone and so is the offer to fix
again, and focus is on the rewrite, which shows no ring for it, rather than at the top of the page;
and when they then click in the rewrite and press Ctrl+Enter, then a fresh fix runs, as it does from
anywhere else. A mark is a decision, and a decision the user cannot revise is one they will be
afraid to make. It fails if any mark, once made, can only be undone by starting over, if
re-selecting a highlighted passage removes the highlight instead of selecting it, if a slip on
Ctrl+Enter costs the user their marks, or if the rewrite swallows the shortcut when there is nothing
to protect.

**M8 — "Fix again with my marks" sends exactly what I marked.** Given one kept passage and one
marked for change, when the user presses Fix again with my marks, from the keyboard, then the model
is shown exactly those two passages and the rewrite they came from; the user is told it was refined,
with the before and after scores; the new rewrite joins the history as "2 of 2"; the What changed
line says it was refined with their marks, one kept and one changed; the new rewrite carries no
highlights and has the focus — the button that held it is disabled while the request runs and gone
when it is back, and neither may drop the focus to the top of the page; and stepping back to the
first rewrite does not bring the old highlights back. Nor does a mark made there outlive a step
forward and back through the history, or a fresh "Fix prompt": leaving a rewrite is what ends its
marks, whichever way it is left. Marks are offsets into one particular text, and painted over any
other text they would highlight nonsense. And given a rewrite in which two words of the kept
sentence stand once more on their own and are marked for change there, when the user fixes again,
then the model is shown one passage to keep and one to change, as the bar counted, and the What
changed line says one kept and one changed, with no warning (M1 is the same journey at the API). It
fails if a highlight survives onto a rewrite it was not made on, if what the model receives differs
from what was highlighted and counted on screen, or if a keyboard user is left at the top of the
page for having pressed the button.

**M9 — The rewrite stays exact while marks are showing.** Given highlights of both kinds, one of two
lines and one of four lines and well over a hundred characters, when the user reads the rewrite or
presses Copy, then the text on screen and the text on the clipboard are the fixed prompt character
for character, with nothing from the marking bar in either; and each highlight is a button whose
name gives a screen reader the verdict and the whole passage, its line breaks read as spaces. H7
promises that what is copied is what is displayed; highlights must not be the thing that breaks it.
And a button's name is all a screen reader is given of it, so a name that stops after sixty
characters leaves a blind user unable to tell what they marked. It fails if a highlight adds, drops
or moves a single character, including a line break, or if the name of a long highlight ends before
the passage does.

**M10 — Marks are readable and fit a small window.** Given a window of 1024 by 720 with both kinds of
highlight, the count and a live selection on screen, when contrast is measured, then every piece of
text — inside both highlight colours and on the bar — meets the AA threshold; nothing scrolls
horizontally; and all four marking controls are on screen. This is H12 and H13 held to the one part
of the interface that paints coloured backgrounds behind the user's text. It fails on a single
pairing below the threshold, or if the bar refuses to wrap.

**M11 — Fixing again still works after I edited the prompt.** Given a completed fix on which the
user marked a passage, when they type a character in the editor, then the rewrite is parked behind
the edited-prompt notice and there is nothing to fix again with; when they delete that character
again, then the rewrite is back with the mark on it; when they change the text in the editor and
press Show last fix, then the parked rewrite comes back with the mark still on it; and when they
press Fix again with my marks, then the new rewrite is shown rather than parked behind the
edited-prompt notice, the model was asked to refine the prompt that rewrite was made for and not the
text now in the editor, and the editor still holds the user's edit. H4 parks a result when the
editor moves on, which is honest for a fix and wrong for a refinement the user has just asked for by
name. And parking is not leaving: marks end with a new fix or a step through the history (M8), not
with a keystroke in another pane. It fails if the user presses the button and appears to get
nothing, or if a slip on the keyboard costs them their marks.

### Group N — Looking the same every time

The user in this group is a developer of PromptFixer who has changed something and wants to know
what it did to the interface. The check is Elastishot: every screen is reached by driving the built
app the way a user would, against the scripted model, and compared with a picture that was approved
on the same machine. The scenarios run the real command-line tool and the two npm scripts around it,
and read the report they write. Their background is that every screen — the empty editor, the
Issues tab, the Fixed tab, the Fixed tab with marks on it, the Diff tab, the Changes tab and the
Library drawer — has been captured and approved at the desktop and the small window size.

**N1 — Every screen, captured again, matches its approved picture.** Given the approved pictures,
when every screen is captured again at both window sizes, then the check passes and no screen
reports a changed, added or removed region at either size. This is the scenario the rest of the
group stands on: a visual check that cries wolf gets switched off within the week, so the first
thing it has to prove is that it can look at the same interface twice and see the same thing —
with a model list that arrives late, a score that appears after a pause, a text cursor that blinks
and a mouse that has to be somewhere. It fails if any of fourteen pictures differs from itself.

**N2 — A rewrite that came back different is reported on the Fixed screen, by name.** Given a model
that now words one line of the rewrite differently — same sections, same scores, same list of
changes — when the Fixed, Issues and Changes screens are captured, then the check fails; the Fixed
screen reports a change no taller than that one line and names the rewrite as the element that
changed, and nothing else; and the Issues and Changes screens, which do not show the rewrite, report
nothing. "Something changed on the Fixed tab" sends a developer hunting; "the rewrite changed,
here" is an answer. It fails if the change goes unnoticed, if it is reported without the element
behind it, or if a screen that does not show the rewrite is blamed for it.

**N3 — Marks are part of the picture.** Given the approved pictures of the Fixed screen with and
without marks, when the two are compared, then the difference names the marking bar, its "Clear
marks" and "Fix again with my marks" buttons and both highlighted passages, each as the mark it is;
each highlighted passage is a reported region; and nothing in the editor pane, and nothing above the
marking bar, is reported. Given both highlights have lost all their paint and nothing has moved,
when the marked screen is captured at both window sizes, then at each size the check fails and names
the two highlighted passages, each with changed pixels behind it, and nothing else. And given the
highlight of a kept passage has lost its green, when the marked screen is captured, then the check
fails and names that highlighted passage and nothing else. Group M proves that marks work; this
proves that they show, and that showing them disturbs nothing else. The second comparison is there
because the first cannot prove it alone: in the small window the bar wraps and pushes the rewrite
down, so a region lies over every passage whatever its highlight looks like, and only taking the
paint away in place shows that there was paint. It fails if a highlight could lose its paint at
either size, or change colour, without the check noticing, or if marking a passage moves something
it has no business moving.

**N4 — What honestly varies between two runs raises no alarm.** Given a model that takes longer to
answer and reports other token counts, and a server whose calendar is weeks ahead so that a saved
prompt carries another date, when the Fixed, Changes and Library screens are captured, then the
check passes and no screen reports a region. The seconds in "Fixed in 1.2s", the run details and the
day a prompt was saved are true, and different every time; a picture that includes them fails on
every honest run. The scenario first confirms that the fix really was slower and the saved prompt
really is dated ahead, so it cannot pass by varying nothing. It fails if a toast, a duration, a
token count or a date reaches a picture.

**N5 — A screen with no approved picture, or a changed look, fails the check until I approve it.**
Given approved pictures that lack one screen, and a Fix prompt button that has been restyled, when
the developer runs `npm run visual`, then it fails: the screen without a picture is reported as new,
with the missing picture as the reason, and the other names the Fix prompt button. When they run
`npm run visual:approve`, then it succeeds, and when they run `npm run visual` again, then it
passes. A check that treats "nothing to compare with" as "nothing changed" passes on every fresh
clone and every new screen, which is exactly when somebody should be looking. It fails if a missing
picture passes silently, or if approving leaves either screen still failing.

**N6 — The one command hands back the verdict and leaves nothing running.** When the developer runs
`npm run visual` on a screen that has not changed, then it exits 0; on a screen that has, it exits 1
and a report a CI job can read has been written, carrying the failure and the element behind it; and
when they mistype the name of a screen, it exits 2 and lists the screens there are. When they run it
against the commit they are working from instead of against approved pictures, having changed that
screen, then it exits 1 and the report names what they changed, although no picture was ever
approved for it: the commit is built and served apart from the working tree, and its screens are
the pictures of that one run. This is the form the pipeline uses on every push, where there are no
approved pictures to be had. After each run the server the command started no longer answers, its
temporary folders are gone, and the commit it compared with is no longer checked out anywhere. The
command starts a model stand-in and a server to have something to photograph, and a wrapper like
that is where an exit code gets swallowed and a process gets orphaned. It fails if any of the
verdicts comes back as another, if the comparison with a commit approves or reads anybody's
pictures, or if a run leaves a server, a folder or a checkout behind — including the run that never
got as far as a capture.

**N7 — Pointed at the wrong place, the check says so and harms nothing.** When the check is run with
no server to look at, then it stops with an error that says to use `npm run visual`. Given a
PromptFixer that somebody is using, with a prompt saved in its library, when the check is pointed at
it, then it stops with an error and the saved prompt is still there. Every screen starts from an
empty library so that one capture cannot leak into the next, and emptying a library is the one
destructive thing this tool does; it may only ever do it to a server that was started for the
purpose. It fails if a developer's saved prompts can be deleted by a test tool aimed at the wrong
port.

---

## Part 4 — Traceability and adoption

### What each group covers, and what it replaces

Group A covers the linter and the scoring model; the rule-level permutations in
`server/analyze.test.js` stay exactly where they are as unit tests underneath it. Groups B and C
cover the fix route and the rewrite guard; roughly twenty of the forty-six tests currently in
`server/e2e.test.js` promote into this tier with new names, and the remainder — the ones that assert
on selection order, extraction and scrubbing internals — stay as component tests in a renamed
`server/fix-guard.test.js`. Group D covers example selection, with `server/store.test.js` retained
beneath it. Group E covers the library and the store. Group F covers the local model lifecycle, with
`server/local.test.js` beneath it. Group G covers the provider layer and the privacy guarantees, with
`server/providers.test.js` beneath it. Group H is the tier we do not currently have at all: the
existing `server/ui.test.js` becomes the unit layer under it and stops being the only thing standing
between us and a broken interface. Group I sits on top of `server/diff.test.js`. Group J is a
straight promotion of `server/cli.test.js`, which is already written in almost the right language.
Group K sits on top of `electron/env.test.js` and `electron/handlers.test.js` and adds the packaged-app
scenarios nothing currently covers. Group L sits on top of `vite.config.test.js` and the
configuration handling. Group M covers marking a rewrite and fixing it again, and sits on two
layers: the mark arithmetic in `src/lib/ui.ts` — adding and removing a mark, every way two marks can
overlap, cutting the rewrite into segments that always join back to the text, the payload, the
gate on the button and the "refined with your marks" note — is unit-tested in `server/ui.test.js`,
and the server's half — coercing the marks, the marks block of the model message, the guard's two
new checks, the retry, which warning wins, the leak scrub and the tie-break between two attempts —
stays as component tests in `server/e2e.test.js`. Group N covers the visual check, with
`scripts/visual.test.js` beneath it for the runner's argument parsing, its approve step, the
exit-code mapping and the shape of `elastishot.config.mjs`; the comparison engine is Elastishot's
and is tested in its own repository.

That leaves exactly one thing with no automated coverage at any tier, and it should stay that way:
whether the rewrites are actually good. `docs/DEMO.md` and its eight before-and-after runs are the
instrument for that, regenerated whenever the linter or the metaprompt changes, and read by a person.

### Adoption order

Do the harness sprint first and change no product behaviour while doing it: extract the server
fixture, replace the marker-driven stub with a scriptable one, add the browser driver, add the
local-model double, wire the two CI jobs. Then adopt the loop on the next story only — three amigos,
scenarios first, red, implement, green, demo — rather than trying to backfill up front every
scenario Part 3 writes for behaviour the product already had, which would be a month of writing tests
for code that already works. A scenario written ahead of its code is not backfill but the loop
itself, which is how Groups M and N arrived.

Backfill opportunistically instead, on two triggers. When a story touches a capability, that
capability's group gets written. When a bug is found, it gets a scenario at the tier that should have
caught it — and if that tier is the acceptance tier, that is a finding about the specification, not
just about the code.

Expect the first two or three stories to feel slower. The cost is front-loaded into conversation and
harness; the return is rework that never happens and a document that answers "is it done?" without a
meeting.
