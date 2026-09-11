/**
 * Reads acceptance/features/*.feature into plain objects: one entry per
 * scenario with its identifier, title, tags and steps. Used by trace.js and
 * the results report.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const featuresDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'features')

export function readScenarios() {
  const scenarios = []
  for (const file of fs.readdirSync(featuresDir).filter((f) => f.endsWith('.feature')).sort()) {
    const lines = fs.readFileSync(path.join(featuresDir, file), 'utf8').split(/\r?\n/)
    let featureTags = []
    let pendingTags = []
    let feature = ''
    let story = []
    let background = []
    let current = null
    let mode = 'none'
    for (const raw of lines) {
      const t = raw.trim()
      if (!t) continue
      if (t.startsWith('@')) {
        pendingTags = t.split(/\s+/)
        continue
      }
      if (t.startsWith('Feature:')) {
        feature = t.slice('Feature:'.length).trim()
        featureTags = pendingTags
        pendingTags = []
        mode = 'story'
        continue
      }
      if (t.startsWith('Background:')) {
        mode = 'background'
        continue
      }
      const m = t.match(/^Scenario(?: Outline)?:\s*([A-L]\d+) — (.+)$/)
      if (m) {
        current = { file, feature, story: story.join(' '), background: [...background], id: m[1], title: m[2], tags: [...featureTags, ...pendingTags], steps: [] }
        scenarios.push(current)
        pendingTags = []
        mode = 'scenario'
        continue
      }
      if (mode === 'story') story.push(t)
      else if (mode === 'background') background.push(t)
      else if (mode === 'scenario' && current) current.steps.push(t)
    }
  }
  return scenarios
}
