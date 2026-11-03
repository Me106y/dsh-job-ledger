/**
 * Job leases (TECH §6.5).
 *
 * A lease is the second line of defence against applying twice: the app state check catches "we
 * already did this", the lease catches "two executions are doing this right now". Both are checked,
 * because a lease can expire mid-flight and an app state can lag behind a click.
 *
 * @module dsh-job-ledger/run/lease
 */

import type { Application, Lease } from '../ledger/events.ts'

/** Lease lifetime. Long enough for a slow page, short enough that a crashed run frees the job. */
export const LEASE_TTL_MS = 10 * 60_000

/**
 * @param now epoch ms
 * @returns ISO timestamp at which a lease taken now expires
 */
export function leaseExpiry(now: number): string {
  return new Date(now + LEASE_TTL_MS).toISOString()
}

/** Whether a claim may proceed, or why it may not. */
export type ClaimVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'E_ALREADY_APPLIED' }
  | { readonly ok: false; readonly code: 'E_LEASE_HELD'; readonly holder: string }

/** Inputs resolved by the caller from the projection. */
export interface ClaimInput {
  /** An application whose state blocks a re-apply (PRD §5.6 / TECH §9.2). */
  readonly blockingApp?: Application | undefined
  /** The current lease on the job, if any. */
  readonly lease?: Lease | undefined
  readonly now: number
}

/**
 * Decide whether a job may be claimed.
 *
 * @param input blocking app and current lease
 * @returns `{ ok: true }` or a coded refusal
 */
export function claimVerdict(input: ClaimInput): ClaimVerdict {
  if (input.blockingApp !== undefined) return { ok: false, code: 'E_ALREADY_APPLIED' }
  // TECH §6.5: only `expiresAt < now` is free; the boundary tick still belongs to the holder.
  if (input.lease !== undefined && Date.parse(input.lease.expiresAt) >= input.now) {
    return { ok: false, code: 'E_LEASE_HELD', holder: input.lease.owner }
  }
  return { ok: true }
}
