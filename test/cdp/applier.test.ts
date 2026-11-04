import assert from 'node:assert/strict'
import test from 'node:test'

import { BossApplier } from '../../src/cdp/applier.ts'
import { BOSS_API, BOSS_SELECTORS } from '../../src/cdp/boss.ts'
import type { BrowserPort } from '../../src/cdp/browser.ts'
import { PluginError } from '../../src/shared/errors.ts'
import { makeJob } from '../fixtures/helpers.ts'

const JOB = makeJob({
  id: 'j_1',
  company: '字节跳动',
  title: '后端工程师',
  city: '深圳',
  externalId: 'ext_1',
})

interface PortOptions {
  readonly present?: readonly string[]
  readonly capture?: () => Promise<unknown>
  readonly currentUrl?: string
  /** Where navigation actually lands, e.g. the login wall. */
  readonly redirectTo?: string
  /** Where the contact click lands; BOSS sends its own greeting and jumps to the chat. */
  readonly clickNavigatesTo?: string
  /** Contact-button labels returned per `text()` call; the last one repeats. */
  readonly contactLabels?: readonly string[]
  readonly chat?: string
}

/** A port that records what the applier asked it to do. */
class FakePort implements BrowserPort {
  readonly calls: string[] = []
  url = 'https://www.zhipin.com/web/geek/job'

  #present: Set<string>
  #capture: () => Promise<unknown>
  #chat: string
  #redirectTo: string | undefined
  #clickNavigatesTo: string | undefined
  #contactLabels: readonly string[]
  #labelReads = 0

  constructor(options: PortOptions = {}) {
    this.#present = new Set(options.present ?? [])
    this.#capture = options.capture ?? (() => Promise.resolve({ code: 0 }))
    this.#chat = options.chat ?? '你好，我想投递这个岗位'
    this.#redirectTo = options.redirectTo
    this.#clickNavigatesTo = options.clickNavigatesTo
    this.#contactLabels = options.contactLabels ?? ['继续沟通']
    if (options.currentUrl !== undefined) this.url = options.currentUrl
  }

  async navigate(url: string): Promise<void> {
    this.calls.push(`navigate:${url}`)
    this.url = this.#redirectTo ?? url
  }

  async capture(pattern: RegExp): Promise<unknown> {
    this.calls.push(`capture:${pattern.source}`)
    return this.#capture()
  }

  async click(selector: string): Promise<void> {
    this.calls.push(`click:${selector}`)
    if (selector === BOSS_SELECTORS.contactButton && this.#clickNavigatesTo !== undefined) {
      this.url = this.#clickNavigatesTo
    }
  }

  async typeText(selector: string, text: string): Promise<void> {
    this.calls.push(`type:${selector}:${text}`)
  }

  async waitFor(selector: string): Promise<boolean> {
    this.calls.push(`wait:${selector}`)
    return this.#present.has(selector)
  }

  async text(selector: string): Promise<string> {
    if (selector === BOSS_SELECTORS.contactButton) {
      const labels = this.#contactLabels
      const label = labels[Math.min(this.#labelReads, labels.length - 1)] ?? ''
      this.#labelReads += 1
      return label
    }
    return this.#chat
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('png')
  }

  async currentUrl(): Promise<string> {
    return this.url
  }

  close(): void {
    this.calls.push('close')
  }
}

/** @returns a port with the chat UI present */
function readyPort(options: PortOptions = {}): FakePort {
  return new FakePort({
    present: [
      BOSS_SELECTORS.greetingInput,
      BOSS_SELECTORS.sendButton,
      BOSS_SELECTORS.resumeCard,
    ],
    ...options,
  })
}

test('the response is armed before the click that triggers it', async () => {
  const port = readyPort()
  const applier = new BossApplier(port)

  await applier.send(JOB, '你好')

  const captureAt = port.calls.findIndex((call) => call.startsWith('capture:'))
  const firstClickAt = port.calls.findIndex((call) => call.startsWith('click:'))
  assert.ok(captureAt >= 0 && firstClickAt >= 0)
  // A capture armed after the click waits for a request that already went by.
  assert.ok(captureAt < firstClickAt, port.calls.join(', '))
})

test('a full send clicks, types the greeting, and reports the card', async () => {
  // A platform that does not greet on its own: the button never turns into 继续沟通.
  const port = readyPort({ contactLabels: ['立即沟通'] })
  const applier = new BossApplier(port, { contactSettleMs: 0, contactDeadlineMs: 0 })

  const result = await applier.send(JOB, '你好，我想投递')

  assert.deepEqual(result, {
    clicked: true,
    network: { kind: 'success' },
    resumeCardSeen: true,
  })
  assert.ok(port.calls.includes(`type:${BOSS_SELECTORS.greetingInput}:你好，我想投递`))
  assert.ok(port.calls.includes(`click:${BOSS_SELECTORS.sendButton}`))
})

test('a fatal business code becomes a fatal network signal', async () => {
  const port = readyPort({ capture: () => Promise.resolve({ code: 9 }) })
  const result = await new BossApplier(port).send(JOB, '你好')

  assert.deepEqual(result.network, { kind: 'fatal', code: 'E_RATE_LIMITED' })
})

test('a capture that times out is "none", never success', async () => {
  const port = readyPort({
    capture: () => Promise.reject(new PluginError('E_NAV_TIMEOUT', { what: 'sendResume' })),
  })
  const result = await new BossApplier(port).send(JOB, '你好')

  assert.deepEqual(result.network, { kind: 'none' })
})

test('a body we cannot read is "none", never success', async () => {
  const port = readyPort({ capture: () => Promise.resolve({ code: 'unexpected' }) })
  const result = await new BossApplier(port).send(JOB, '你好')

  assert.deepEqual(result.network, { kind: 'none' })
})

test('the capture looks for the page’s own send request', async () => {
  const port = readyPort()
  await new BossApplier(port).send(JOB, '你好')

  assert.ok(port.calls.some((call) => call.startsWith('capture:')))
  assert.equal(BOSS_API.sendResume.test('https://www.zhipin.com/wapi/zpgeek/friend/add.json'), true)
})

test('a page without the greeting box still reports the click', async () => {
  const port = new FakePort({ present: [] })
  const result = await new BossApplier(port).send(JOB, '你好')

  assert.equal(result.clicked, true)
  assert.ok(!port.calls.some((call) => call.startsWith('type:')))
  assert.equal(result.resumeCardSeen, false)
})

test('an optional send-resume button is clicked when present', async () => {
  const port = readyPort({
    present: [
      BOSS_SELECTORS.greetingInput,
      BOSS_SELECTORS.sendButton,
      BOSS_SELECTORS.sendResumeButton,
      BOSS_SELECTORS.resumeCard,
    ],
    contactLabels: ['立即沟通'],
  })
  await new BossApplier(port, { contactSettleMs: 0, contactDeadlineMs: 0 }).send(JOB, '你好')

  assert.ok(port.calls.includes(`click:${BOSS_SELECTORS.sendResumeButton}`))
})

test('prepare opens the job page and refuses a login wall', async () => {
  const ok = readyPort()
  await new BossApplier(ok).prepare(JOB)
  assert.equal(ok.calls[0], `navigate:${JOB.url}`)

  const expired = readyPort({ redirectTo: 'https://www.zhipin.com/web/user/?login' })
  await assert.rejects(new BossApplier(expired).prepare(JOB), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_LOGIN_REQUIRED')
    return true
  })
})

test('capture returns the screenshot and the chat transcript', async () => {
  const applier = new BossApplier(readyPort({ chat: '你好，方便聊聊吗' }))
  const evidence = await applier.capture()

  assert.equal(evidence.png.toString(), 'png')
  assert.equal(evidence.chat, '你好，方便聊聊吗')
})

test('when 立即沟通 already opened the chat, no second greeting is typed', async () => {
  const port = readyPort({ clickNavigatesTo: 'https://www.zhipin.com/web/geek/chat?id=abc&jobId=ext_1' })
  const applier = new BossApplier(port)

  const result = await applier.send(JOB, '你好，我想投递')

  assert.equal(result.clicked, true)
  // BOSS sent its own default greeting with the click; typing here would message the same HR twice.
  assert.ok(!port.calls.some((call) => call.startsWith('type:')), port.calls.join(', '))
  assert.ok(!port.calls.includes(`click:${BOSS_SELECTORS.sendButton}`), port.calls.join(', '))
})

/** @param options port options @returns an applier whose contact settle is instant in tests */
function fastApplier(options: PortOptions = {}): { applier: BossApplier; port: FakePort } {
  const port = readyPort(options)
  return { port, applier: new BossApplier(port, { contactSettleMs: 0 }) }
}

test('a click the page ignored is retried once, so a swallowed click is not a failed attempt', async () => {
  const { applier, port } = fastApplier({ contactLabels: ['立即沟通', '继续沟通'] })

  await applier.send(JOB, '你好')

  const clicks = port.calls.filter((call) => call === `click:${BOSS_SELECTORS.contactButton}`)
  assert.equal(clicks.length, 2)
})

test('a contact that already turned into 继续沟通 is clicked once', async () => {
  const { applier, port } = fastApplier({ contactLabels: ['继续沟通'] })

  await applier.send(JOB, '你好')

  const clicks = port.calls.filter((call) => call === `click:${BOSS_SELECTORS.contactButton}`)
  assert.equal(clicks.length, 1)
})

test('the contact click keeps retrying until the button turns into 继续沟通', async () => {
  const { applier, port } = fastApplier({ contactLabels: ['立即沟通', '立即沟通', '继续沟通'] })

  await applier.send(JOB, '你好')

  const clicks = port.calls.filter((call) => call === `click:${BOSS_SELECTORS.contactButton}`)
  assert.equal(clicks.length, 3)
})
