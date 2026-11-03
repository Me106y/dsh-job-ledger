/**
 * Fixtures shared by the P0 tests.
 *
 * Not a test file: the runner only picks up `*.test.ts`. The point of this module is that every
 * test builds jobs through the *real* normalizers and the *real* SimHash, so a corpus case cannot
 * pass by hand-writing a fingerprint that the ingestion path would never produce.
 *
 * @module dsh-job-ledger/test/fixtures
 */

import type {
  AppState,
  Application,
  EventInput,
  Job,
  JobSource,
  JobStatus,
  LedgerEvent,
} from '../../src/ledger/events.ts'
import { EVENT_VERSION } from '../../src/ledger/events.ts'
import { applyEvent, createProjection } from '../../src/ledger/project.ts'
import type { Projection } from '../../src/ledger/project.ts'
import { fingerprint } from '../../src/dedupe/fingerprint.ts'
import { normalizeCity, normalizeCompany, normalizeTitle } from '../../src/dedupe/normalize.ts'
import { simhash } from '../../src/dedupe/simhash.ts'

/** Fixed clock for every test. Tests that need another time pass it explicitly. */
export const NOW = Date.parse('2026-11-03T00:00:00.000Z')

/** Monotonic suffix for default external ids, so two specs never collide by content. */
let externalSeq = 0

/** Fixed event time, so replay order and `updatedAt` are reproducible. */
export const AT = '2026-11-03T00:00:00.000Z'

/** One day in ms, for readable arithmetic in tests. */
export const DAY = 86_400_000

/** A job description long enough to produce a stable SimHash. */
export const JD_BACKEND =
  '负责后端服务的设计与开发，熟悉 Go 与高并发系统，参与核心交易链路的性能优化，要求五年以上经验'

/** A different job description, same city, that should not be considered similar. */
export const JD_MARKETING =
  '负责品牌营销活动策划与执行，维护社交媒体渠道，撰写宣传文案，要求具备审美与数据分析能力'

/** Everything a test may override when creating a job. */
export interface JobSpec {
  readonly id?: string
  readonly company: string
  readonly title: string
  readonly city: string
  readonly jd?: string
  readonly externalId?: string
  readonly firstSeenAt?: string
  readonly source?: JobSource
  readonly status?: JobStatus
  readonly salaryMin?: number
}

/** @param spec job fields @returns a fully populated job, normalized the way ingestion would */
export function makeJob(spec: JobSpec): Job {
  const companyNorm = normalizeCompany(spec.company)
  const titleNorm = normalizeTitle(spec.title)
  const cityNorm = normalizeCity(spec.city)
  const slug = `${companyNorm}-${titleNorm}-${cityNorm}`.replace(/\s+/g, '')
  return {
    id: spec.id ?? `j_${slug}`,
    platform: 'boss',
    externalId: spec.externalId ?? `ext_${String((externalSeq += 1))}`,
    url: `https://www.zhipin.com/job_detail/${encodeURIComponent(slug)}.html`,
    title: spec.title,
    company: spec.company,
    companyNorm,
    titleNorm,
    city: spec.city,
    cityNorm,
    ...(spec.salaryMin === undefined ? {} : { salaryMin: spec.salaryMin }),
    ...(spec.jd === undefined ? {} : { jdText: spec.jd }),
    jdHash: simhash(spec.jd ?? ''),
    fingerprint: fingerprint(companyNorm, titleNorm, cityNorm),
    firstSeenAt: spec.firstSeenAt ?? AT,
    status: spec.status ?? 'new',
    source: spec.source ?? 'search',
  }
}

/** @param jobId job id @param state initial state @returns an application in that state */
export function makeApp(jobId: string, state: AppState = 'submitted'): Application {
  return {
    id: 'a_1',
    jobId,
    state,
    source: 'applied',
    resumeId: 'online-v1',
    createdAt: AT,
    updatedAt: AT,
  }
}

/** Attach an event envelope, so tests can call the projection directly. */
export function envelope(input: EventInput, at: string = AT): LedgerEvent {
  return { ...input, v: EVENT_VERSION, at } as LedgerEvent
}

/**
 * @param events inputs to apply in order
 * @returns a projection
 */
export function projectionWith(events: readonly EventInput[]): Projection {
  const projection = createProjection()
  for (const input of events) applyEvent(projection, envelope(input))
  return projection
}

/** @param projection state to mutate @param spec job @returns the added job */
export function addJob(projection: Projection, spec: JobSpec): Job {
  const job = makeJob(spec)
  applyEvent(projection, envelope({ type: 'job/add', job }))
  return job
}

/**
 * @param projection state to mutate
 * @param job job to attach the application to
 * @param state initial state
 * @param at event time
 * @returns the added application
 */
export function addApp(
  projection: Projection,
  job: Job,
  state: AppState = 'submitted',
  at: string = AT,
): Application {
  const app = { ...makeApp(job.id, state), id: `a_${job.id}`, createdAt: at, updatedAt: at }
  applyEvent(projection, envelope({ type: 'app/create', app }, at))
  return app
}
