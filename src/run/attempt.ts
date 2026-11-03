/**
 * Success judgement for one application attempt (TECH §5.6).
 *
 * The rule that shapes everything here: **the network is the authority, the DOM is a courtesy**.
 * The platform's own `sendResume` response proves the resume left; a node appearing in the chat DOM
 * only proves a React component rendered. When the DOM shows up without network evidence the
 * verdict is still `uncertain` — never a success the user would later discover was fake.
 *
 * @module dsh-job-ledger/run/attempt
 */

import type { ErrorCode } from '../shared/errors.ts'
import { isFatal } from '../shared/errors.ts'
import type { HaltReason } from '../ledger/events.ts'

/** What the platform said about the send. */
export type NetworkSignal =
  | { readonly kind: 'success' }
  /** A business code that means "stop", already mapped to a user-facing code. */
  | { readonly kind: 'fatal'; readonly code: ErrorCode }
  /** Nothing arrived before the deadline. */
  | { readonly kind: 'none' }

/** Everything the attempt observed. */
export interface AttemptSignals {
  /** Whether the click was actually delivered. */
  readonly clicked: boolean
  readonly network: NetworkSignal
  /** Whether a resume card appeared in the chat stream within the DOM grace period. */
  readonly resumeCardSeen: boolean
}

/** The verdict for one application. */
export type AttemptVerdict =
  | {
      readonly kind: 'submitted'
      /** Network confirmed, DOM did not: recorded so a later redesign is visible in the data. */
      readonly domUnconfirmed: boolean
    }
  | {
      readonly kind: 'uncertain'
      /** `send-unconfirmed`: DOM showed something the network never confirmed. */
      readonly reason: 'send-unconfirmed' | 'no-network-evidence'
    }
  | {
      readonly kind: 'failed'
      readonly code: ErrorCode
      /** Present when the refusal must stop the whole run (PRD §5.5). */
      readonly halt?: HaltReason
    }

/**
 * Map a failure code to the halt reason that stops the run.
 *
 * Only codes already marked fatal in the error table get a reason; everything else fails the single
 * job and the run continues. Keeping this mapping next to the judgement means the executor does not
 * have to remember which of the seventeen codes are run-level.
 *
 * @param code failure code
 * @returns the halt reason, or `undefined` when the run may continue
 */
export function haltReasonForFailure(code: ErrorCode): HaltReason | undefined {
  if (!isFatal(code)) return undefined
  switch (code) {
    case 'E_CAPTCHA':
      return 'captcha'
    case 'E_RATE_LIMITED':
      return 'rate-limited'
    case 'E_ACCOUNT_RISK':
      return 'account-risk'
    case 'E_STOKEN_EXPIRED':
      return 'stoken-expired'
    case 'E_CDP_DISCONNECTED':
      return 'cdp-disconnected'
    case 'E_LEDGER_WRITE':
      return 'ledger-write'
    default:
      // Fatal but not run-level (e.g. Chrome failed to start): the caller halts on its own path.
      return undefined
  }
}

/**
 * Decide what one attempt produced.
 *
 * @param signals click result, network evidence and DOM evidence
 * @returns submitted / uncertain / failed
 */
export function judgeAttempt(signals: AttemptSignals): AttemptVerdict {
  if (!signals.clicked) {
    // Without a click there is nothing to confirm; the selector had moved.
    return { kind: 'failed', code: 'E_SELECTOR_MISSING' }
  }

  if (signals.network.kind === 'fatal') {
    const halt = haltReasonForFailure(signals.network.code)
    return {
      kind: 'failed',
      code: signals.network.code,
      ...(halt === undefined ? {} : { halt }),
    }
  }

  if (signals.network.kind === 'success') {
    return { kind: 'submitted', domUnconfirmed: !signals.resumeCardSeen }
  }

  // No network evidence. DOM alone is not proof: report uncertainty, never success.
  return {
    kind: 'uncertain',
    reason: signals.resumeCardSeen ? 'send-unconfirmed' : 'no-network-evidence',
  }
}
