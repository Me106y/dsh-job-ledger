/**
 * Weekly human-readable snapshot (TECH §6.6).
 *
 * The ledger is the source of truth; this file is a convenience for the user, so it can be opened,
 * mailed to themselves, or diffed over time. It is written `0600`: it contains the same data the
 * ledger does.
 *
 * @module dsh-job-ledger/report/snapshot
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PluginError } from '../shared/errors.ts'

/** Snapshot file name inside the data directory. */
export const SNAPSHOT_FILE = 'snapshot.md'

/**
 * Write the Markdown report next to the ledger.
 *
 * @param dataDir ledger directory @param markdown rendered report @returns the absolute path
 * @throws PluginError `E_LEDGER_WRITE` when it cannot be written
 */
export function saveSnapshot(dataDir: string, markdown: string): string {
  const path = join(dataDir, SNAPSHOT_FILE)
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(path, markdown, { mode: 0o600 })
  } catch (error) {
    throw new PluginError('E_LEDGER_WRITE', { what: `snapshot: ${String(error)}` })
  }
  return path
}
