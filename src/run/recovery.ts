/**
 * Boot-time recovery for a process that died mid-application (TECH §5.8, C4).
 *
 * `applying` is not a blocking state: it is transient and normally becomes `submitted`,
 * `uncertain` or `failed` within seconds. If the process dies in between, the application stays
 * `applying` forever — and since it does not block, the job becomes eligible again once its lease
 * expires. Re-applying to a job whose click may already have gone out is exactly the duplicate this
 * product exists to prevent.
 *
 * The honest state for "we were clicking when the process died" is `uncertain`: it blocks a retry
 * until a person checks the platform, which is what the design asks for.
 *
 * This runs at plugin mount, when no run can be in flight in this process. Two hosts sharing one
 * `dataDir` are already unsupported (single writer, TECH §6.3).
 *
 * @module dsh-job-ledger/run/recovery
 */

import type { Ledger } from '../ledger/store.ts'

/** Note written on recovered applications. */
export const INTERRUPTED_NOTE = '进程在投递过程中退出，结果未知'

/**
 * Mark every still-`applying` application as `uncertain`.
 *
 * @param ledger the single writer
 * @param now epoch ms
 * @returns how many applications were recovered
 */
export function recoverInterrupted(ledger: Ledger, now: number = Date.now()): number {
  const stuck = [...ledger.projection.apps.values()].filter((app) => app.state === 'applying')
  const at = new Date(now).toISOString()
  for (const app of stuck) {
    ledger.append({
      type: 'app/state',
      appId: app.id,
      state: 'uncertain',
      note: INTERRUPTED_NOTE,
      at,
    })
  }
  return stuck.length
}
