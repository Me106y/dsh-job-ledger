/**
 * Parse the platform's delivered-applications list (PRD §5.7, TECH §10.2).
 *
 * The response shape is unverified (TECH §20), so the reader is alias-tolerant. What it will not
 * do is guess an identity: a row without a platform id is counted as invalid rather than matched by
 * fuzzy fields, because a wrong match would silence a real discrepancy.
 *
 * @module dsh-job-ledger/reconcile/parse
 */

import { dataOf, record, text } from '../shared/json.ts'

/** One application the platform says we made. */
export interface DeliveredRow {
  readonly externalId: string
  readonly company: string
  readonly title: string
  readonly city: string
  /** When the platform says it happened; used for the backfilled application. */
  readonly at?: string
}

/** What parsing produced. */
export interface ParsedDeliverList {
  readonly rows: readonly DeliveredRow[]
  readonly invalid: number
}

/** @param payload list response @returns the array of rows, wherever it sits */
function rowsOf(payload: unknown): readonly unknown[] {
  const data = dataOf(payload, 'deliver list')
  for (const key of ['jobList', 'deliverList', 'list', 'result']) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/**
 * Parse one delivered row.
 *
 * @param entry raw row
 * @returns the row, or undefined when it cannot be identified
 */
function parseRow(entry: unknown): DeliveredRow | undefined {
  const row = record(entry)
  if (row === undefined) return undefined

  const externalId = text(row.encryptJobId) ?? text(row.externalId)
  const company = text(row.brandName) ?? text(row.companyName) ?? text(row.company)
  const title = text(row.jobName) ?? text(row.title) ?? text(row.positionName)
  if (externalId === undefined || company === undefined || title === undefined) return undefined

  const city = text(row.cityName) ?? text(row.city) ?? ''
  const at = text(row.time) ?? text(row.deliverTime) ?? text(row.lastTime)

  return {
    externalId,
    company,
    title,
    city,
    ...(at === undefined ? {} : { at }),
  }
}

/**
 * Parse the delivered list.
 *
 * @param payload response body
 * @returns valid rows plus the count that could not be identified
 */
export function parseDeliverList(payload: unknown): ParsedDeliverList {
  const rows: DeliveredRow[] = []
  let invalid = 0
  for (const entry of rowsOf(payload)) {
    const row = parseRow(entry)
    if (row === undefined) {
      invalid += 1
      continue
    }
    rows.push(row)
  }
  return { rows, invalid }
}
