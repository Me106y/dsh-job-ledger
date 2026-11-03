/**
 * Ingestion: turn raw cards into events, with the dedupe verdict attached (PRD §5.2, §5.3).
 *
 * Discovery and dedupe happen in **one pass**, so no job is ever briefly "in the ledger but not yet
 * judged" — that intermediate state is exactly where a second applier of the same batch would find
 * a gap.
 *
 * A duplicate writes **nothing**. Recording it every time a scan sees it would grow the log without
 * bound, and the log is the product; the verdict is still returned and counted, and it points at
 * the posting that already owns the identity. Everything else — new, suspect, filtered — is
 * recorded, because a filtered job must be recoverable and a suspect one must reach a human
 * (PRD §5.3).
 *
 * @module dsh-job-ledger/discover/ingest
 */

import { randomUUID } from 'node:crypto'

import type { Candidate } from '../dedupe/decide.ts'
import { decide } from '../dedupe/decide.ts'
import { fingerprint } from '../dedupe/fingerprint.ts'
import { normalizeCity, normalizeCompany, normalizeTitle, normalizeUrl } from '../dedupe/normalize.ts'
import { simhash } from '../dedupe/simhash.ts'
import type { Job, JobSource, JobStatus } from '../ledger/events.ts'
import type { Ledger } from '../ledger/store.ts'
import type { RawJob } from './parse.ts'
import { DISCOVERY_LIMIT } from './read.ts'

/** JD truncation, so one posting cannot blow past the ledger's line cap (TECH §6.2). */
export const MAX_JD_CHARS = 20_000

/** What ingestion produced, for the tool and the tests. */
export interface IngestResult {
  readonly added: number
  readonly duplicates: number
  readonly filtered: number
  readonly suspects: number
  readonly invalid: number
  readonly decisions: readonly IngestDecision[]
}

/** One verdict, kept in order so the caller can show it without replaying the ledger. */
export interface IngestDecision {
  /** Present when the posting entered the ledger; absent for a duplicate, which is not recorded. */
  readonly jobId?: string
  readonly externalId: string
  readonly kind: string
  readonly reason: string
  readonly duplicateOf?: string
}

/** Knobs that tests need to pin down. */
export interface IngestOptions {
  /** Epoch ms; one timestamp for the whole batch keeps a replayed batch identical. */
  readonly now?: number
  /** Id factory, so tests get stable ids. */
  readonly newId?: () => string
  /** Where the batch came from. */
  readonly source?: JobSource
  /** Cards rejected before ingestion, carried through to the summary event. */
  readonly invalid?: number
}

/**
 * Normalize one card into a candidate.
 *
 * @param raw card from the list endpoint
 * @returns the candidate the decision engine consumes
 */
export function candidateFor(raw: RawJob): Candidate {
  const companyNorm = normalizeCompany(raw.company)
  const titleNorm = normalizeTitle(raw.title)
  const cityNorm = normalizeCity(raw.city ?? '')
  const jdText = raw.jdText === undefined ? undefined : raw.jdText.slice(0, MAX_JD_CHARS)

  return {
    platform: 'boss',
    externalId: raw.externalId ?? normalizeUrl(raw.url ?? ''),
    company: raw.company,
    title: raw.title,
    city: raw.city ?? '',
    companyNorm,
    titleNorm,
    cityNorm,
    jdHash: jdText === undefined ? '' : simhash(jdText),
    ...(jdText === undefined ? {} : { jdText }),
    ...(raw.salaryMin === undefined ? {} : { salaryMin: raw.salaryMin }),
  }
}

/** @param kind verdict @returns the job status that verdict implies */
function statusFor(kind: string): JobStatus {
  if (kind === 'duplicate') return 'skipped'
  if (kind === 'filtered') return 'filtered'
  return 'new'
}

/**
 * Ingest one batch.
 *
 * @param ledger the single writer
 * @param rawJobs valid cards from one discovery pass
 * @param options clock, id factory, source, invalid count
 * @returns counts and verdicts
 */
export function ingestJobs(
  ledger: Ledger,
  rawJobs: readonly RawJob[],
  options: IngestOptions = {},
): IngestResult {
  const now = options.now ?? Date.now()
  const at = new Date(now).toISOString()
  const newId = options.newId ?? ((): string => `j_${randomUUID()}`)
  const source = options.source ?? 'search'
  const invalid = options.invalid ?? 0

  let added = 0
  let duplicates = 0
  let filtered = 0
  let suspects = 0
  const decisions: IngestDecision[] = []

  for (const raw of rawJobs.slice(0, DISCOVERY_LIMIT)) {
    const candidate = candidateFor(raw)
    const decision = decide(candidate, ledger.projection, now)

    const job: Job = {
      id: newId(),
      platform: 'boss',
      externalId: candidate.externalId,
      url: raw.url ?? `https://www.zhipin.com/job_detail/${encodeURIComponent(candidate.externalId)}.html`,
      title: raw.title,
      company: raw.company,
      companyNorm: candidate.companyNorm,
      titleNorm: candidate.titleNorm,
      city: raw.city ?? '',
      cityNorm: candidate.cityNorm,
      ...(raw.salaryRaw === undefined ? {} : { salaryRaw: raw.salaryRaw }),
      ...(raw.salaryMin === undefined ? {} : { salaryMin: raw.salaryMin }),
      ...(candidate.jdText === undefined ? {} : { jdText: candidate.jdText }),
      jdHash: candidate.jdHash,
      fingerprint: fingerprint(candidate.companyNorm, candidate.titleNorm, candidate.cityNorm),
      ...(raw.postedAt === undefined ? {} : { postedAt: raw.postedAt }),
      firstSeenAt: at,
      status: statusFor(decision.kind),
      source,
    }

    // A duplicate is not recorded: re-scanning the same posting must not append events forever.
    if (decision.kind !== 'duplicate') {
      ledger.append({ type: 'job/add', job, at })
      ledger.append({
        type: 'job/decision',
        jobId: job.id,
        decision: decision.kind,
        reason: decision.reason,
        ...(decision.duplicateOf === undefined ? {} : { duplicateOf: decision.duplicateOf }),
        at,
      })
    }

    decisions.push({
      ...(decision.kind === 'duplicate' ? {} : { jobId: job.id }),
      externalId: candidate.externalId,
      kind: decision.kind,
      reason: decision.reason,
      ...(decision.duplicateOf === undefined ? {} : { duplicateOf: decision.duplicateOf }),
    })

    if (decision.kind === 'duplicate') duplicates += 1
    else if (decision.kind === 'filtered') filtered += 1
    else {
      added += 1
      if (decision.kind === 'suspect') suspects += 1
    }
  }

  ledger.append({ type: 'ingest/summary', added, duplicates, filtered, invalid, at })

  return { added, duplicates, filtered, suspects, invalid, decisions }
}
