import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import {
  activeLease,
  appsInState,
  attemptsFor,
  blockingAppForJob,
  createProjection,
  dayOf,
  jobsInWindow,
  requireJob,
} from '../../src/ledger/project.ts'
import { applyEvent } from '../../src/ledger/project.ts'
import type { Projection } from '../../src/ledger/project.ts'
import { AT, DAY, NOW, addApp, addJob, envelope, makeApp } from '../fixtures/helpers.ts'

/** @param projection ledger @param jobId job @returns the job id, for one-line assertions */
function statusOf(projection: Projection, jobId: string): string {
  return projection.jobs.get(jobId)?.status ?? '(missing)'
}

test('job/add fills every index the dedupe engine reads', () => {
  const projection = createProjection()
  const job = addJob(projection, {
    company: '字节跳动',
    title: '后端工程师',
    city: '深圳',
    firstSeenAt: AT,
  })

  assert.equal(projection.byKey.get(`boss:${job.externalId}`), job.id)
  assert.deepEqual(projection.byFingerprint.get(job.fingerprint), [job.id])
  assert.deepEqual(projection.byDay.get(dayOf(AT)), [job.id])
  assert.equal(projection.jobs.size, 1)
})

test('job/add keeps two postings that share a fingerprint', () => {
  const projection = createProjection()
  const first = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  const second = addJob(projection, {
    company: '北京市字节跳动',
    title: '高级后端工程师',
    city: '深圳市',
    externalId: 'other-hr',
  })
  assert.equal(second.fingerprint, first.fingerprint)
  assert.deepEqual(projection.byFingerprint.get(first.fingerprint), [first.id, second.id])
})

test('app state changes move byState and record the states that were reached', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  const app = addApp(projection, job, 'queued')

  assert.deepEqual(appsInState(projection, 'queued').map((item) => item.id), [app.id])

  applyEvent(projection, envelope({ type: 'app/state', appId: app.id, state: 'applying' }))
  assert.deepEqual(appsInState(projection, 'queued'), [])
  assert.deepEqual(appsInState(projection, 'applying').map((item) => item.id), [app.id])
  assert.deepEqual([...(projection.reached.get(app.id) ?? [])].sort(), ['applying', 'queued'])
})

test('re-asserting the current state is a no-op, not an illegal transition', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  const app = addApp(projection, job, 'submitted')
  assert.doesNotThrow(() =>
    applyEvent(projection, envelope({ type: 'app/state', appId: app.id, state: 'submitted' })),
  )
})

test('an application referencing a missing job is refused', () => {
  const projection = createProjection()
  const app = { ...makeApp('j_missing', 'queued') }
  assert.throws(
    () => applyEvent(projection, envelope({ type: 'app/create', app })),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_WRITE')
      return true
    },
  )
})

test('attemptsFor counts attempts only, newest first, across cities', () => {
  const projection = createProjection()
  const applied = addJob(projection, {
    company: '字节跳动',
    title: '后端工程师',
    city: '北京',
    firstSeenAt: new Date(NOW - 10 * DAY).toISOString(),
  })
  addApp(projection, applied, 'submitted', new Date(NOW - 10 * DAY).toISOString())

  const pending = addJob(projection, {
    company: '字节跳动',
    title: '数据工程师',
    city: '深圳',
  })
  addApp(projection, pending, 'queued')

  const backed = addJob(projection, {
    company: '字节跳动',
    title: '前端工程师',
    city: '深圳',
  })
  addApp(projection, backed, 'submitted', new Date(NOW - 3 * DAY).toISOString())

  const attempts = attemptsFor(projection, '字节跳动', '后端工程师')
  assert.deepEqual(attempts.map((app) => app.jobId), [applied.id])
  assert.deepEqual(attemptsFor(projection, '字节跳动', '数据工程师'), [])
  assert.equal(attemptsFor(projection, '字节跳动', '前端工程师').length, 1)
})

test('jobsInWindow filters by age and by city', () => {
  const projection = createProjection()
  const fresh = addJob(projection, {
    company: 'A',
    title: '后端',
    city: '深圳',
    firstSeenAt: new Date(NOW - 2 * DAY).toISOString(),
  })
  addJob(projection, {
    company: 'B',
    title: '后端',
    city: '深圳',
    firstSeenAt: new Date(NOW - 60 * DAY).toISOString(),
  })
  addJob(projection, {
    company: 'C',
    title: '后端',
    city: '北京',
    firstSeenAt: new Date(NOW - 2 * DAY).toISOString(),
  })

  assert.deepEqual(jobsInWindow(projection, NOW, 45, '深圳').map((job) => job.id), [fresh.id])
  assert.equal(jobsInWindow(projection, NOW, 45).length, 2)
  assert.equal(jobsInWindow(projection, NOW, 90).length, 3)
})

test('only blocking states prevent a re-apply', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  const app = addApp(projection, job, 'submitted')
  assert.equal(blockingAppForJob(projection, job.id)?.id, app.id)

  applyEvent(projection, envelope({ type: 'app/state', appId: app.id, state: 'withdrawn' }))
  assert.equal(blockingAppForJob(projection, job.id)?.id, app.id)
})

test('a failed application does not block a retry', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  addApp(projection, job, 'failed')
  assert.equal(blockingAppForJob(projection, job.id), undefined)
})

test('leases expire by timestamp, not by release', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  applyEvent(
    projection,
    envelope({
      type: 'lease/grant',
      jobId: job.id,
      owner: 'run-1',
      expiresAt: new Date(NOW + 60_000).toISOString(),
    }),
  )
  assert.equal(activeLease(projection, job.id, NOW)?.owner, 'run-1')
  assert.equal(activeLease(projection, job.id, NOW + 120_000), undefined)

  applyEvent(projection, envelope({ type: 'lease/release', jobId: job.id }))
  assert.equal(activeLease(projection, job.id, NOW), undefined)
})

test('run events are recorded as facts, with resume keeping the original start', () => {
  const projection = createProjection()
  const startedAt = '2026-11-03T01:00:00.000Z'
  applyEvent(
    projection,
    envelope({
      type: 'run/start',
      runId: 'r_1',
      ids: ['j_1'],
      grantedBy: { kind: 'panel', at: startedAt },
    }, startedAt),
  )
  applyEvent(
    projection,
    envelope({ type: 'run/halt', runId: 'r_1', reason: 'paused' }, '2026-11-03T01:05:00.000Z'),
  )
  applyEvent(
    projection,
    envelope({
      type: 'run/start',
      runId: 'r_1',
      ids: ['j_1'],
      grantedBy: { kind: 'model', at: '2026-11-03T01:10:00.000Z' },
    }, '2026-11-03T01:10:00.000Z'),
  )

  const run = projection.runs.get('r_1')
  assert.equal(run?.startedAt, startedAt)
  assert.equal(run?.grantedBy.kind, 'model')
  assert.deepEqual(run?.halts.map((halt) => halt.reason), ['paused'])
})

test('profile/set merges instead of replacing, and arrays replace wholesale', () => {
  const projection = createProjection()
  applyEvent(
    projection,
    envelope({
      type: 'profile/set',
      profile: { target: { cities: ['深圳'] }, dedupe: { cooldownDays: 30 } },
    }),
  )
  applyEvent(projection, envelope({ type: 'profile/set', profile: { target: { cities: ['北京'] } } }))

  assert.deepEqual(projection.profile.target.cities, ['北京'])
  assert.equal(projection.profile.dedupe.cooldownDays, 30)
  // Untouched defaults survive a partial patch.
  assert.deepEqual(projection.profile.target.excludeKeywords, [
    '销售',
    '外包',
    '驻场',
    '培训',
    '中介',
    '保险',
  ])
})

test('requireJob refuses an unknown id with a coded error', () => {
  assert.throws(
    () => requireJob(createProjection(), 'j_nope'),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_WRITE')
      return true
    },
  )
})

test('job/status updates the stored job', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: '字节跳动', title: '后端工程师', city: '深圳' })
  assert.equal(statusOf(projection, job.id), 'new')
  applyEvent(projection, envelope({ type: 'job/status', jobId: job.id, status: 'queued' }))
  assert.equal(statusOf(projection, job.id), 'queued')
})
