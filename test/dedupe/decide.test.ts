import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { AppState } from '../../src/ledger/events.ts'
import type { ProfilePatch } from '../../src/shared/profile.ts'
import { decide } from '../../src/dedupe/decide.ts'
import type { Candidate } from '../../src/dedupe/decide.ts'
import { applyEvent, createProjection } from '../../src/ledger/project.ts'
import { envelope, makeApp, makeJob } from '../fixtures/helpers.ts'

interface CorpusApp {
  readonly id: string
  readonly state: AppState
  readonly at: string
}

interface CorpusJob {
  readonly id: string
  readonly company: string
  readonly title: string
  readonly city: string
  readonly jd?: string
  readonly externalId?: string
  readonly firstSeenAt?: string
  readonly apps?: readonly CorpusApp[]
}

interface CorpusCase {
  readonly name: string
  readonly now: string
  readonly profile?: ProfilePatch
  readonly existing?: readonly CorpusJob[]
  readonly candidate: {
    readonly company: string
    readonly title: string
    readonly city: string
    readonly jd?: string
    readonly externalId?: string
  }
  readonly expect: { readonly kind: string; readonly reason: string }
}

const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL('./corpus/cases.json', import.meta.url)), 'utf8'),
) as readonly CorpusCase[]

for (const corpusCase of cases) {
  test(`corpus: ${corpusCase.name}`, () => {
    const projection = createProjection()
    if (corpusCase.profile !== undefined) {
      applyEvent(projection, envelope({ type: 'profile/set', profile: corpusCase.profile }))
    }

    for (const existing of corpusCase.existing ?? []) {
      const job = makeJob(existing)
      applyEvent(projection, envelope({ type: 'job/add', job }))
      for (const app of existing.apps ?? []) {
        const created = {
          ...makeApp(job.id, app.state),
          id: app.id,
          createdAt: app.at,
          updatedAt: app.at,
        }
        applyEvent(projection, envelope({ type: 'app/create', app: created }, app.at))
      }
    }

    const candidate: Candidate = makeJob(corpusCase.candidate)
    const decision = decide(candidate, projection, Date.parse(corpusCase.now))

    assert.equal(decision.kind, corpusCase.expect.kind, `kind for ${corpusCase.name}`)
    assert.equal(decision.reason, corpusCase.expect.reason, `reason for ${corpusCase.name}`)
  })
}

/** @param jobId job @param state app state @param at activity time @returns an application */
function appAt(jobId: string, state: AppState, at: string) {
  return { ...makeApp(jobId, state), createdAt: at, updatedAt: at }
}

test('same platform id wins before any other check', () => {
  const projection = createProjection()
  const job = makeJob({
    company: '字节跳动',
    title: '后端工程师',
    city: '深圳',
    externalId: 'same-id',
  })
  applyEvent(projection, envelope({ type: 'job/add', job }))

  const decision = decide(
    { ...job, title: '完全不同', titleNorm: '完全不同', jdHash: '' },
    projection,
    Date.parse('2026-11-03T00:00:00.000Z'),
  )
  assert.deepEqual(decision, {
    kind: 'duplicate',
    reason: 'same-posting',
    duplicateOf: job.id,
  })
})

test('dedupe runs before the filter, so the reason the user sees is the real one', () => {
  const projection = createProjection()
  const job = makeJob({
    company: '字节跳动',
    title: '销售经理',
    city: '深圳',
    firstSeenAt: '2026-10-24T00:00:00.000Z',
  })
  applyEvent(projection, envelope({ type: 'job/add', job }))

  const decision = decide(
    makeJob({ company: '字节跳动', title: '销售经理', city: '深圳' }),
    projection,
    Date.parse('2026-11-03T00:00:00.000Z'),
  )
  // 销售 is also an excluded keyword; the duplicate verdict must win or the user would
  // conclude their filters are too tight.
  assert.equal(decision.kind, 'duplicate')
  assert.equal(decision.reason, 'same-role-company')
})

test('the city filter applies only when the profile names cities', () => {
  const projection = createProjection()
  applyEvent(
    projection,
    envelope({ type: 'profile/set', profile: { target: { cities: ['深圳'] } } }),
  )
  const now = Date.parse('2026-11-03T00:00:00.000Z')

  assert.equal(
    decide(makeJob({ company: 'A', title: '后端', city: '杭州' }), projection, now).reason,
    'city-mismatch',
  )
  assert.equal(
    decide(makeJob({ company: 'A', title: '后端', city: '远程' }), projection, now).reason,
    'new',
  )
})

test('the salary floor only applies when the posting is parseable', () => {
  const projection = createProjection()
  applyEvent(projection, envelope({ type: 'profile/set', profile: { target: { salaryMin: 30000 } } }))
  const now = Date.parse('2026-11-03T00:00:00.000Z')

  assert.equal(
    decide(
      makeJob({ company: 'A', title: '后端', city: '深圳', salaryMin: 20000 }),
      projection,
      now,
    ).reason,
    'salary-below-floor',
  )
  assert.equal(
    decide(makeJob({ company: 'A', title: '后端', city: '深圳' }), projection, now).reason,
    'new',
  )
})

test('a cooldown verdict points at the application that caused it', () => {
  const projection = createProjection()
  const job = makeJob({
    company: '美团',
    title: '前端工程师',
    city: '北京',
    firstSeenAt: '2026-10-14T00:00:00.000Z',
  })
  applyEvent(projection, envelope({ type: 'job/add', job }))
  applyEvent(
    projection,
    envelope({ type: 'app/create', app: appAt(job.id, 'submitted', '2026-10-24T00:00:00.000Z') }),
  )

  const decision = decide(
    makeJob({ company: '美团', title: '前端工程师', city: '深圳' }),
    projection,
    Date.parse('2026-11-03T00:00:00.000Z'),
  )
  assert.equal(decision.reason, 'cooldown')
  assert.equal(decision.duplicateOf, job.id)
})
