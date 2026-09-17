# Changelog

All notable changes to PromptFixer are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). How a release is cut, and what counts as a patch, a
minor or a breaking change while the version starts with 0, is in
[docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Added

- `npm run visual -- --against <ref>` compares the interface with a commit instead of with
  approved pictures: the ref is checked out into `.elastishot/against/<sha>`, built there and
  served by its own server, its screens become the pictures of that one run, and the working tree
  is compared with them. Nothing has to be approved or committed first, and your approved pictures
  are neither read nor written. A screen the ref cannot be driven to is reported as new; a ref no
  screen of which can be captured (v0.1.0, which predates the hooks the check drives the page by)
  is an error that says so.
- CI keeps its reports. A third job compares every screen of a pushed commit with the commit it
  was pushed onto (a pull request: its target branch) and keeps the Elastishot report as the
  `elastishot-report` artifact, with its table as the job's summary page; a difference does not
  fail that job, a comparison that could not be made does. The acceptance job keeps
  `docs/ATDD-RESULTS.pdf` as the run printed it (`acceptance-report`) and shows the traceability
  table as its summary page. Both are kept for 14 days whatever the run's outcome.

## [0.2.0] - 2026-09-17

### Added

- **Fix again with your marks.** On the Fixed tab, select any passage of the rewrite and press
  **Keep it — I loved it** or **Change it — I didn't like it**. Kept passages are highlighted
  green and passages to change red, in the Diff tab's colours, and the bar counts them. **Fix
  again with my marks** sends the marked rewrite back to the model, which revises it instead of
  starting over. The prompt you wrote stays the yardstick, so the before score, the Diff tab and
  the strength guard measure every attempt against the same original and the scores stay
  comparable. Click a highlight to remove it (from the keyboard, Tab to it and press Enter or
  Space), mark it the other way to change your mind, or press **Clear marks**. Up to 20 passages
  of each kind can be marked. Marks belong to the one rewrite they were made on: a new fix or a
  step through the fix history drops them.
- The guard checks your marks the way it checks the strength. Every kept passage has to come back
  word for word, and every passage marked for change has to occur fewer times than it did in the
  marked rewrite. A rewrite that misses a mark is retried once with the missed passages quoted;
  if the retry misses one too, you get the attempt that ignored fewer marks, under a yellow **Did
  not follow all of your marks** warning that says how many. The What changed line of a refined
  result ends "refined with your marks (1 kept, 1 changed)" and counts only the marks the model
  followed. The README's "Rewrite strength, and the guard behind it" has the rules in full.
- For scripts that call the API: `POST /api/fix` takes an optional
  `feedback: { previous, keep, change }` — the rewrite that was marked, and the passages of it to
  keep and to change — while `prompt` stays the original. The response gains `meta.feedback`
  (`keep`, `change`, `missingKeep`, `unchangedChange`), present only when marks were applied, and
  `meta.warningKind` gains a fourth value, `feedback`. Marks are coerced rather than refused:
  passages that are not in `previous` are dropped, duplicates collapse, each list stops at 20
  passages and each passage at 2,000 characters. Only a `previous` over the 60,000-character
  prompt limit is refused (413). A request without `feedback`, or with nothing usable in it, is
  the same fix as in 0.1.0.
- Visual checks for contributors, with [Elastishot](https://github.com/Osman19702/elastishot).
  `npm run visual:approve` stores pictures of seven screens, each at two window sizes, as the
  approved look; `npm run visual` captures them again and fails on any difference, naming the
  element behind it. Both start the scripted stub provider and a throwaway server, so no key, no
  model and no network are needed. The approved pictures are per machine and git-ignored
  (`.elastishot/`), because fonts and antialiasing differ from one machine to the next; for the
  same reason the check is not part of `npm run test:all`. The screens are listed in
  `elastishot.config.mjs`.
- Acceptance Groups M (marking a rewrite and fixing it again, through the API and the browser)
  and N (the visual check, run through the real Elastishot command line). The suite went from 95
  scenarios to 113, of which 102 are automated.
- `scripts/capture-screenshot.mjs` reads `SHOT_PROMPT` (the prompt typed into the editor) and
  `SHOT_INTENT` (the Task type chosen for it), so the app screenshot can show any prompt, not
  only the blog-post sample.
- This changelog, the release checklist in [docs/RELEASING.md](docs/RELEASING.md), and a Release
  workflow that builds the Windows installer when a `v*.*.*` tag is pushed and attaches it, with
  `SHA256SUMS.txt`, to a draft GitHub release. `npm run check:release` is the gate in front of
  it: `package.json`, `package-lock.json` and this file have to name the same version, and no
  source file may repeat it. Started by hand, the same workflow is a rehearsal: it builds
  everything on the runner and creates no release.
- A CI workflow. Every push to any branch, and every pull request from a fork, runs the release
  check, the typecheck, the build and the unit and component tests in one job and the acceptance
  suite with the traceability check in another, both on a Windows runner.
- `scripts/capture-screenshot.mjs` also reads `SHOT_MARKS=1`: the rewrite is marked before the
  picture is taken — one passage kept, one to change, chosen from what the model returned and
  still in view — so the app screenshot can show the marks. `SHOT_KEEP` and `SHOT_CHANGE` name
  the passages instead.

### Changed

- `npm run test:acceptance` takes about four minutes instead of about eighty seconds: each of
  Group N's seven scenarios starts the Elastishot command line and a browser of its own.
- `GET /api/health` reports the version from `package.json` instead of a number written into the
  handler, so it cannot fall behind a release.
- When a fix fails, the error banner is scrolled into view. Pressed from the bottom of a long
  rewrite, a failure used to look like a dead button.
- The score panel, the issue list, the diff, the Library drawer and the date on a Library entry
  carry `data-testid` attributes, so the visual check can name them in a report and keep what
  varies between runs off the pictures.

### Fixed

- Saving to the library on Windows failed when another program — an indexer, antivirus, a backup
  tool — had `library.json` open at that instant, because Windows refuses to rename over an open
  file (`EPERM`, `EBUSY` or `EACCES`). The save now tries the rename again for about a second,
  which outlasts such a reader, and a save that still fails removes its temporary file instead
  of leaving it next to the library.
- The acceptance harness cleans up after a server that fails to start: the child process is
  stopped and its two temp folders are removed. A start that timed out used to leave the server
  running and the folders behind.

## [0.1.0] - 2026-09-11

First public release: a Windows x64 installer.

### Added

- The linter: a prompt is scored as you type against about 30 prompt-engineering rules, with the
  findings grouped by category and severity. It is deterministic and local; no model is involved.
- **Fix prompt** with a built-in local model (Qwen3-4B-Instruct-2507; a 1 GB `lite` tier and a
  4.7 GB `quality` tier are one setting away), so the app works offline and nothing you type
  leaves your machine. The model is downloaded once, resumably, from inside the app or with
  `npm run setup`. CUDA, Vulkan or Metal is picked automatically, with a CPU fallback, and the
  output is grammar-constrained to the result schema.
- Every rewrite is scored again with the same rules, next to a word-level diff and a change log
  that explains each edit.
- Three rewrite strengths (Light touch, Balanced, Full rebuild) and a guard behind them: the
  server checks how much of your vocabulary survived, how much was added, and whether the model
  pasted its own instructions into the output. A failed rewrite is retried once; if the retry
  fails too, you get the better attempt under a yellow warning.
- The Library: save a prompt with its rewrite (the 500 most recent are kept), export it to a
  JSON file and import one back, merged by id without overwriting anything. Each fix shows the
  model up to two of your saved rewrites that resemble the current prompt as examples of how
  much change you like (`options.fewShot: false` turns that off; `meta.examplesUsed` reports it).
- Eight built-in example prompts (also at `GET /api/examples`), a history of the last ten fixes
  with prev/next controls, and a one-shot **Undo** after **Apply**.
- Optional cloud providers: Anthropic, OpenAI, OpenRouter, Gemini, Ollama and any
  OpenAI-compatible endpoint, configured in a `.env` file. Keys stay on the server side and are
  never sent to the interface.
- Two ways to run it: the desktop app (Electron, with the server in-process on a free port and
  the library in the per-user data folder) and browser mode (`npm run dev`, `npm start`).
- `npm run lint:prompts`: the same rules over prompt files, for CI, with exit codes 0, 1 and 2.
- The Windows installer (NSIS, x64, about 355 MB because it ships prebuilt CPU, Vulkan and CUDA
  llama.cpp backends; the model is not bundled). It is not code-signed; `SHA256SUMS.txt`,
  written by `npm run release:checksums`, is attached to the release for checking the download.
- Tests in tiers: unit and component tests (`npm test`), 95 acceptance scenarios in Groups A–L
  that drive the API, the CLI, the browser and the Electron window
  (`npm run test:acceptance`), a traceability matrix (`npm run test:trace`) and a results report
  (`npm run test:report`).

[Unreleased]: https://github.com/Osman19702/PromptFixer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Osman19702/PromptFixer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Osman19702/PromptFixer/releases/tag/v0.1.0
