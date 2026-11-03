import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginError } from '../../src/shared/errors.ts'
import {
  EVIDENCE_DIR,
  SNIPPET_LIMIT,
  chatSnippet,
  evidenceRelativePath,
  saveEvidence,
} from '../../src/run/evidence.ts'

/** @param t test context @returns a temp directory removed afterwards */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('events store a relative path, never the bytes', () => {
  assert.equal(evidenceRelativePath('a_1'), 'evidence/a_1.png')
  assert.equal(EVIDENCE_DIR, 'evidence')
})

test('a screenshot is written private and reported by relative path', (t) => {
  const dataDir = tempDir(t)
  const png = Buffer.from('89504e470d0a1a0a', 'hex')

  const relative = saveEvidence(dataDir, 'a_1', png)

  assert.equal(relative, 'evidence/a_1.png')
  assert.deepEqual(readFileSync(join(dataDir, 'evidence', 'a_1.png')), png)
  // The directory may hold chat screenshots; only this user may read it.
  assert.equal(statSync(join(dataDir, 'evidence', 'a_1.png')).mode & 0o777, 0o600)
})

test('evidence for the same application is replaced, not appended', (t) => {
  const dataDir = tempDir(t)
  saveEvidence(dataDir, 'a_1', Buffer.from('first'))
  saveEvidence(dataDir, 'a_1', Buffer.from('second'))

  assert.equal(readFileSync(join(dataDir, 'evidence', 'a_1.png'), 'utf8'), 'second')
})

test('an unwritable evidence directory is a fatal ledger error', (t) => {
  const dataDir = tempDir(t)
  // Turn the data dir into a file so the evidence directory cannot be created under it.
  writeFileSync(join(dataDir, 'blocker'), '')
  assert.throws(
    () => saveEvidence(join(dataDir, 'blocker'), 'a_1', Buffer.from('x')),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_WRITE')
      return true
    },
  )
})

test('the chat snippet is collapsed and capped', () => {
  assert.equal(chatSnippet('  hello\n\n world  '), 'hello world')
  const long = 'x'.repeat(SNIPPET_LIMIT + 50)
  assert.equal(chatSnippet(long).length, SNIPPET_LIMIT)
})
