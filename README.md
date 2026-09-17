# PromptFixer

A desktop app that lints, scores and rewrites LLM prompts — with a **built-in local model**, so it
works offline and nothing you type leaves your machine.

Paste a prompt. It's scored instantly against ~30 prompt-engineering rules. Press **Fix prompt**
and the local model rewrites it; the rewrite is re-scored so you can see whether it actually got
better, with a word-level diff and a change log explaining every edit.

Not quite what you wanted? Select any passage of the rewrite and mark it **Keep it — I loved it**
or **Change it — I didn't like it**, then press **Fix again with my marks**. The model revises its
own rewrite instead of starting over — what you kept comes back word for word, what you disliked
gets reworded — and the result is still scored against the prompt you wrote, so every attempt
stays comparable.

Cloud providers (Anthropic, OpenAI, OpenRouter, Gemini, Ollama, any OpenAI-compatible endpoint)
remain available as an optional switch — but nothing requires them.

## Download (Windows)

**[PromptFixer-0.1.0-win-x64.exe](https://github.com/Osman19702/PromptFixer/releases/download/v0.1.0/PromptFixer-0.1.0-win-x64.exe)**
(339 MiB, Windows 10/11 64-bit) from the
[v0.1.0 release](https://github.com/Osman19702/PromptFixer/releases/tag/v0.1.0). The 2.5 GB model
downloads on first run; after that the app works offline.

- SHA-256: `4f49a75fa3b01cbf98cee56100e2afdc14b42b56b1eef3853e47afc010194c2e`, also in the release's
  [`SHA256SUMS.txt`](https://github.com/Osman19702/PromptFixer/releases/download/v0.1.0/SHA256SUMS.txt).
  Check it in PowerShell with `(Get-FileHash .\PromptFixer-0.1.0-win-x64.exe).Hash.ToLower()`.
- The installer is not code-signed yet, so SmartScreen shows "Windows protected your PC": click
  **More info**, then **Run anyway**, once the hash matches.
- Full guide: [docs/INSTALL.md](docs/INSTALL.md).

## Quick start (desktop)

Three commands. Needs Node 20+ and ~3 GB of disk.

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run desktop
```

`npm run setup` downloads the model once (2.5 GB, resumable if interrupted). After that the app
runs with no internet connection. You can skip `setup` and click **Download** inside the app
instead — same thing, with a progress bar.

> If `npm install` warns about install scripts "not yet covered by allowScripts" (npm 11+), the
> approvals are already recorded in `package.json`. If they're somehow missing, run
> `npm install-scripts approve node-llama-cpp electron electron-winstaller`, then
> `node node_modules/electron/install.js` if `node_modules/electron/dist` is empty.

## What's inside

```
PromptFixer/
├── .github/workflows/     ci.yml: every push runs the checks, the tests and the acceptance suite on a Windows runner
│                          release.yml: a pushed tag v<version> builds the installer onto a draft GitHub release;
│                          started by hand it is a rehearsal that releases nothing
├── electron/
│   ├── main.js            Electron main process: starts the server in-process, opens the window
│   ├── env.js             Desktop .env loading (user-data dir) and desktop defaults
│   └── handlers.js        Navigation guard and the deterministic quit/unload handler
├── server/
│   ├── index.js           Express routes; exports start() for Electron
│   ├── analyze.js         The linter: rules, categories, scoring (no model involved)
│   ├── examples.js        The eight sample prompts, served at GET /api/examples
│   ├── metaprompt.js      Rewrite instructions, presets, JSON schema for the output
│   ├── local-llm.js       node-llama-cpp wrapper: download → load → grammar-constrained inference
│   ├── models.js          Model catalog (3 tiers), RAM-based selection, on-disk resolution
│   ├── providers.js       Provider registry: local + cloud adapters, plain fetch, no SDKs
│   ├── store.js           Library persistence (atomic JSON writes)
│   ├── e2e.test.js        End-to-end tests against a stub provider (no key, no model needed)
│   ├── ui.test.js         Unit tests for src/lib/ui.ts, the marks arithmetic included
│   └── cli.test.js        Tests for the prompt-linting CLI
├── scripts/
│   ├── setup-model.js     CLI model download (npm run setup)
│   ├── lint-prompts.js    Lint prompt files in CI (npm run lint:prompts)
│   ├── check-release.mjs  The release gate: version, lock file, changelog and sources agree (npm run check:release)
│   ├── changelog-section.mjs  Prints one version's CHANGELOG.md section; the release notes are cut from it
│   ├── visual.mjs         Visual check runner: build, start stub + server, run Elastishot (npm run visual)
│   └── visual.test.js     Tests for the runner's arguments, approve step and exit codes, and the config's shape
├── src/                   React UI (Vite + TypeScript)
│   ├── App.tsx            State, layout, local-model banner and status
│   ├── components/        ScorePanel, IssueList, DiffView, Library, MarkableOutput (the rewrite and its marks)
│   └── lib/               api.ts (client), diff.ts (word-level LCS diff), ui.ts (view logic and marks, no React)
├── acceptance/            Acceptance scenarios, Groups A–N (npm run test:acceptance; see docs/ATDD.md)
│   ├── features/          The scenarios as Gherkin, one file per group
│   ├── M-feedback.acceptance.test.js     Group M: marking a rewrite and fixing it again (API and browser)
│   ├── N-appearance.acceptance.test.js   Group N: the visual check, run through the real Elastishot CLI
│   ├── support/           Harness: real server, scripted stub provider, Playwright helpers, visual.js (runs Elastishot)
│   └── trace.js           Traceability matrix (npm run test:trace)
├── docs/
│   ├── INSTALL.md         End-user install guide for the Windows download (no Node or npm needed)
│   ├── RELEASING.md       Release checklist: changelog, version bump, tag, the Release workflow, verifying the draft
│   ├── releases/          The release page of each version: download, hash, what is new
│   ├── ATDD.md            Acceptance test-driven development: strategy and the acceptance scenarios
│   └── LOCAL-MODEL.md     Model choice, measured performance, and the train/fine-tune analysis
├── dist/                  Built frontend (npm run build) — served by the server
├── elastishot.config.mjs  Visual check targets: seven screens, each at two window sizes
├── .elastishot/           Approved pictures and run reports of the visual check (per machine, git-ignored)
├── CHANGELOG.md           What changed in each version, for users (Keep a Changelog)
├── .env.example           Optional configuration
└── package.json           Scripts + electron-builder config
```

Model files live outside the project at `~/.promptfixer/models/` so they survive reinstalls and
never end up in a build. The prompt library lives in Electron's per-user data directory whenever
the app runs as a desktop app — `npm run desktop`, `npm run desktop:dev` or the installed build —
for example `%APPDATA%\PromptFixer\data\library.json` on Windows (the folder is named `promptfixer`,
after the package name, when run from source). Only browser mode (`npm run dev`, `npm start`) uses
`server/data/library.json`. Override either with `PROMPTFIXER_DATA_DIR`.

To move a library between machines, `GET /api/library/export` downloads it as
`promptfixer-library-YYYY-MM-DD.json` and `POST /api/library/import` with that file's body merges it
in: entries whose id already exists are skipped, never overwritten, malformed entries are dropped,
and the reply says how many were `imported` and `skipped`.

## The local model

Default is **Qwen3-4B-Instruct-2507** (Q4_K_M, 2.5 GB). Two other tiers are one command away:

| Tier | Model | Size | Needs |
| --- | --- | --- | --- |
| `lite` | Qwen2.5-1.5B-Instruct | 1.0 GB | 4 GB RAM |
| `default` | **Qwen3-4B-Instruct-2507** | 2.5 GB | 8 GB RAM, or a 4 GB+ GPU |
| `quality` | Qwen2.5-7B-Instruct | 4.7 GB | 12 GB RAM, or a 6 GB+ GPU |

```bash
npm run setup -- quality
```

Or pick a tier from the model dropdown in the app (it shows which are downloaded).

**GPU** is detected automatically: CUDA, Vulkan or Metal, with a CPU fallback. On the development
machine (GTX 1660 Ti, Vulkan) the 4B model does ~21 tokens/s — a typical fix takes 15–35 s, plus
~15 s to load the model the first time. Output is grammar-constrained to the result schema, so
the small model can't produce malformed JSON.

Why this model, what it measured, and whether it's worth fine-tuning a smaller one for this job:
**[docs/LOCAL-MODEL.md](docs/LOCAL-MODEL.md)**. Short version: don't train; if you ever must,
it's a LoRA on data this app already collects, and dynamic few-shot from the library gets you
most of the way for free.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Download the local model (`-- lite\|default\|quality` to choose) |
| `npm run desktop` | Build the UI and open the desktop app |
| `npm run desktop:dev` | Open the desktop app without rebuilding |
| `npm run dist:win` | Build a Windows installer into `release/` (`dist:mac`, `dist:linux` likewise) |
| `npm run release:checksums` | Write `release/SHA256SUMS.txt` for the built installers (`-- --check` verifies it; `-- --dir <folder>` targets another folder) |
| `npm run check:release` | The gate a release must pass: `package.json`, `package-lock.json` and `CHANGELOG.md` name the same version and no source file repeats it (`-- --tag v0.2.0`, the form a release uses, also compares the tag name and refuses entries left under [Unreleased]) — see [docs/RELEASING.md](docs/RELEASING.md) |
| `npm run dev` | Browser mode: API (watch) + Vite dev server at http://localhost:5173 |
| `npm start` | Browser mode: serve the built app + API from one port (8787) |
| `npm test` | Unit and component tests — no key, no model download needed |
| `npm run test:acceptance` | The acceptance scenarios in `acceptance/` (see `docs/ATDD.md`) — API, CLI, browser (Playwright), Electron and the visual check (Elastishot, with pictures it approves for itself); needs `npm run build` first and takes about four minutes |
| `npm run test:trace` | Traceability matrix: every scenario in `acceptance/features/` against its automated test |
| `npm run test:report` | Run the acceptance suite and print the results to `docs/ATDD-RESULTS.pdf` |
| `npm run visual` | Visual check with Elastishot: build the UI, start the stub provider and the real server, capture seven screens at two window sizes and compare them with the approved pictures (`-- fixed` for one screen, `-- --no-build` to reuse `dist/`) — see [Visual checks with Elastishot](#visual-checks-with-elastishot) |
| `npm run visual:approve` | Approve the current look as the new baseline — every screen, or only the named ones |
| `npm run typecheck` | TypeScript, no emit |

## Versioning and releases

PromptFixer follows [Semantic Versioning](https://semver.org/) and keeps a
[changelog](CHANGELOG.md). The version is written down once, in `package.json`: the installer's file
name and `GET /api/health` read it, and `npm run check:release` fails when the lock file, the
changelog or a source file disagrees. Every push to any branch is tested on a Windows runner: the
CI workflow runs that check, the typecheck, the build and the unit and component tests in one job
and the acceptance suite in another. A release is cut by pushing a tag `v<version>`; the Release
workflow builds the installer and `SHA256SUMS.txt` onto a draft GitHub release, which is published
by hand once the download has been checked. Started by hand, the same workflow is a rehearsal: it
builds everything on the runner and creates no release. The checklist, and what counts as a patch, a minor or a
breaking change, is in [docs/RELEASING.md](docs/RELEASING.md).

## Lint prompts in CI

`scripts/lint-prompts.js` runs the same deterministic rules as the app over a set of prompt files and exits non-zero when one falls below the bar. No server, no model, no API key.

```
npm run lint:prompts -- <path...> [--intent <id>] [--min-score <n>] [--fail-on high|medium|low|none] [--json] [--quiet]
```

- `<path>` may be files or directories; directories are searched recursively for `*.md`, `*.txt` and `*.prompt`. Each file is one prompt.
- A file can set its own intent with a first-line comment, which is stripped before linting: `<!-- promptfixer: intent=code -->`. `--intent` is the default for files without one (`general` if unset).
- `--json` prints one JSON object with every file's score, categories and issues; `--quiet` prints only the summary line.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every file passed |
| `1` | At least one file scored below `--min-score` (default `0`) or has an issue at or above `--fail-on` (default `high`) |
| `2` | Usage error: no paths, unknown flag or intent, path not found, or no prompt files found |

A minimal GitHub Actions job:

```yaml
name: lint-prompts
on: [push, pull_request]
jobs:
  lint-prompts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint:prompts -- prompts/ --min-score 70 --fail-on high
```

## Visual checks with Elastishot

[Elastishot](https://github.com/Osman19702/elastishot) compares screenshots of the interface with
pictures you approved earlier, and names the element behind every difference — by test id, or by
role and name — instead of just painting pixels red. The acceptance suite proves the interface
works; this proves a change to the CSS or a component did not move, recolour or resize something
you never meant to touch. It is a developer tool: nothing in the app depends on it.

```bash
npm run visual:approve
```

```bash
npm run visual
```

Approve first, compare afterwards. `npm run visual:approve` captures every screen and stores it as
the approved picture; `npm run visual` captures them again and fails on any difference. Both build
the UI (`-- --no-build` reuses `dist/`), start the scripted stub provider and the real server from
`acceptance/support/` on OS-assigned ports with throwaway data and model folders, run Elastishot
over the targets in `elastishot.config.mjs`, and shut everything down again — so no key, no model
and no network are needed, and the rewrite on screen is the same one on every run. A full run of
the fourteen pictures takes 70–80 s on the development machine.

Every screen is reached by driving the page the way a user would, never by sleeping, and is
captured at two window sizes: `desktop` (1360×880, the size the browser scenarios run at) and
`small` (1024×720, the small window scenario H13 guards).

| Screen | What is on it |
| --- | --- |
| `empty` | The app as it opens: empty editor, example gallery |
| `issues` | The sample blog prompt typed in; live score and the Issues tab |
| `fixed` | After **Fix prompt**: the Fixed tab with the rewrite |
| `marked` | The Fixed tab with one passage marked to keep and one marked to change |
| `diff` | The Diff tab |
| `changes` | The Changes tab |
| `library` | The result saved, and the Library drawer open on that one entry |

A screen fails when Elastishot finds a changed, added, removed or moved region on it, or when its
overall similarity drops below 0.98. After changing the look on purpose, run
`npm run visual:approve` again: it writes the pictures that are missing and promotes the ones that
changed.

**One screen.** Name it after `--`: `npm run visual -- fixed` checks that screen at both sizes,
`npm run visual -- marked/small` one size of it, and `npm run visual:approve -- fixed marked`
approves only those two. A mistyped name is an error (exit 2) that lists the screens there are.

**Where things live.** Approved pictures are in `.elastishot/baselines/<screen>/<size>/`
(`baseline.png` plus the element map that lets a difference be named). Every run writes a folder
under `.elastishot/runs/` holding `index.html` (one card per picture — the last line of the output
is its path), a detail page per picture under `pairs/`, `report.json` and `junit.xml` for a CI job;
the text file `.elastishot/runs/latest` names the newest run folder. The whole of `.elastishot/` is
git-ignored, and the baselines are deliberately **per machine and not committed**: fonts and
antialiasing render differently from one machine, GPU and browser build to the next, so another
machine's pictures fail on yours without anything having changed. On a fresh clone there is
nothing to compare with, so `npm run visual` exits 1 with every screen reported as new until you
approve. This is also why `npm run test:all` does not include it. (`npm run test:acceptance` does
cover the machinery: Group N approves its own pictures into `.elastishot/runs/acceptance-*` and
never reads yours.)

Exit codes are Elastishot's, passed through:

| Code | Meaning |
| --- | --- |
| `0` | Every picture matches (for `visual:approve`: everything is approved) |
| `1` | At least one screen differs, or has no approved picture yet |
| `2` | Error: an unknown screen or flag, no build in `dist/` with `--no-build`, a capture that failed, or the config used without the runner |
| `130` | Interrupted with Ctrl+C; the server and its temp folders are still cleaned up |

**What is hidden or masked, and why.** Anything that honestly differs between two runs is kept off
the picture, or every run would fail. Toasts are hidden: they carry elapsed seconds ("Fixed in
1.2s") and leave on a timer. The date on a Library entry is hidden. The Run details strip of the
Changes tab — elapsed time and token counts — is masked, so it shows as a solid block in the
pictures and its contents are not checked. Every capture also ends at rest: mouse parked, nothing
focused or selected, panes scrolled to the top, no spinner on screen; Elastishot itself stops
animations and hides the text caret. And each capture starts by emptying the server's library, so
a prompt saved for the `library` screen cannot turn up in the next one or be learned from by a
later fix. That is the one destructive thing the check does, so the config refuses any server that
was not started by the acceptance harness (it recognises the throwaway model folder) — it cannot
empty a library somebody is using.

**Adding a screen.** A screen is a name and a list of steps in `elastishot.config.mjs`. Copy a line
of `targets` and name the steps that lead to it — the Diff tab is
`screen('diff', typeSample, fix, openTab('Diff'))` — and write a new step where none fits: a step is
an async function of the Playwright page that waits on a real condition, never on a timer. If the
screen shows something that varies, give it a `data-testid` and add it to `hide` or `mask`. Then
add the name to the target list in `scripts/visual.test.js` and to `SCREENS` in
`acceptance/support/visual.js`, and approve it with `npm run visual:approve -- <name>`.

Three environment variables belong to the check, none of them to the app:

| Variable | Purpose |
| --- | --- |
| `PROMPTFIXER_VISUAL_URL` | The server to photograph. `npm run visual` sets it; without it the config refuses to load and says to use the npm script |
| `PROMPTFIXER_VISUAL_BASELINES` | Another folder for the approved pictures (default `.elastishot/baselines`) — Group N uses it to keep away from yours |
| `PROMPTFIXER_VISUAL_VARIANT` | Restyle the page before capture to prove the check notices: `keep-colour` (the keep highlight loses its green), `marks-plain` (both highlights lose all their paint and keep their place), `rewrite-type` (the rewrite in larger type), `fix-button` (a red **Fix prompt** button). Any other name is an error |

## Configuration (optional)

Everything has a working default. Configuration is a plain `.env` file (see `.env.example`); create
it only if you want to change something, and restart the app afterwards. Where it lives depends
on how you run PromptFixer:

| How you run it | `.env` location |
| --- | --- |
| Installed desktop app | Electron's per-user data directory: `%APPDATA%\PromptFixer\.env` on Windows, `~/Library/Application Support/PromptFixer/.env` on macOS, `~/.config/PromptFixer/.env` on Linux |
| `npm run desktop` / `npm run desktop:dev` | The project `.env` (the user-data file is read as a fallback; from source that folder is `promptfixer`) |
| `npm run dev` / `npm start` / `npm run setup` | The project `.env` |

| Variable | Purpose |
| --- | --- |
| `PROMPTFIXER_MODEL` | Force a tier: `lite`, `default`, `quality` (also honoured by `npm run setup`) |
| `PROMPTFIXER_MODEL_DIR` | Where model files are stored (default `~/.promptfixer/models`) |
| `PROMPTFIXER_DATA_DIR` | Where the prompt library is stored (see above for the defaults) |
| `PROMPTFIXER_PRELOAD` | `1` to load the model at startup (the desktop default; `0` to load on first fix) |
| `DEFAULT_PROVIDER` | Provider selected on first load (default `local`) |
| `DEFAULT_MODEL` | Force a specific model id instead of the provider's default |
| `PORT` | Browser-mode port (default `8787`; `npm run dev` proxies to it; the desktop app picks a free one) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY` | Enable a cloud provider |
| `OLLAMA_BASE_URL`, `COMPATIBLE_BASE_URL`, `COMPATIBLE_API_KEY`, `COMPATIBLE_LABEL` | Other local/compatible endpoints (and the name the UI shows for the compatible one) |

Keys stay on the server side and are never sent to the UI.

## How it works

```
prompt
  │
  ├─► analyze.js ──────────► score + issues              (local, deterministic, instant)
  │                              │
  │                              ▼
  └─► metaprompt.js ─► local-llm.js ─► rewrite ─► analyze.js again ─► before/after
                       (GBNF grammar from the JSON schema)
```

The linter runs first and its findings go into the rewrite prompt, so the model fixes the same
problems the UI shows you. The rewrite is re-linted with identical rules, which is what makes the
before/after comparison meaningful.

## Rewrite strength, and the guard behind it

| Strength | What the model may do | Must keep |
| --- | --- | --- |
| Light touch | Spelling, grammar, and only findings fixable from your own text (vague terms, conflicts, missing verb). It never sees "add context / audience / format / limit" findings, so it cannot invent them. | 60% of your words |
| Balanced | Fix the findings and add the missing essentials, using `[placeholders]` for anything it cannot know. | 30% |
| Full rebuild | Restructure freely. | no floor |

Two linter rules were reworked after real use: a length limit is only a defect for prose tasks
(for code, agents and extraction it is a low-priority scope nicety), and placeholders the rewrite
adds deliberately are scored as a reminder, not a defect, so an honest rewrite is never punished
for saying `[product name]` instead of making one up.

Small models don't reliably obey "change as little as possible", so the server checks every rewrite:
how much of your original vocabulary survived, and whether the model pasted its own instructions
into the output. A rewrite that fails is retried once with the reason spelled out; if the retry
fails too, you get the better attempt plus a yellow warning above the result. The Diff tab always
shows exactly what changed.

**Learn from your library.** Every fix also looks through the prompts you saved for up to two whose
original resembles the one being fixed (shared vocabulary, same task type preferred) and whose rewrite
scored higher than its original, and shows them to the model as before/after examples of how much
change you like — their style, not their content. It runs on the library alone, so it costs nothing
and works offline; `meta.examplesUsed` in the response says how many were used, and sending
`options.fewShot: false` turns it off for a request.

**Fix again with your marks.** A fix can also start from an earlier rewrite instead of from scratch.
`POST /api/fix` takes an optional `feedback: { previous, keep, change }` — the rewrite that was
marked, and the passages of it to keep and to change — while `prompt` stays the original, so the
before score, the diff and the strength guard still measure against what you wrote. The model is
shown the marked rewrite with both lists, and the guard gains two checks: every kept passage must
come back word for word, and every passage marked for change must occur fewer times than it did
in the marked rewrite (compared case-sensitively, but blind to how the whitespace falls). Marks
travel as text, not as positions, which is why a change is counted rather than looked for: the
same words may occur three times with one marked, or stand inside a sentence you asked to keep.
The model is told what the guard will accept there: the kept sentence wins and the words are
changed where they stand on their own — or, where they stand nowhere else because the kept
passage itself occurs twice, one copy of it is left word for word and the other reworked. A miss
is retried once with the missed
passages quoted, like any other failure; if the retry misses too, you get the attempt that ignored
fewer marks and a warning of kind `feedback` (`meta.warningKind`) — unless a leak, retention or
growth warning applies, which takes precedence. Marks are coerced rather than refused: passages
that are not in `previous` are dropped, duplicates collapse, a kept passage gives way to one
marked for change only when the two cannot be told apart (the same words where they occur once,
a keep that exists nowhere but inside the passage to change, or — from a direct API call only,
the interface's marks never overlap — kept passages that stand nowhere else and between them
hold every place the words to change stand in, where the fewest that make room give way), each
list stops at 20 passages
and each passage at 2,000 characters, and feedback with nothing usable left is an ordinary fix,
byte for byte. Only a
`previous` over the 60,000-character prompt limit is refused (413). `meta.feedback` in the
response — present only when marks were applied — carries `keep` and `change`, the number of
passages of each kind the model was shown, and `missingKeep` and `unchangedChange`, the passages
it did not honour in the text you were given — every one of them when the reply held no rewrite
at all (the whole message pasted back, or a saved example) and your original is shown in its
place, whatever that original happens to contain.

## Working faster

- **Try an example.** The select in the editor pane head (and the rows shown when the editor is
  empty) loads one of eight built-in prompts covering the main use cases, with the matching task
  type and strength already set. The same list is served at `GET /api/examples`.
- **Fix history.** The last ten results stay in memory. Use the prev/next controls in the results
  pane head ("3 of 5") to compare attempts; the Diff, Issues and Changes tabs follow the selected
  result.
- **Mark the rewrite, then fix again.** On the Fixed tab, select a passage of the rewrite and press
  **Keep it — I loved it** or **Change it — I didn't like it**. Kept passages are highlighted green
  with a ring, passages to change red with a wavy underline — the Diff tab's colours — and the bar
  counts them ("1 kept · 1 to change"). Click a highlight to remove it (from the keyboard, Tab to it
  and press Enter or Space), select it again and press the other button to change your mind, or
  press **Clear marks**. **Fix again with my marks** sends the marked rewrite back to the model and
  keeps the prompt that rewrite was made for as the yardstick — not whatever the editor holds by
  now — so the before score, the Diff tab and the strength guard measure every attempt against the
  same original and the scores stay comparable. The new result joins the fix history, and its What
  changed line ends "refined with your marks (1 kept, 1 changed)", counting only the marks the model
  actually followed. A rewrite that ignores a mark is retried once; if the retry ignores one too,
  you still get the better attempt, under a yellow **Did not follow all of your marks** warning that
  says how many. Marks belong to the one rewrite they were made on: a new fix or a step through the
  history drops them, and stepping back does not bring them back.
- **Undo apply.** After **Apply** replaces your editor text, a one-shot **Undo** restores it.
- **Export / import the library.** Both live in the Library drawer. Export downloads a JSON file;
  Import merges one back in by id, never overwriting an entry you already have, and reports what
  was added and skipped.
- **Use my library as examples.** On by default. Each fix shows the model up to two of your own
  saved rewrites that resemble the current prompt, so the amount and style of change match what
  you kept before. Turn it off in the option toggles; the result line says when examples were used.

## Troubleshooting

- **"Rewrote more than the strength allows" warning** — the model ignored the strength twice.
  Try Balanced, or add an instruction (the **+ Instructions** field) naming what to keep.
- **"Did not follow all of your marks" warning** — after **Fix again with my marks**, the model
  ignored at least one mark on both attempts; the sentence under the headline says how many kept
  passages are missing and how many passages to change are still there, and you are shown the
  better attempt. Mark the result again and fix again, or say what you want instead in the
  **+ Instructions** field. Very short marks cause this most often: a passage is matched as plain
  text and counted, not read word by word, so a change mark on "the" is honoured only once the
  rewrite holds those letters fewer times than before ("other" included), and a model that
  rewords the marked one but writes "the" somewhere new leaves the count where it was. Mark the
  phrase or the sentence.
- **Download interrupted** — run `npm run setup` again; it resumes.
- **"Prompt is too long for the local model"** — the 4B has an 8k-token context shared between
  input and output. Shorten the prompt, or switch to a cloud provider for that one.
- **Slow on CPU** — expected at 5–10 tok/s. Use `lite`, or check the model dropdown shows a GPU
  backend in the status chip once loaded.
- **Model loads on Vulkan but you have an NVIDIA card** — the prebuilt CUDA binary needs a
  compatible CUDA runtime; Vulkan is the fallback and is close in speed for a 4B model.
- **`npm run visual` reports a change you did not make** — the approved pictures are from one
  machine at one moment. Fonts, antialiasing, the GPU, display scaling, a Playwright browser update
  or baselines copied from another machine all move pixels without any code changing. Open the
  report (the last line of the output is its path), check that the element it names is one you did
  not touch, and approve on this machine: `npm run visual:approve`, or
  `npm run visual:approve -- <screen>` for one screen. If the same screen fails on every run with
  nothing changed in between, something on it varies between captures: give it a `data-testid` and
  add it to `hide` or `mask` in `elastishot.config.mjs`.
- **Elastishot run by hand stops with "PROMPTFIXER_VISUAL_URL is not set" or "was not started by the
  acceptance harness"** — neither comes from `npm run visual`. The first means Elastishot was run
  directly (`npx elastishot …`), the second that `PROMPTFIXER_VISUAL_URL` points at a server you are
  using, whose library the check will not empty. Go through `npm run visual`, which starts a
  throwaway server for it.
- **Packaging** — `npm run dist:win` produces an NSIS installer under `release/`. The model is
  *not* bundled (it's per-user in `~/.promptfixer`); the installer is still ~350 MB because it
  ships the prebuilt CPU, Vulkan and CUDA llama.cpp backends so the right one is picked at runtime.
  Binaries for other CPU architectures and llama.cpp's build-from-source bundle are excluded.
- **Packaging fails with `EPERM … rename 'release\win-unpacked.tmp'`** — the project is inside a
  synced folder (OneDrive, Dropbox). The sync agent locks the freshly written tree mid-rename; it
  is timing-dependent, so it can work one time and fail the next. Build to an unsynced folder and
  copy the installer back:

  ```bash
  npm run build && npx electron-builder --win --config.directories.output="$LOCALAPPDATA/PromptFixer/release"
  ```

  Then copy `PromptFixer-*-win-x64.exe` (and its `.blockmap`) from that folder into `release/`,
  or move the project out of the synced folder. Before publishing, write the checksum file with
  `npm run release:checksums` (add `-- --dir <folder>` to hash the unsynced folder directly) and
  attach `SHA256SUMS.txt` to the GitHub release next to the installer.

## Limits

- Prompts are capped at 60,000 characters (cloud) or the model's context (local).
- The library keeps the 500 most recent entries.
- Provider requests time out after 120 s.
