import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../../src/config.ts'
import { LIMITS } from '../../src/shared/profile.ts'
import { profileView } from '../../src/tools/profile.ts'

test('the limits are the hard-coded ones, not whatever the config says', () => {
  const view = profileView(resolveConfig({}))
  assert.deepEqual(view.limits, { runSize: LIMITS.runSize, daily: LIMITS.daily })
  assert.equal(view.limits.runSize, 10)
  assert.equal(view.limits.daily, 30)
})

test('the view reflects configured targets without inventing values', () => {
  const view = profileView(
    resolveConfig({
      dataDir: '/tmp/ledger',
      target: { cities: ['深圳'], salaryMin: 20_000, excludeKeywords: ['外包'] },
      dedupe: { cooldownDays: 30 },
      privacy: { resumeExposure: 'full' },
    }),
  )

  assert.equal(view.dataDir, '/tmp/ledger')
  assert.deepEqual(view.target.cities, ['深圳'])
  assert.deepEqual(view.target.excludeKeywords, ['外包'])
  assert.equal(view.dedupe.cooldownDays, 30)
  assert.equal(view.privacy.resumeExposure, 'full')
  assert.equal(view.reconcile.maxPages, 10)
})

test('the default privacy level is redacted', () => {
  assert.equal(profileView(resolveConfig({})).privacy.resumeExposure, 'redacted')
})

test('the view is plain JSON, so it can cross the tool boundary', () => {
  const view = profileView(resolveConfig({}))
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})
