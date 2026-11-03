import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultDataDir, expandHome, resolveConfig } from '../src/config.ts'

test('defaults point at the DSH home and the hard-coded limits are not configurable', () => {
  const config = resolveConfig({}, { DSH_HOME: '/tmp/dsh-home' })

  assert.equal(config.dataDir, join('/tmp/dsh-home', 'job-ledger'))
  assert.equal(config.debugPort, 9222)
  assert.equal(config.chromePath, '')
  assert.equal(config.profile.privacy.resumeExposure, 'redacted')
  assert.deepEqual(config.profile.target.excludeKeywords, [
    '销售',
    '外包',
    '驻场',
    '培训',
    '中介',
    '保险',
  ])
})

test('DSH_HOME is honoured, and an explicit dataDir wins over it', () => {
  assert.equal(
    defaultDataDir({ DSH_HOME: '/srv/dsh' }),
    join('/srv/dsh', 'job-ledger'),
  )
  assert.equal(
    resolveConfig({ dataDir: '/data/ledger' }, { DSH_HOME: '/srv/dsh' }).dataDir,
    '/data/ledger',
  )
})

test('a leading tilde is expanded, because YAML authors write it', () => {
  assert.equal(expandHome('~/ledger'), join(homedir(), 'ledger'))
  assert.equal(expandHome('/absolute/path'), '/absolute/path')
  assert.equal(
    resolveConfig({ dataDir: '~/jobs' }, {}).dataDir,
    join(homedir(), 'jobs'),
  )
})

test('config overrides merge into the default profile instead of replacing it', () => {
  const config = resolveConfig({
    target: { cities: ['深圳'], salaryMin: 20_000 },
    dedupe: { cooldownDays: 30 },
  })

  assert.deepEqual(config.profile.target.cities, ['深圳'])
  assert.equal(config.profile.target.salaryMin, 20_000)
  assert.equal(config.profile.dedupe.cooldownDays, 30)
  // Untouched defaults survive.
  assert.deepEqual(config.profile.target.companyBlacklist, [])
  assert.equal(config.profile.reconcile.maxPages, 10)
})
