/**
 * 64-bit SimHash over JD text (TECH §7.3).
 *
 * The threshold is `≤ 3` and it is compared **only within the same city**. That pairing is the
 * whole safety mechanism: a JD alone is not proof of the same posting, but a near-identical JD in
 * the same city, inside 45 days, is. Widening either half is how a job gets silently killed.
 *
 * Tokens are Latin words (2+ chars) and Chinese bigrams. No segmentation: a wrong split would be
 * as harmful as a missed duplicate here, and bigrams degrade gracefully.
 *
 * @module dsh-job-ledger/dedupe/simhash
 */

import { createHash } from 'node:crypto'

import { fold } from './normalize.ts'

/** Bit width of the simhash. */
const BITS = 64

/** Hex chars needed to carry 64 bits. */
const HEX_LENGTH = 16

/** Returned by {@link hammingDistance} when either side has no JD: as far apart as possible. */
export const NO_JD_DISTANCE = BITS

/**
 * Split text into hashing tokens.
 *
 * @param text JD text
 * @returns Latin words plus Chinese bigrams, in text order
 */
export function tokenize(text: string): string[] {
  const folded = fold(text)
  const tokens: string[] = []

  for (const word of folded.match(/[a-z0-9+#.]{2,}/g) ?? []) tokens.push(word)

  for (const run of folded.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
  }

  return tokens
}

/**
 * Compute the SimHash of a JD.
 *
 * @param text JD text
 * @returns 16 hex chars, or `''` when the text has no usable tokens (treated as "no JD")
 */
export function simhash(text: string): string {
  const tokens = tokenize(text)
  if (tokens.length === 0) return ''

  const vector = new Array<number>(BITS).fill(0)
  for (const token of tokens) {
    const digest = createHash('sha1').update(token).digest()
    for (let bit = 0; bit < BITS; bit += 1) {
      const byte = digest[bit >> 3] ?? 0
      const set = ((byte >> (7 - (bit & 7))) & 1) === 1
      vector[bit] = (vector[bit] ?? 0) + (set ? 1 : -1)
    }
  }

  // Ties resolve to 0 so the result is deterministic; an unstable hash would make dedupe unstable.
  let value = 0n
  for (let bit = 0; bit < BITS; bit += 1) {
    if ((vector[bit] ?? 0) > 0) value |= 1n << BigInt(BITS - 1 - bit)
  }
  return value.toString(16).padStart(HEX_LENGTH, '0')
}

/**
 * Hamming distance between two SimHashes.
 *
 * @param left hex hash
 * @param right hex hash
 * @returns bit distance; {@link NO_JD_DISTANCE} when either side has no JD
 */
export function hammingDistance(left: string, right: string): number {
  if (left === '' || right === '') return NO_JD_DISTANCE
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let distance = 0
  while (value > 0n) {
    distance += Number(value & 1n)
    value >>= 1n
  }
  return distance
}

/** @param hash hex hash @returns whether the hash carries a JD (i.e. is comparable) */
export function hasJd(hash: string): boolean {
  return hash !== ''
}
