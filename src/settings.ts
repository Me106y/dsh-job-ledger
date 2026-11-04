/**
 * Target settings the panel can edit (PRD §5.10, TECH §11.2).
 *
 * Settings are **ledger events**, not a second config file. `profile/set` already existed for this
 * (PRD §6, TECH §6); the panel is its first writer. That keeps one append-only truth, gives every
 * save a timestamp, and means a replay restores the target without any extra bootstrap.
 *
 * The YAML layer stays the base: `Ledger.open(file, base)` seeds the projection with it, and events
 * merge on top. Only the three fields the panel exposes are ever written here.
 *
 * @module dsh-job-ledger/settings
 */

import type { Ledger } from './ledger/store.ts'
import { PluginError } from './shared/errors.ts'
import type { Profile } from './shared/profile.ts'

/** How many roles (respectively cities) a target may hold. */
export const MAX_TERMS = 10

/** Longest single role or city name. */
export const MAX_TERM_CHARS = 30

/** Salary floor ceiling, in yuan per month. The floor shares `TargetRules.salaryMin`'s unit. */
export const MAX_SALARY_MIN = 999_999

/** The target fields the panel may change. */
export interface TargetSettings {
  readonly roles: readonly string[]
  readonly cities: readonly string[]
  readonly salaryMin: number
}

/** A partial change: an omitted field keeps its current value; an empty array clears it. */
export interface SettingsInput {
  readonly roles?: readonly string[] | undefined
  readonly cities?: readonly string[] | undefined
  readonly salaryMin?: number | undefined
}

/** Anything that can answer "what is the profile now?" — tools and the API both use it. */
export interface ProfileSource {
  readonly profile: Profile
}

/**
 * Keep a list of user-entered terms: trim, drop blanks, remove exact duplicates, enforce bounds.
 *
 * @param value raw input, already known to be an array
 * @param what field name for the error message
 * @returns the cleaned list
 * @throws PluginError `E_INVALID_ARGUMENT` when a term is too long or the list is too long
 */
function cleanTerms(value: readonly unknown[], what: string): string[] {
  const cleaned: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new PluginError('E_INVALID_ARGUMENT', { what: `${what} must be a list of strings` })
    }
    const term = entry.trim()
    if (term === '') continue
    if (term.length > MAX_TERM_CHARS) {
      throw new PluginError('E_INVALID_ARGUMENT', {
        what: `${what} entries must be at most ${String(MAX_TERM_CHARS)} characters`,
      })
    }
    if (!cleaned.includes(term)) cleaned.push(term)
  }
  if (cleaned.length > MAX_TERMS) {
    throw new PluginError('E_INVALID_ARGUMENT', {
      what: `${what} may hold at most ${String(MAX_TERMS)} entries`,
    })
  }
  return cleaned
}

/**
 * Validate an untrusted body into a partial target change.
 *
 * Unknown keys are ignored rather than rejected: a newer client sending a field this host does not
 * know yet should degrade, not fail the save.
 *
 * @param body request body
 * @returns the validated change
 * @throws PluginError `E_INVALID_ARGUMENT` for a wrong shape or an out-of-range value
 */
export function parseSettingsInput(body: unknown): SettingsInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PluginError('E_INVALID_ARGUMENT', { what: 'body must be an object' })
  }
  const record = body as Record<string, unknown>
  const input: { roles?: string[]; cities?: string[]; salaryMin?: number } = {}

  if (record['roles'] !== undefined) {
    if (!Array.isArray(record['roles'])) {
      throw new PluginError('E_INVALID_ARGUMENT', { what: 'roles must be a list of strings' })
    }
    input.roles = cleanTerms(record['roles'], 'roles')
  }
  if (record['cities'] !== undefined) {
    if (!Array.isArray(record['cities'])) {
      throw new PluginError('E_INVALID_ARGUMENT', { what: 'cities must be a list of strings' })
    }
    input.cities = cleanTerms(record['cities'], 'cities')
  }
  if (record['salaryMin'] !== undefined) {
    const salary = record['salaryMin']
    if (typeof salary !== 'number' || !Number.isInteger(salary) || salary < 0 || salary > MAX_SALARY_MIN) {
      throw new PluginError('E_INVALID_ARGUMENT', {
        what: `salaryMin must be an integer between 0 and ${String(MAX_SALARY_MIN)}`,
      })
    }
    input.salaryMin = salary
  }

  return input
}

/** The panel-editable slice of a profile. */
export class SettingsStore implements ProfileSource {
  readonly #ledger: Ledger

  /** @param ledger the single writer; settings live in its projection */
  constructor(ledger: Ledger) {
    this.#ledger = ledger
  }

  /** @returns the effective profile: YAML base with every `profile/set` applied */
  get profile(): Profile {
    return this.#ledger.projection.profile
  }

  /** @returns the three fields the panel shows */
  get target(): TargetSettings {
    const target = this.profile.target
    return { roles: target.roles, cities: target.cities, salaryMin: target.salaryMin }
  }

  /**
   * Merge a change into the target and append it as one event.
   *
   * The ledger writes and fsyncs before `append` returns, so a successful call is durable; a failed
   * one throws and the projection is unchanged.
   *
   * @param input validated change
   * @param now epoch ms for the event timestamp
   * @returns the new target
   */
  update(input: SettingsInput, now: number = Date.now()): TargetSettings {
    const current = this.target
    const next: TargetSettings = {
      roles: input.roles ?? current.roles,
      cities: input.cities ?? current.cities,
      salaryMin: input.salaryMin ?? current.salaryMin,
    }
    this.#ledger.append({
      type: 'profile/set',
      profile: { target: next },
      at: new Date(now).toISOString(),
    })
    return next
  }
}
