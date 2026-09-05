/**
 * Local model catalog.
 *
 * Three tiers of Qwen instruct models in GGUF Q4_K_M quantisation. All three
 * were verified by size against HuggingFace before being written here; the
 * `bytes` field is used to show download progress and to sanity-check a
 * finished download.
 *
 * Why Qwen: the instruct variants follow structured-output instructions more
 * reliably than similarly sized Llama/Gemma/Phi builds, and the 2507 release
 * of Qwen3-4B is a non-thinking model — no reasoning-mode preamble to strip
 * before the JSON.
 */

import { readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MODEL_DIR =
  process.env.PROMPTFIXER_MODEL_DIR || path.join(os.homedir(), '.promptfixer', 'models')

export const MODELS = {
  lite: {
    id: 'lite',
    label: 'Qwen2.5 1.5B Instruct',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    uri: 'hf:bartowski/Qwen2.5-1.5B-Instruct-GGUF/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    bytes: 986_048_768,
    minRamGb: 4,
    contextSize: 8192,
    blurb: '1.0 GB. Runs on anything. Noticeably simpler rewrites; fine for tightening short prompts.',
  },
  default: {
    id: 'default',
    label: 'Qwen3 4B Instruct (2507)',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    uri: 'hf:unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    bytes: 2_497_281_120,
    minRamGb: 8,
    contextSize: 8192,
    blurb: '2.5 GB. The recommended model: matches 7B-class quality on rewriting at half the size.',
  },
  quality: {
    id: 'quality',
    label: 'Qwen2.5 7B Instruct',
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    uri: 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    bytes: 4_683_074_240,
    minRamGb: 12,
    contextSize: 8192,
    blurb: '4.7 GB. Slightly more nuanced rewrites; needs 12 GB RAM or a 6 GB+ GPU to be pleasant.',
  },
}

export const DEFAULT_TIER = 'default'

export function totalRamGb() {
  return os.totalmem() / 1024 ** 3
}

/** The tier this machine should download if the user has not chosen one. */
export function recommendedTier() {
  // os.totalmem() under-reports by a few hundred MB (firmware/iGPU reservation),
  // so a machine sold as "8 GB" shows ~7.6-7.9 GiB. Round to the marketed size
  // so the threshold means what the catalog says.
  return Math.round(totalRamGb()) < MODELS.default.minRamGb ? 'lite' : DEFAULT_TIER
}

/** Explicit choice via env wins; otherwise recommend from RAM. */
export function selectedTier() {
  const wanted = process.env.PROMPTFIXER_MODEL
  return wanted && MODELS[wanted] ? wanted : recommendedTier()
}

/**
 * node-llama-cpp names a HuggingFace download `hf_<owner>_<filename>` (it also
 * inserts the repo name when the filename does not already start with it — not
 * the case for any tier here). We compute that expected name, but resolution
 * below also scans the directory so a naming-convention change upstream can
 * never make a valid file invisible.
 */
function expectedFileName(spec) {
  // hf:<owner>/<repo>/<file> — the prefix uses the owner, not the repo.
  const [owner] = spec.uri.replace(/^hf:/, '').split('/')
  return `hf_${owner}_${spec.file}`
}

function findOnDisk(spec) {
  const candidates = [expectedFileName(spec), spec.file]
  for (const name of candidates) {
    const full = path.join(MODEL_DIR, name)
    try {
      if (statSync(full).size >= spec.bytes * 0.95) return full
    } catch {
      /* not there */
    }
  }
  try {
    for (const name of readdirSync(MODEL_DIR)) {
      if (!name.endsWith(spec.file)) continue
      const full = path.join(MODEL_DIR, name)
      if (statSync(full).size >= spec.bytes * 0.95) return full
    }
  } catch {
    /* directory missing */
  }
  return null
}

/** Where the model is (or will be) on disk. */
export function modelPath(tier = selectedTier()) {
  const spec = MODELS[tier]
  return findOnDisk(spec) || path.join(MODEL_DIR, expectedFileName(spec))
}

/**
 * The downloader writes to a temp name and renames on completion, so a file
 * with the final name is complete. The size check guards against a truncated
 * copy someone dropped in by hand.
 */
export function isDownloaded(tier = selectedTier()) {
  const spec = MODELS[tier]
  return !!spec && findOnDisk(spec) !== null
}

export function catalog() {
  return Object.values(MODELS).map(({ id, label, bytes, minRamGb, blurb }) => ({
    id,
    label,
    bytes,
    minRamGb,
    blurb,
    recommended: id === recommendedTier(),
  }))
}
