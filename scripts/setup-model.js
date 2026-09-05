#!/usr/bin/env node
/**
 * Download the local model from the command line.
 *
 *   npm run setup            → PROMPTFIXER_MODEL from .env, else the tier
 *                              recommended for this machine's RAM
 *   npm run setup -- quality → a specific tier: lite | default | quality
 *
 * Resumable: a cancelled download picks up where it stopped. Safe to re-run;
 * an already-downloaded model is skipped.
 */

// First, so PROMPTFIXER_MODEL_DIR / PROMPTFIXER_MODEL from .env are visible to
// models.js, which reads them at import time — the same order the server uses.
import 'dotenv/config'
import { createModelDownloader } from 'node-llama-cpp'
import { MODELS, MODEL_DIR, isDownloaded, modelPath, selectedTier, totalRamGb } from '../server/models.js'

const gb = (n) => (n / 1024 ** 3).toFixed(2)
const requested = process.argv[2]
const tier = requested && MODELS[requested] ? requested : selectedTier()
const source = requested ? '' : process.env.PROMPTFIXER_MODEL ? ' (from PROMPTFIXER_MODEL)' : ' (recommended)'

if (requested && !MODELS[requested]) {
  console.error(`Unknown tier "${requested}". Choose one of: ${Object.keys(MODELS).join(', ')}`)
  process.exit(1)
}

const spec = MODELS[tier]
console.log(`\nPromptFixer local model setup`)
console.log(`  Machine RAM : ${totalRamGb().toFixed(1)} GB`)
console.log(`  Tier        : ${tier}${source} — ${spec.label}`)
console.log(`  Size        : ${gb(spec.bytes)} GB`)
console.log(`  Location    : ${modelPath(tier)}\n`)

if (isDownloaded(tier)) {
  console.log('Already downloaded. Nothing to do.\n')
  process.exit(0)
}

const downloader = await createModelDownloader({
  modelUri: spec.uri,
  dirPath: MODEL_DIR,
  showCliProgress: true,
  skipExisting: true,
  deleteTempFileOnCancel: false,
})

await downloader.download()

if (!isDownloaded(tier)) {
  console.error(
    `\nDownload finished at ${downloader.entrypointFilePath} but the file did not pass validation` +
      ` (expected about ${gb(spec.bytes)} GB at ${modelPath(tier)}). Delete it and run setup again.`
  )
  process.exit(1)
}

console.log(`\nDone → ${modelPath(tier)}`)
console.log(`Start the app with:  npm run desktop\n`)
