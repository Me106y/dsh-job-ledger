/**
 * Defensive readers for untrusted JSON.
 *
 * Every platform response goes through these. They are deliberately tiny and total: a response
 * that shifted shape in a redesign should degrade to "field missing", which callers turn into a
 * visible error — never into a thrown TypeError three frames deep.
 *
 * @module dsh-job-ledger/shared/json
 */

import { PluginError } from './errors.ts'

/** @param value candidate @returns it as a plain object, when it is one */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** @param value candidate @returns it as an array, or empty */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** @param value candidate @returns it as a non-empty trimmed string, or undefined */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** @param value candidate @returns it as a finite number, or undefined */
export function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Unwrap BOSS's `zpData` envelope, tolerating a bare body.
 *
 * @param payload response body
 * @param label which endpoint, for the error message
 * @returns the payload's data object
 * @throws PluginError `E_BODY_UNAVAILABLE` when the body is not an object at all
 */
export function dataOf(payload: unknown, label: string): Record<string, unknown> {
  const body = record(payload)
  if (body === undefined) {
    throw new PluginError('E_BODY_UNAVAILABLE', { what: `${label} is not an object` })
  }
  return record(body.zpData) ?? record(body.data) ?? body
}
