import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markCandidates } from './capture-screenshot.mjs'

// What SHOT_MARKS=1 may mark in a rewrite nobody has seen yet. Every passage has to be
// something a user could select: a substring of the rewrite, standing in one place only.

const REWRITE = [
  'You are a patient teacher.',
  '',
  '## Task',
  'Explain how machine learning works to a curious beginner.',
  '',
  '## Requirements',
  '- Use at most 200 words.',
  '- Name one everyday example: spam filters or photo tagging.',
  '1. Return 3 to 5 bullet points.',
  '',
  'Keep the tone friendly. Avoid jargon unless you define it first.',
].join('\n')

test('candidates: sentences of the rewrite, without the list and heading signs in front of them', () => {
  assert.deepEqual(markCandidates(REWRITE), [
    'You are a patient teacher.',
    'Explain how machine learning works to a curious beginner.',
    'Use at most 200 words.',
    'Name one everyday example:',
    'spam filters or photo tagging.',
    'Return 3 to 5 bullet points.',
    'Keep the tone friendly.',
    'Avoid jargon unless you define it first.',
  ])
})

test('candidates: each one is a substring of the rewrite, which is what a selection is', () => {
  for (const passage of markCandidates(REWRITE)) assert.ok(REWRITE.includes(passage), passage)
})

test('candidates: too short to read as a highlight, or too long to be one, is skipped', () => {
  const long = `${'word '.repeat(40).trim()}.`
  assert.ok(long.length > 140)
  assert.deepEqual(markCandidates(`Be brief.\n${long}\nReturn exactly three bullet points.`), ['Return exactly three bullet points.'])
})

test('candidates: a passage that stands in two places is nobody\'s mark', () => {
  // It would be highlighted at its first place, wherever the second one is on the picture.
  const twice = 'Keep the answer short.\nUse plain words throughout.\nKeep the answer short.'
  assert.deepEqual(markCandidates(twice), ['Use plain words throughout.'])
  // ...and that includes one that only stands inside a longer sentence as well.
  const inside = 'Use plain words throughout.\nAbove all: Use plain words throughout.'
  assert.deepEqual(markCandidates(inside), [])
})

test('candidates: nothing to mark is an empty list, never a throw', () => {
  for (const nothing of ['', '   \n\n', 'ok', undefined, null]) assert.deepEqual(markCandidates(nothing), [])
})
