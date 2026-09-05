# The local model: what ships, and whether to train your own

## What ships

**Qwen3-4B-Instruct-2507, Q4_K_M GGUF, 2.5 GB.** Runs in-process through `node-llama-cpp`
(llama.cpp bindings). Nothing leaves the machine; the only network call is the one-time download.

| Tier | Model | Size | Needs | When |
| --- | --- | --- | --- | --- |
| `lite` | Qwen2.5-1.5B-Instruct | 1.0 GB | 4 GB RAM | Old laptops. Simpler rewrites. |
| `default` | **Qwen3-4B-Instruct-2507** | 2.5 GB | 8 GB RAM, or any 4 GB+ GPU | **Recommended.** |
| `quality` | Qwen2.5-7B-Instruct | 4.7 GB | 12 GB RAM, or a 6 GB+ GPU | Slightly more nuanced. |

The app picks `default` unless the machine has under 8 GB of RAM. Override with
`PROMPTFIXER_MODEL=lite|default|quality`, `npm run setup -- <tier>`, or the dropdown in the UI.

### Why this model

- **Instruction following for structured output** is the whole job here. Qwen's instruct builds
  do this more reliably than same-size Llama, Gemma or Phi builds in practice.
- **Non-thinking.** The 2507 release of Qwen3-4B is a plain instruct model. The regular Qwen3
  models default to a "thinking" mode that emits a reasoning preamble before the answer — that
  has to be stripped or disabled before you can trust the JSON. Not worth the complexity.
- **4B is the sweet spot.** It benchmarks at or above Qwen2.5-7B on instruction following at half
  the size, fits entirely in a 4–6 GB GPU, and is fast enough on CPU to be usable.

### The engineering decision that matters more than the model

The output is **grammar-constrained**. `server/metaprompt.js` exports the fix result as a JSON
schema; `server/local-llm.js` compiles it to a GBNF grammar and hands it to the sampler. The model
can then only emit tokens that keep the output valid JSON matching that schema. It physically
cannot truncate a string, wrap the answer in prose, or invent a field.

This is most of what people fine-tune small models *for* — format compliance — and it costs
nothing. Every local run in testing returned parseable output on the first try.

### Measured on the development machine

i7-9750H, 17 GB RAM, GTX 1660 Ti 6 GB, Windows 11. `node-llama-cpp` picked the Vulkan backend.

| | |
| --- | --- |
| Model load (one-time per session) | ~15 s |
| First fix, 1,210 tokens in / 633 out | 34 s generation, **21.9 tok/s** |
| Second fix, 819 in / 279 out | 14 s, **20.2 tok/s** |
| Score on the sample prompt | 60 → 91 |

Rough expectations elsewhere: a modern 8 GB+ GPU with CUDA lands at 40–80 tok/s; an Apple M-series
at 25–50; a CPU-only 6-core laptop at 5–10 (a typical fix is then 30–90 s). The `lite` tier
roughly doubles those.

## Should you train a model for this?

Short answer: **no, not yet** — and if you ever do, it's a LoRA on a distilled dataset, not
training from scratch, and not RAG.

### Training from scratch — no

A 1–4B parameter model needs on the order of 1–10 trillion training tokens and thousands of
GPU-hours. That is a six-figure bill to produce something worse than the free Qwen checkpoint
you already have. There is no version of this app where it makes sense.

### Full fine-tuning — no

Updating every weight of a 4B model needs 40–80 GB of GPU memory (or a multi-GPU rig), and it
risks catastrophic forgetting: the model gets better at your format and worse at understanding
prompts about, say, Kubernetes. Since the format problem is already solved by the grammar, you'd
be paying a lot to fix something that isn't broken.

### LoRA / QLoRA — possible, not worth it today

This is the only realistic training path, so here is the honest accounting.

**What it costs.** QLoRA trains a small adapter on top of a 4-bit-quantised base. On a 1.5B model
that fits a 6 GB consumer GPU; on the 4B you want 8–12 GB, so this machine's 1660 Ti is marginal
for the 4B and fine for the 1.5B. A few thousand examples train in 1–3 hours. Tooling is mature:
[Unsloth](https://github.com/unslothai/unsloth) or Hugging Face TRL, then merge the adapter and
convert with llama.cpp's `convert_hf_to_gguf.py`, drop the `.gguf` into `~/.promptfixer/models`,
and register it as a tier in `server/models.js`.

**What you'd need.** 2,000–10,000 pairs of *(weak prompt, options) → (rewritten prompt, change
log, assumptions, questions)*. You don't have that dataset, and hand-writing it is the bottleneck.
The practical route is **distillation**: generate the pairs with a frontier model. This app's cloud
providers already produce exactly the target JSON — every `/api/fix` through Claude or GPT is a
free training example, and the library (`server/data/library.json`) is literally a growing
dataset in the right shape.

**What you'd actually gain.**

1. *A smaller model at the same quality.* A 1.5B tuned on 5k good examples would plausibly match
   the untuned 4B on this narrow task, at 2× the speed and a third of the memory. This matters if
   the target is a weak laptop, not this machine.
2. *Fewer invented details.* This is the one real weakness observed in testing: given "our new
   feature", the 4B produced "our AI-powered workflow automation feature… launched March 2026…
   citing Gartner" instead of `[feature name]`, `[date]`. It flagged them as assumptions, which
   is the intended escape hatch, but a tuned model would use placeholders by reflex. The
   prompt-level mitigation is already in place (an explicit placeholder rule, first in the list);
   a fine-tune is the next rung.
3. *House style, baked in.* If you want every rewrite in a specific shape, tuning beats a long
   system prompt and saves ~500 input tokens per call.

**What you would not gain.** Format reliability (grammar already guarantees it) or general
prompt-engineering knowledge (the base model already has it — it wrote a better prompt than most
humans would on the first try).

**When it becomes worth it.** Either of: a measured quality gap on *your* prompts after a few
hundred real uses, or a deployment target where the 4B is too slow. Not before.

### RAG — wrong tool for the core task, right tool for one sub-feature

Retrieval-augmented generation fetches *knowledge* into the context. Prompt rewriting is a
*transformation* — there is no corpus of facts to retrieve. Bolting a vector store onto this would
add latency and a dependency for nothing.

Where retrieval genuinely helps is **dynamic few-shot**: before each rewrite, pull the one or two
most similar *(before → after)* pairs from the library and inject them as examples. Small models
copy examples far more faithfully than they follow abstract rules, so this closes much of the gap
to a fine-tune for the cost of a similarity lookup — no training, no GPU, and it improves the
moment you save a good result. The library already stores the data in the right shape. This is the
recommended next step, ahead of any fine-tuning.

### Two failure modes seen in testing, and the guard that catches them

Both happened with the 4B model on a 13-word input that wasn't really a prompt.

1. **Copying the linter's examples as content.** The findings say things like *"Return a markdown
   table with columns name, risk, fix"* and *"at most 200 words"* to illustrate the kind of fix.
   At Balanced the model wrote exactly that prompt — unrelated to the input. The linter's example
   values had become the rewrite.
2. **Copying the instructions themselves.** At Light touch, once told to keep the user's words, the
   model kept them — and appended the strength directive and the findings block after them.

Both are the same underlying weakness: a small model doesn't separate *what to edit* from
*how to edit it* when they sit side by side. The fix was structural plus a check, not a bigger
model:

- The user message now puts every instruction in one block first and the prompt to edit alone at
  the end, with an explicit line that the examples are illustrations, not content.
- `validateRewrite()` in `server/metaprompt.js` measures how much of the original vocabulary
  survived (a per-strength floor) and scans for leaked instruction markers. A failing rewrite is
  retried once with the reason spelled out; a second failure returns the better attempt, scrubbed
  of boilerplate, with a warning in the UI.

After the change, the same input at Light touch produced the typo fix and nothing else, with the
model's own summary reading "no actual prompt was provided; preserved as-is". This is the kind of
behaviour a fine-tune would bake in — and the kind that a deterministic check gets you today.

## Recommendation, in order

1. **Ship what's here.** 4B instruct + grammar-constrained JSON + the linter's findings in the
   prompt. Done.
2. **Dynamic few-shot from the library.** ~50 lines: on fix, pick two saved entries with the same
   task type and the largest score gain, truncate, inject as examples. No training.
3. **Collect.** Keep the library. Use a cloud provider for the prompts that matter and save the
   results; that's the dataset if step 4 ever happens.
4. **Only then, QLoRA.** 1.5B if you need speed, 4B if you need quality. Unsloth → merge →
   `convert_hf_to_gguf.py` → new tier in `server/models.js`.

## Privacy and offline behaviour

- The model file lives at `~/.promptfixer/models` (override: `PROMPTFIXER_MODEL_DIR`).
- The library lives in Electron's user-data directory whenever the app runs as a desktop app
  (`npm run desktop`, `npm run desktop:dev`, or the installed build) — e.g.
  `%APPDATA%\PromptFixer\data\library.json` on Windows — and in `server/data/` in browser mode
  (`npm run dev`, `npm start`). Override with `PROMPTFIXER_DATA_DIR`.
- After the one-time download, no network is used unless you deliberately select a cloud provider.
  There is no telemetry.
