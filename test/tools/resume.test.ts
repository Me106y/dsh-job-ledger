import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ReaderProvider } from '../../src/runtime/browser.ts'
import {
  RESUME_TOOL_DESCRIPTION,
  RESUME_TOOL_NAME,
  readResumeForModel,
  renderResumeResult,
} from '../../src/tools/resume.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/resume.json', import.meta.url)), 'utf8'),
) as { baseinfo: unknown; expect: unknown; status: unknown }

/** @param browser reader to hand out @returns a provider with no Chrome involved */
function provider(browser: ReplayBrowser): ReaderProvider {
  return { reader: async () => browser }
}

test('a successful read returns a summary and a redacted resume', async () => {
  const result = await readResumeForModel(provider(new ReplayBrowser(fixture)), 'redacted')

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.summary, '后端工程师 / 深圳 / 25-35K / 5 年')
  assert.equal('contact' in (result.resume as Record<string, unknown>), false)
  assert.deepEqual((result.resume as { skills: string[] }).skills, ['Go', 'Kubernetes', 'MySQL'])
})

test('full exposure keeps the contact block', async () => {
  const result = await readResumeForModel(provider(new ReplayBrowser(fixture)), 'full')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal((result.resume as { contact?: { name?: string } }).contact?.name, '张三')
})

test('a login wall becomes an actionable code, not a timeout', async () => {
  const browser = new ReplayBrowser(fixture)
  browser.url = 'https://www.zhipin.com/web/user/login?redirect=resume'

  const result = await readResumeForModel(provider(browser), 'redacted')

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_LOGIN_REQUIRED')
  assert.ok(result.message.length > 0)
})

test('a business rejection becomes a coded failure', async () => {
  const result = await readResumeForModel(
    provider(new ReplayBrowser({ baseinfo: { code: 37 }, expect: { code: 0 }, status: { code: 0 } })),
    'redacted',
  )

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_STOKEN_EXPIRED')
})

test('raw is refused while the privacy setting is redacted', async () => {
  const result = await readResumeForModel(
    provider(new ReplayBrowser(fixture)),
    'redacted',
    { raw: true },
  )

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_PRIVACY_BLOCKED')
})

test('raw returns the contact block once the setting is full', async () => {
  const result = await readResumeForModel(provider(new ReplayBrowser(fixture)), 'full', {
    raw: true,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal((result.resume as { contact?: { name?: string } }).contact?.name, '张三')
})

test('the rendered line is the summary on success and the code on failure', () => {
  assert.deepEqual(renderResumeResult({ ok: true, summary: '后端工程师 / 深圳', resume: {} }), '后端工程师 / 深圳')
  assert.deepEqual(
    renderResumeResult({ ok: false, code: 'E_BODY_UNAVAILABLE', message: '页面结构变了' }),
    '[E_BODY_UNAVAILABLE] 页面结构变了',
  )
})

test('the tool name is namespaced and the description says what it will not do', () => {
  assert.equal(RESUME_TOOL_NAME, 'job_ledger_resume')
  assert.match(RESUME_TOOL_DESCRIPTION, /不投递/)
})
