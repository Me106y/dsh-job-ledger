import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../src/ledger/store.ts'
import { MAX_SALARY_MIN, SettingsStore, parseSettingsInput } from '../src/settings.ts'
import { DEFAULT_PROFILE, mergeProfile } from '../src/shared/profile.ts'
import type { Profile } from '../src/shared/profile.ts'
import { PluginError } from '../src/shared/errors.ts'

/** @param t test context @returns a temp data directory removed after the test */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param t test context @param base YAML layer @returns a ledger, its settings store, and the dir */
function fixture(
  t: { after(fn: () => void): void },
  base: Profile = DEFAULT_PROFILE,
): { ledger: Ledger; settings: SettingsStore; dir: string } {
  const dir = tempDir(t)
  const ledger = Ledger.open(join(dir, 'events.jsonl'), base)
  t.after(() => {
    ledger.close()
  })
  return { ledger, settings: new SettingsStore(ledger), dir }
}

/** @param ledger open ledger @returns the parsed event lines */
function events(ledger: Ledger): { type: string; profile?: unknown }[] {
  return readFileSync(ledger.file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { type: string; profile?: unknown })
}

test('without profile/set events the YAML target wins', (t) => {
  const base = mergeProfile(DEFAULT_PROFILE, {
    target: { roles: ['后端开发'], cities: ['深圳'], salaryMin: 20_000 },
  })
  const { settings } = fixture(t, base)

  assert.deepEqual(settings.target, {
    roles: ['后端开发'],
    cities: ['深圳'],
    salaryMin: 20_000,
    jobType: 'all',
  })
  assert.deepEqual(settings.profile.target.excludeKeywords, DEFAULT_PROFILE.target.excludeKeywords)
})

test('a panel save appends one profile/set event and applies immediately', (t) => {
  const { ledger, settings } = fixture(t)

  settings.update({ roles: ['后端开发'], cities: ['上海'], salaryMin: 15_000 })

  assert.deepEqual(settings.profile.target.roles, ['后端开发'])
  assert.equal(settings.profile.target.salaryMin, 15_000)
  const written = events(ledger)
  assert.equal(written.length, 1)
  assert.equal(written[0]?.type, 'profile/set')
  assert.deepEqual(written[0]?.profile, {
    target: { roles: ['后端开发'], cities: ['上海'], salaryMin: 15_000, jobType: 'all' },
  })
})

test('the target survives a replay, which is how a restart sees it', (t) => {
  const dir = tempDir(t)
  const first = Ledger.open(join(dir, 'events.jsonl'))
  new SettingsStore(first).update({ roles: ['Java'], cities: ['杭州'], salaryMin: 12_000 })
  first.close()

  const reopened = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => {
    reopened.close()
  })
  assert.deepEqual(new SettingsStore(reopened).target, {
    roles: ['Java'],
    cities: ['杭州'],
    salaryMin: 12_000,
    jobType: 'all',
  })
})

test('an empty list clears a field instead of leaving it alone', (t) => {
  const base = mergeProfile(DEFAULT_PROFILE, { target: { roles: ['后端开发'], cities: ['上海'] } })
  const { settings } = fixture(t, base)

  settings.update({ roles: [] })

  assert.deepEqual(settings.target.roles, [])
  assert.deepEqual(settings.target.cities, ['上海'])
})

test('only the three editable fields are written; the rest of the profile is untouched', (t) => {
  const { settings } = fixture(t)

  settings.update({ roles: ['Java'] })

  assert.deepEqual(settings.profile.target.excludeKeywords, DEFAULT_PROFILE.target.excludeKeywords)
  assert.deepEqual(settings.profile.dedupe, DEFAULT_PROFILE.dedupe)
})

test('input is cleaned: trimmed, de-duplicated, blanks dropped', () => {
  assert.deepEqual(parseSettingsInput({ roles: ['  后端开发 ', '后端开发', '', 'Java'] }), {
    roles: ['后端开发', 'Java'],
  })
})

test('a yuan salary floor is accepted unchanged, not read as thousands', () => {
  assert.equal(MAX_SALARY_MIN, 999_999)
  assert.deepEqual(parseSettingsInput({ salaryMin: 15_000 }), { salaryMin: 15_000 })
  assert.deepEqual(parseSettingsInput({ salaryMin: 999_999 }), { salaryMin: 999_999 })
})

test('input beyond the bounds is refused', () => {
  const tooMany = Array.from({ length: 11 }, (_, index) => `岗位${String(index)}`)
  const tooLong = 'x'.repeat(31)

  for (const body of [
    { roles: tooMany },
    { cities: tooMany },
    { roles: [tooLong] },
    { salaryMin: -1 },
    { salaryMin: 1.5 },
    { salaryMin: 1_000_000 },
    { salaryMin: '20' },
    { roles: 'not an array' },
    [],
    null,
  ]) {
    assert.throws(
      () => parseSettingsInput(body),
      (error: unknown) => error instanceof PluginError && error.code === 'E_INVALID_ARGUMENT',
      JSON.stringify(body),
    )
  }
})

test('unknown fields are ignored so an older host does not reject a newer client', () => {
  assert.deepEqual(parseSettingsInput({ roles: ['Java'], theme: 'dark' }), { roles: ['Java'] })
})

test('求职类型 is a target field that round-trips and rejects unknown values', (t) => {
  const { ledger, settings } = fixture(t)

  settings.update({ jobType: 'intern' })

  assert.equal(settings.target.jobType, 'intern')
  const written = events(ledger)[0] as { profile?: { target?: { jobType?: string } } }
  assert.equal(written.profile?.target?.jobType, 'intern')
  assert.throws(() => parseSettingsInput({ jobType: 'nope' }), { code: 'E_INVALID_ARGUMENT' })
})
