# Acceptance test-driven development for PromptFixer

> **Status (2026-09-09):** the scenarios in Part 3 exist as Gherkin in `acceptance/features/` and
> as executable tests in `acceptance/*.acceptance.test.js` (`npm run test:acceptance`). The first
> iteration's results, including the product defects it found, are in `docs/ATDD-REPORT.md`.

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
a spawned subprocess for the CI linter. An acceptance test never imports an internal module. If a
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

The budget matters more than the tiering. Part 3 defines ninety-five scenarios, and they are not all
equally cheap: the seventy-two that drive the API and the CLI should finish in about two minutes, the
fourteen browser scenarios add a few more, and the nine desktop and real-model scenarios are nightly
because they cannot be made fast. The pull-request gate is therefore capped at eight minutes and the
whole set at around a hundred scenarios. Anything that does not fit pushes down a tier — permutations
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

Pull requests run the unit tier, the component tier, and the acceptance tier for the API, the CLI and
the browser. The nightly run adds the desktop scenarios and the single real-model smoke test on the
GPU box. Packaging is verified nightly, and never from inside the synced project folder.

---

## Part 3 — The acceptance test cases

Ninety-five scenarios in twelve groups: twelve on scoring, ten on the fix journey, ten on the
strength contract, six on learning from the library, seven on the library itself, eleven on the local
model, six on providers and privacy, fourteen on the interface, three on the diff, six on the CI
linter, six on the desktop app and four on configuration and limits. Each is written as a narrative
rather than a table
because the narrative is what the three of us agreed in the room; the identifiers exist only so that
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
configuration handling.

That leaves exactly one thing with no automated coverage at any tier, and it should stay that way:
whether the rewrites are actually good. `docs/DEMO.md` and its eight before-and-after runs are the
instrument for that, regenerated whenever the linter or the metaprompt changes, and read by a person.

### Adoption order

Do the harness sprint first and change no product behaviour while doing it: extract the server
fixture, replace the marker-driven stub with a scriptable one, add the browser driver, add the
local-model double, wire the two CI jobs. Then adopt the loop on the next story only — three amigos,
scenarios first, red, implement, green, demo — rather than trying to backfill all ninety-five
scenarios up front, which would be a month of writing tests for code that already works.

Backfill opportunistically instead, on two triggers. When a story touches a capability, that
capability's group gets written. When a bug is found, it gets a scenario at the tier that should have
caught it — and if that tier is the acceptance tier, that is a finding about the specification, not
just about the code.

Expect the first two or three stories to feel slower. The cost is front-loaded into conversation and
harness; the return is rework that never happens and a document that answers "is it done?" without a
meeting.
