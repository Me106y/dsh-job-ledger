import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseResume } from '../../src/resume/parse.ts'
import { redactResume } from '../../src/resume/redact.ts'
import type { Resume } from '../../src/resume/parse.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/resume.json', import.meta.url)), 'utf8'),
) as { baseinfo: unknown; expect: unknown; status: unknown }

const resume: Resume = parseResume(fixture)

test('redacted drops the contact block and keeps what matching needs', () => {
  const redacted = redactResume(resume, 'redacted')

  assert.equal(redacted.contact, undefined)
  assert.deepEqual(redacted.skills, resume.skills)
  assert.deepEqual(redacted.expectedRoles, resume.expectedRoles)
  assert.equal(redacted.workYears, 5)
})

test('redacted does not mutate the resume it was given', () => {
  redactResume(resume, 'redacted')
  assert.equal(resume.contact?.name, '张三')
})

test('full exposure keeps the contact block', () => {
  const full = redactResume(resume, 'full')
  assert.equal(full.contact?.name, '张三')
})

test('a resume with no contact is unchanged by redaction', () => {
  const bare: Resume = {
    expectedRoles: ['后端工程师'],
    expectedCities: ['深圳'],
    skills: [],
    experiences: [],
  }
  assert.deepEqual(redactResume(bare, 'redacted'), bare)
})
