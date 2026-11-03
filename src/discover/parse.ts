/**
 * Parse a job list into candidates (PRD §5.2).
 *
 * The list endpoint carries no JD text on BOSS — only the card. That is a real limitation, not an
 * oversight: without JD text the SimHash comparison cannot run, so first-pass dedupe relies on the
 * fingerprint, and cross-source JD matching only works for postings whose JD is already stored.
 *
 * @module dsh-job-ledger/discover/parse
 */

import { dataOf, numeric, record, text } from '../shared/json.ts'

/** One posting as it appears in a list response, before normalization. */
export interface RawJob {
  readonly externalId?: string
  readonly url?: string
  readonly title: string
  readonly company: string
  readonly city?: string
  readonly salaryRaw?: string
  readonly salaryMin?: number
  readonly postedAt?: string
  /** Present only when the caller already knows the JD (e.g. from a detail read). */
  readonly jdText?: string
}

/** What parsing a list produced. */
export interface ParsedJobList {
  readonly jobs: readonly RawJob[]
  /** Entries that could not be identified (missing title, company, or identity). */
  readonly invalid: number
}

/**
 * Pull a salary floor out of the card text.
 *
 * BOSS writes things like `25-35K·13薪` or `20K以上`. Bare numbers below 1000 are read as K per
 * month; anything larger is taken as yuan. ⚠️ Unverified against a live page (TECH §20).
 *
 * @param raw salary text
 * @returns the text as written plus the parsed floor, when it parses
 */
export function parseSalary(raw: string | undefined): { salaryRaw?: string; salaryMin?: number } {
  if (raw === undefined) return {}
  const match = /(\d+(?:\.\d+)?)/.exec(raw)
  if (match?.[1] === undefined) return { salaryRaw: raw }
  const value = Number(match[1])
  if (!Number.isFinite(value)) return { salaryRaw: raw }
  return { salaryRaw: raw, salaryMin: value < 1000 ? Math.round(value * 1000) : Math.round(value) }
}

/** @param payload list response @returns the array of card objects, wherever it sits */
function cardsOf(payload: unknown): readonly unknown[] {
  const data = dataOf(payload, 'job list')
  for (const key of ['jobList', 'jobCards', 'list', 'recommendList']) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/**
 * Parse one card. Returns `undefined` when the card cannot be identified.
 *
 * @param entry raw card
 * @returns a raw job, or undefined
 */
function parseCard(entry: unknown): RawJob | undefined {
  const card = record(entry)
  if (card === undefined) return undefined

  const title = text(card.jobName) ?? text(card.title) ?? text(card.positionName)
  const company = text(card.brandName) ?? text(card.companyName) ?? text(card.company)
  if (title === undefined || company === undefined) return undefined

  const externalId = text(card.encryptJobId) ?? text(card.externalId)
  const rawUrl = text(card.jobUrl) ?? text(card.url)
  const url =
    rawUrl ??
    (externalId === undefined
      ? undefined
      : `https://www.zhipin.com/job_detail/${encodeURIComponent(externalId)}.html`)
  // Without an id and without a URL there is nothing to dedupe against, so the card is noise.
  if (externalId === undefined && url === undefined) return undefined

  const city = text(card.cityName) ?? text(card.city)
  const salary = parseSalary(text(card.salaryDesc) ?? text(card.salaryName))
  const salaryMin = numeric(card.salaryMin) ?? salary.salaryMin
  const postedAt = text(card.postDateDesc) ?? text(card.postedAt)

  return {
    ...(externalId === undefined ? {} : { externalId }),
    ...(url === undefined ? {} : { url }),
    title,
    company,
    ...(city === undefined ? {} : { city }),
    ...(salary.salaryRaw === undefined ? {} : { salaryRaw: salary.salaryRaw }),
    ...(salaryMin === undefined ? {} : { salaryMin }),
    ...(postedAt === undefined ? {} : { postedAt }),
  }
}

/**
 * Parse a list response.
 *
 * @param payload response body
 * @param limit hard cap on how many cards to keep (PRD §5.2: 50 per discovery)
 * @returns valid jobs plus the count of unidentifiable cards
 */
export function parseJobList(payload: unknown, limit = 50): ParsedJobList {
  const cards = cardsOf(payload)
  const jobs: RawJob[] = []
  let invalid = 0

  for (const card of cards) {
    if (jobs.length >= limit) break
    const job = parseCard(card)
    if (job === undefined) {
      invalid += 1
      continue
    }
    jobs.push(job)
  }

  return { jobs, invalid }
}
