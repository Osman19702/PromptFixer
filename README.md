# PromptFixer

A desktop app that lints, scores and rewrites LLM prompts — with a **built-in local model**, so it
works offline and nothing you type leaves your machine.

Paste a prompt. It's scored instantly against ~30 prompt-engineering rules. Press **Fix prompt**
and the local model rewrites it; the rewrite is re-scored so you can see whether it actually got
better, with a word-level diff and a change log explaining every edit.

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
│   └── cli.test.js        Tests for the prompt-linting CLI
├── scripts/
│   ├── setup-model.js     CLI model download (npm run setup)
│   └── lint-prompts.js    Lint prompt files in CI (npm run lint:prompts)
├── src/                   React UI (Vite + TypeScript)
│   ├── App.tsx            State, layout, local-model banner and status
│   ├── components/        ScorePanel, IssueList, DiffView, Library
│   └── lib/               api.ts (client), diff.ts (word-level LCS diff)
├── docs/
│   ├── INSTALL.md         End-user install guide for the Windows download (no Node or npm needed)
│   ├── ATDD.md            Acceptance test-driven development: strategy and the acceptance scenarios
│   └── LOCAL-MODEL.md     Model choice, measured performance, and the train/fine-tune analysis
├── dist/                  Built frontend (npm run build) — served by the server
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
| `npm run dev` | Browser mode: API (watch) + Vite dev server at http://localhost:5173 |
| `npm start` | Browser mode: serve the built app + API from one port (8787) |
| `npm test` | Unit and component tests — no key, no model download needed |
| `npm run test:acceptance` | The acceptance scenarios in `acceptance/` (see `docs/ATDD.md`) — API, CLI, browser (Playwright) and Electron; needs `npm run build` first |
| `npm run test:trace` | Traceability matrix: every scenario in `acceptance/features/` against its automated test |
| `npm run test:report` | Run the acceptance suite and print the results to `docs/ATDD-RESULTS.pdf` |
| `npm run typecheck` | TypeScript, no emit |

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

## Working faster

- **Try an example.** The select in the editor pane head (and the rows shown when the editor is
  empty) loads one of eight built-in prompts covering the main use cases, with the matching task
  type and strength already set. The same list is served at `GET /api/examples`.
- **Fix history.** The last ten results stay in memory. Use the prev/next controls in the results
  pane head ("3 of 5") to compare attempts; the Diff, Issues and Changes tabs follow the selected
  result.
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
- **Download interrupted** — run `npm run setup` again; it resumes.
- **"Prompt is too long for the local model"** — the 4B has an 8k-token context shared between
  input and output. Shorten the prompt, or switch to a cloud provider for that one.
- **Slow on CPU** — expected at 5–10 tok/s. Use `lite`, or check the model dropdown shows a GPU
  backend in the status chip once loaded.
- **Model loads on Vulkan but you have an NVIDIA card** — the prebuilt CUDA binary needs a
  compatible CUDA runtime; Vulkan is the fallback and is close in speed for a 4B model.
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
