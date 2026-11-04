/**
 * The real `JobApplier`: how one application is actually sent (TECH §5.5, §5.6).
 *
 * Everything platform-specific is a selector from `boss.ts` and is unverified against a live page
 * (TECH §20). The class is written so that being wrong is recoverable rather than dangerous:
 *
 * - the response capture is armed **before** the click, because the page fires its own request;
 * - a response we cannot parse is `none`, not `success` — the attempt then degrades to `uncertain`;
 * - a missing greeting box still counts as "clicked", so the verdict can say what happened;
 * - the optional second "send resume" button is clicked only when it exists.
 *
 * @module dsh-job-ledger/cdp/applier
 */

import type { Job } from '../ledger/events.ts'
import type { CapturedEvidence, JobApplier, SendResult } from '../run/executor.ts'
import type { NetworkSignal } from '../run/attempt.ts'
import { PluginError } from '../shared/errors.ts'
import { record } from '../shared/json.ts'
import { BOSS_API, BOSS_SELECTORS, bossErrorCode } from './boss.ts'
import type { BrowserPort } from './browser.ts'
import { assertLoggedIn } from './login.ts'

/** How long each stage may take. Exposed so tests do not wait for real deadlines. */
export interface ApplierTimings {
  readonly sendTimeoutMs?: number
  readonly greetTimeoutMs?: number
  readonly cardTimeoutMs?: number
  readonly resumeButtonTimeoutMs?: number
  /** How long the contact button gets to turn into 继续沟通 before a retry. */
  readonly contactSettleMs?: number
  /** How long to let the page bind its handlers before the first click. */
  readonly contactReadyMs?: number
  /** How many times the contact is clicked before giving up. */
  readonly contactAttempts?: number
  /** Gap between two contact clicks. */
  readonly contactRetryMs?: number
}

const DEFAULT_SEND_TIMEOUT_MS = 15_000
const DEFAULT_GREET_TIMEOUT_MS = 5_000
const DEFAULT_CARD_TIMEOUT_MS = 2_000
const DEFAULT_RESUME_BUTTON_TIMEOUT_MS = 800

/** How long the contact button gets to turn into 继续沟通 before the click is retried. */
const CONTACT_SETTLE_MS = 1_200

/** How long the page gets to bind its handlers before the first contact click. */
const CONTACT_READY_MS = 5_000

/** How many contact clicks are attempted. */
const CONTACT_ATTEMPTS = 3

/** Gap between two contact clicks. */
const CONTACT_RETRY_MS = 1_500

/** Sends one application through a real page. */
export class BossApplier implements JobApplier {
  readonly #port: BrowserPort
  readonly #timings: Required<ApplierTimings>

  /**
   * @param port browser that can click and type
   * @param timings per-stage budgets
   */
  constructor(port: BrowserPort, timings: ApplierTimings = {}) {
    this.#port = port
    this.#timings = {
      sendTimeoutMs: timings.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      greetTimeoutMs: timings.greetTimeoutMs ?? DEFAULT_GREET_TIMEOUT_MS,
      cardTimeoutMs: timings.cardTimeoutMs ?? DEFAULT_CARD_TIMEOUT_MS,
      resumeButtonTimeoutMs:
        timings.resumeButtonTimeoutMs ?? DEFAULT_RESUME_BUTTON_TIMEOUT_MS,
      contactSettleMs: timings.contactSettleMs ?? CONTACT_SETTLE_MS,
      contactReadyMs: timings.contactReadyMs ?? CONTACT_READY_MS,
      contactAttempts: timings.contactAttempts ?? CONTACT_ATTEMPTS,
      contactRetryMs: timings.contactRetryMs ?? CONTACT_RETRY_MS,
    }
  }

  /**
   * Open the job page and refuse early if the session expired.
   *
   * @param job job to apply to
   */
  async prepare(job: Job): Promise<void> {
    await this.#port.navigate(job.url)
    await assertLoggedIn(this.#port, [])
  }

  /**
   * Click 立即沟通, send the greeting, and report what the page did.
   *
   * @param job job being applied to
   * @param greeting text to send
   * @returns what the network and the DOM showed
   */
  async send(job: Job, greeting: string): Promise<SendResult> {
    void job
    // Arm before clicking: the request is fired by the click itself.
    const network = this.#watchSendResponse()

    // 立即沟通 turns into 继续沟通 the moment the platform accepts the contact, and on a freshly
    // navigated SPA the first clicks are swallowed until the handlers are bound. So click until
    // that change is observed; a click that lands after acceptance only opens the conversation.
    const accepted = await this.#contactUntilAccepted()
    const openedChat = /\/web\/geek\/chat/.test(await this.#port.currentUrl())

    // The platform's own greeting goes out with the contact, so our greeting is only sent when the
    // platform did not handle it: typing after 继续沟通 would message the same recruiter twice.
    if (!accepted && !openedChat && (await this.#port.waitFor(BOSS_SELECTORS.greetingInput, this.#timings.greetTimeoutMs))) {
      await this.#port.typeText(BOSS_SELECTORS.greetingInput, greeting)
      try {
        await this.#port.click(BOSS_SELECTORS.sendButton)
      } catch {
        // The greeting may already be out; the network signal below decides the verdict.
      }
      if (
        await this.#port.waitFor(BOSS_SELECTORS.sendResumeButton, this.#timings.resumeButtonTimeoutMs)
      ) {
        await this.#port.click(BOSS_SELECTORS.sendResumeButton)
      }
    }

    const resumeCardSeen = await this.#port.waitFor(
      BOSS_SELECTORS.resumeCard,
      this.#timings.cardTimeoutMs,
    )
    return { clicked: true, network: await network, resumeCardSeen }
  }

  /** @returns the screenshot and the chat transcript */
  async capture(): Promise<CapturedEvidence> {
    const png = await this.#port.screenshot()
    const chat = await this.#port.text(BOSS_SELECTORS.chatPanel)
    return { png, chat }
  }

  /**
   * Click 立即沟通 until the page shows 继续沟通 (or the deadline passes).
   *
   * @returns whether the platform accepted the contact
   */
  async #contactUntilAccepted(): Promise<boolean> {
    // The button exists in the DOM before the page binds its click handler, and clicking during
    // that window appears to be ignored. A quiet moment first is what makes the first click land.
    await new Promise<void>((resolve) => setTimeout(resolve, this.#timings.contactReadyMs))
    for (let attempt = 0; attempt < this.#timings.contactAttempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.#timings.contactRetryMs))
      }
      await this.#port.click(BOSS_SELECTORS.contactButton)
      await new Promise<void>((resolve) => setTimeout(resolve, this.#timings.contactSettleMs))
      const label = await this.#port.text(BOSS_SELECTORS.contactButton)
      // An empty label means the button left the page (chat opened); that is acceptance too.
      if (!label.includes('立即沟通')) return true
    }
    return false
  }

  /**
   * Wait for the page's own send response and translate it into a signal.
   *
   * A response whose body we cannot read is `none`: "we could not confirm", never "it worked".
   *
   * @returns the network signal
   */
  async #watchSendResponse(): Promise<NetworkSignal> {
    let payload: unknown
    try {
      payload = await this.#port.capture(BOSS_API.sendResume, this.#timings.sendTimeoutMs)
    } catch (error) {
      if (error instanceof PluginError && error.code === 'E_LOGIN_REQUIRED') throw error
      return { kind: 'none' }
    }

    const code = record(payload)?.code
    if (code === 0) return { kind: 'success' }
    if (typeof code !== 'number') return { kind: 'none' }
    const mapped = bossErrorCode(code)
    return mapped === undefined ? { kind: 'none' } : { kind: 'fatal', code: mapped }
  }
}

/**
 * Build a lazily-connected applier.
 *
 * The browser is opened on the first attempt, not when the tool registers: installing a plugin must
 * not launch Chrome behind the user's back.
 *
 * @param provider opens (or reuses) the browser port
 * @param timings per-stage budgets
 * @returns a job applier
 */
export function createApplier(
  provider: () => Promise<BrowserPort>,
  timings: ApplierTimings = {},
): JobApplier {
  let applier: Promise<BossApplier> | undefined
  const get = (): Promise<BossApplier> => {
    applier ??= provider().then((port) => new BossApplier(port, timings))
    return applier
  }

  return {
    prepare: async (job) => (await get()).prepare(job),
    send: async (job, greeting) => (await get()).send(job, greeting),
    capture: async () => (await get()).capture(),
  }
}
