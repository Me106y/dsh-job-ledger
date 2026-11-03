import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_JD_DISTANCE,
  hammingDistance,
  hasJd,
  simhash,
  tokenize,
} from '../../src/dedupe/simhash.ts'
import { JD_BACKEND, JD_MARKETING } from '../fixtures/helpers.ts'

test('tokenize splits Latin words and Chinese bigrams', () => {
  assert.deepEqual(tokenize('Go 高并发'), ['go', '高并', '并发'])
})

test('tokenize ignores one-character Latin noise', () => {
  assert.deepEqual(tokenize('a Go b'), ['go'])
})

test('simhash is empty for text with no usable tokens', () => {
  assert.equal(simhash(''), '')
  assert.equal(simhash('!?。'), '')
  assert.equal(hasJd(''), false)
})

test('a placeholder JD is not comparable', () => {
  // Two unrelated one-word postings can land within the Hamming threshold by accident.
  assert.equal(simhash('面议'), '')
  assert.equal(hasJd(simhash('面议')), false)
})

test('simhash is deterministic and 16 hex chars wide', () => {
  const first = simhash(JD_BACKEND)
  const second = simhash(JD_BACKEND)
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{16}$/)
  assert.equal(hasJd(first), true)
})

test('identical descriptions are distance 0 apart', () => {
  assert.equal(hammingDistance(simhash(JD_BACKEND), simhash(JD_BACKEND)), 0)
})

test('unrelated descriptions are far apart', () => {
  const distance = hammingDistance(simhash(JD_BACKEND), simhash(JD_MARKETING))
  assert.ok(distance > 3, `expected a clear separation, got ${String(distance)}`)
})

test('a missing hash is as far away as possible, never "similar"', () => {
  assert.equal(hammingDistance('', simhash(JD_BACKEND)), NO_JD_DISTANCE)
  assert.equal(hammingDistance('', ''), NO_JD_DISTANCE)
})
