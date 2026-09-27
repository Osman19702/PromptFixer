# What does and does not leave your machine

This page is for whoever approves software where you work. It states exactly what PromptFixer
sends, where it stores what you write, and which of those statements is checked automatically on
every build.

As of version 0.4.0.

## The short version

Out of the box, PromptFixer scores and rewrites prompts using a model that runs on your own
machine. The prompt you type, the rewrite it produces, your saved library and your scores are
written to your own disk and are sent nowhere.

There are exactly two ways anything reaches the internet, and both are things you start:

1. **Downloading the model**, once. A 1–4.7 GB file is fetched from Hugging Face
   (`huggingface.co`). Nothing about your prompts is sent — it is a file download. After it, the
   app works with no network connection at all.
2. **Switching on a cloud provider**, which is off by default. If you do, the prompt you are
   fixing is sent to the provider you chose. Nothing else changes.

There is no telemetry, no analytics, no crash reporting, no licence check and no update check.

## Where your data is stored

| What | Where |
| --- | --- |
| Your prompt library (originals, rewrites, scores) | `%APPDATA%\PromptFixer\data\library.json` on Windows; `~/Library/Application Support/PromptFixer/data/library.json` on macOS; `~/.config/PromptFixer/data/library.json` on Linux. Override with `PROMPTFIXER_DATA_DIR`. |
| The model file | `~/.promptfixer/models`. Override with `PROMPTFIXER_MODEL_DIR`. |
| Your settings and the draft in the editor | Your browser profile's local storage for this app, on your machine. |
| API keys, if you add any | A `.env` file you create, read on the server side only. Keys are never sent to the interface. |

Nothing is encrypted at rest: these are ordinary files with your account's permissions on them.
Treat the library the way you would treat a folder of documents.

## The hosts the app can reach

This is the complete list. Every one is in the source and nothing else is.

| Host | When | What is sent |
| --- | --- | --- |
| `huggingface.co` | Only when you download a model | A file request. No prompt text. |
| `api.anthropic.com` | Only if you select Anthropic | Your prompt and your key |
| `api.openai.com` | Only if you select OpenAI | Your prompt and your key |
| `openrouter.ai` | Only if you select OpenRouter | Your prompt and your key |
| `generativelanguage.googleapis.com` | Only if you select Google | Your prompt and your key |
| `localhost:11434` | Only if you select Ollama | Your prompt, to software on your own machine |
| A host you type yourself | Only if you configure `COMPATIBLE_BASE_URL` | Your prompt, wherever you pointed it |

With no key configured and the built-in model selected — the default — none of these is contacted.

The **What's new** link in the top bar opens
[osman19702.github.io/PromptFixer](https://osman19702.github.io/PromptFixer/) in your own browser
when you click it; that is where the latest release and its notes are. The app itself never
requests that address: there is still no update check, and scenario F11 still holds.

## How the claim is checked

Scenario **F11 — Nothing leaves the machine** runs on every push. It is not a person unplugging a
cable; it is an automated test.

The server is started under a watcher that intercepts the ways code running in it can reach the
network — outbound TCP connections (and so TLS, HTTP, HTTPS and `fetch`), UDP, and name
resolution — and records any destination that is not this machine. A full session then runs: score
a prompt, fix it, save it to the library, list it, export it, import it, and the same session again
through the real interface in a browser. The test fails if the recorded list is not empty.

Three things make that result meaningful rather than decorative:

- **The watcher is proved to work in the same test.** Before the session, a deliberate connection
  to an off-machine address is made and the test asserts it was caught. A watcher that silently
  stopped working would fail here rather than report a clean session.
- **The watcher has its own test suite.** Seventeen checks, each one a way code previously reached
  the network past an earlier version of it — a port given as text rather than a number, a name
  looked up through a route that never opens a socket in the usual way, work moved into a
  background thread or a second program. Every one of those was a real hole, found by trying to
  break the watcher on purpose, and each now has a test that fails if it comes back.
- **The browser half is checked too**, because the prompt is typed into a page. Every request the
  page makes is recorded — from the very first one, before the page has loaded, which is where an
  external font or icon would appear — and must go to the app's own address. Background workers
  are blocked outright, and the page is navigated away at the end so that anything trying to
  report on its way out is caught rather than discarded unsent.

The test also refuses to vouch for a machine configured with a web proxy. A proxy makes every
destination in the world look like an address on your own computer, so a clean result there would
mean nothing; the test says so instead of passing quietly.

## What the test does not cover

Stated plainly, because a security review should know the edges:

- **Code inside the model engine itself.** Inference runs in a compiled library. A compiled library
  can open a connection without the watcher seeing it, and no test written in JavaScript can prove
  otherwise. If you need that ruled out, watch the process from outside — with the operating
  system's own firewall or a packet capture.
- **Another program the app starts.** The watcher cannot see inside a program the server launches.
  It therefore records whenever one is launched at all, and the test fails if that happens during a
  session — so the gap is visible rather than silent. Related: the app used to be able to fetch and
  compile its model engine from source if no ready-made one was found for your machine, which meant
  downloading code without asking. It no longer does; a missing engine is now an error you can see.
- **The desktop build's own window.** The test drives the same page code in a standard browser. In
  the packaged desktop app that page runs inside the application's own window, which has its own
  network machinery underneath it. The page is the same; the layer below it is not covered.
- **The download itself.** The test never downloads a model, which is what makes an empty result
  meaningful. That the download goes to the network is not in dispute; it is the documented
  exception above.
- **Your operating system.** Windows, macOS and Linux do their own name resolution, certificate
  checks and telemetry. That is outside this application.

## Checking it yourself

You do not have to take this page's word for it. Two things you can do:

- Disconnect the machine from the network after the model has downloaded, and use the app. Every
  feature except downloading another model continues to work.
- Run the check yourself: `npm run test:acceptance`, and look for `F11 — Nothing leaves the
  machine`. The report is also attached to each CI run.

## Questions this page does not answer

If you need a signed installer, a software bill of materials, or a statement about the licences of
the app's dependencies, those do not exist yet. Ask before you need them.
