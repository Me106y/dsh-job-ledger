import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReport, reportMarkdown } from '../../src/report/build.ts'
import { applyEvent, createProjection } from '../../src/ledger/project.ts'
import type { Projection } from '../../src/ledger/project.ts'
import type { AppSource, AppState } from '../../src/ledger/events.ts'
import { AT, NOW, addJob, envelope, makeApp } from '../fixtures/helpers.ts'

/**
 * @param projection state to mutate
 * @param jobId job
 * @param source where the application came from
 * @param trail states to walk, in order
 * @param createdAt application creation time
 * @returns the application id
 */
function walk(
  projection: Projection,
  jobId: string,
  source: AppSource,
  trail: readonly AppState[],
  createdAt: string = AT,
): string {
  const app = {
    ...makeApp(jobId, trail[0] ?? 'queued'),
    id: `a_${jobId}`,
    source,
    createdAt,
    updatedAt: createdAt,
  }
  applyEvent(projection, envelope({ type: 'app/create', app }, createdAt))
  for (const state of trail.slice(1)) {
    applyEvent(projection, envelope({ type: 'app/state', appId: app.id, state }))
  }
  return app.id
}

test('the funnel counts stages that were reached, not just the current state', () => {
  const projection = createProjection()
  const plain = addJob(projection, { company: 'A', title: '后端', city: '深圳' })
  const rejectedAfterReply = addJob(projection, { company: 'B', title: '后端', city: '深圳' })
  const hired = addJob(projection, { company: 'C', title: '后端', city: '深圳' })

  walk(projection, plain.id, 'applied', ['submitted'])
  walk(projection, rejectedAfterReply.id, 'applied', ['submitted', 'replied', 'rejected'])
  walk(projection, hired.id, 'applied', ['submitted', 'replied', 'interview', 'offer'])

  const report = buildReport(projection, NOW)
  assert.equal(report.funnel.applied, 3)
  // The rejected application was still a reply. Reading only the current state would count 1.
  assert.equal(report.funnel.replied, 2)
  assert.equal(report.funnel.interview, 1)
  assert.equal(report.funnel.offer, 1)
  assert.equal(Math.round(report.funnel.replyRate * 100), 67)
})

test('backfill is excluded from every number but still reported as excluded', () => {
  const projection = createProjection()
  const real = addJob(projection, { company: 'A', title: '后端', city: '深圳' })
  const backfilled = addJob(projection, { company: 'B', title: '后端', city: '深圳' })

  walk(projection, real.id, 'applied', ['submitted'])
  walk(projection, backfilled.id, 'reconcile-backfill', ['submitted'])

  const report = buildReport(projection, NOW)
  assert.equal(report.funnel.applied, 1)
  assert.equal(report.excludedBackfill, 1)
  assert.deepEqual(
    report.sources.map((row) => row.source),
    ['applied'],
  )
  assert.match(reportMarkdown(report), /1 条回填数据未计入/)
})

test('a queued application that was never attempted is not counted', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: 'A', title: '后端', city: '深圳' })
  walk(projection, job.id, 'applied', ['queued'])

  const report = buildReport(projection, NOW)
  assert.equal(report.funnel.applied, 0)
  assert.equal(report.conclusion, '还没有可统计的投递。投出第一批 10 个岗位后再看来源差异。')
})

test('the conclusion names the best source once there is enough data', () => {
  const projection = createProjection()
  for (let index = 0; index < 3; index += 1) {
    const job = addJob(projection, { company: `A${String(index)}`, title: '后端', city: '深圳' })
    walk(projection, job.id, 'applied', ['submitted', 'replied'])
  }

  const report = buildReport(projection, NOW)
  assert.match(report.conclusion, /applied 来源回复率最高/)
  assert.match(report.conclusion, /建议加投/)
})

test('the weekly table has eight buckets ending with the current week', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: 'A', title: '后端', city: '深圳' })
  walk(projection, job.id, 'applied', ['submitted'], AT)

  const report = buildReport(projection, NOW)
  assert.equal(report.weekly.length, 8)
  assert.equal(report.weekly.at(-1)?.weekStart, '2026-11-02')
  assert.equal(report.weekly.at(-1)?.applied, 1)
})

test('markdown export carries all three tables and the conclusion', () => {
  const projection = createProjection()
  const job = addJob(projection, { company: 'A', title: '后端', city: '深圳' })
  walk(projection, job.id, 'applied', ['submitted'])

  const markdown = reportMarkdown(buildReport(projection, NOW))
  assert.match(markdown, /^# 投递报表 · 2026-11-03/)
  assert.match(markdown, /## 漏斗/)
  assert.match(markdown, /## 来源/)
  assert.match(markdown, /## 周趋势/)
  assert.match(markdown, /\| 投递 \| 1 \| 100\.0% \|/)
})
