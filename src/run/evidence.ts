/**
 * Evidence for a submitted application (TECH §5.7, PRD §5.5).
 *
 * `submitted` without evidence is a claim, not a record. The screenshot and the chat snippet are
 * what let the user (and a future report) check that the resume actually went out, months later.
 *
 * Files are written `0600` and live under `dataDir/evidence/`. Events store the **relative** path
 * only: base64 in the log would multiply its size by a thousand and make it unreadable.
 *
 * @module dsh-job-ledger/run/evidence
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PluginError } from '../shared/errors.ts'

/** Directory inside `dataDir` that holds screenshots. */
export const EVIDENCE_DIR = 'evidence'

/** Chat snippet cap, so one long greeting cannot bloat an event line. */
export const SNIPPET_LIMIT = 500

/**
 * @param appId application id @returns the path stored in the event
 */
export function evidenceRelativePath(appId: string): string {
  return `${EVIDENCE_DIR}/${appId}.png`
}

/**
 * Truncate a chat snippet for the event note.
 *
 * @param text innerText of the chat area
 * @returns at most {@link SNIPPET_LIMIT} characters
 */
export function chatSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= SNIPPET_LIMIT ? collapsed : collapsed.slice(0, SNIPPET_LIMIT)
}

/**
 * Write a screenshot and return the path the event should carry.
 *
 * A disk failure here is fatal for the run: continuing would mean recording submissions with no
 * evidence, which is exactly the state the design refuses to produce.
 *
 * @param dataDir ledger data directory
 * @param appId application id
 * @param png screenshot bytes
 * @returns relative path (`evidence/<appId>.png`)
 * @throws PluginError `E_LEDGER_WRITE` when the file cannot be written
 */
export function saveEvidence(dataDir: string, appId: string, png: Buffer): string {
  const directory = join(dataDir, EVIDENCE_DIR)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, `${appId}.png`), png, { mode: 0o600 })
  } catch (error) {
    throw new PluginError('E_LEDGER_WRITE', { what: `evidence for ${appId}: ${String(error)}` })
  }
  return evidenceRelativePath(appId)
}
