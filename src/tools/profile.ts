/**
 * The `profile` tool: what the plugin thinks it is configured to do (TECH §13.1).
 *
 * Read-only and deliberately boring. It exists so a user can ask "what are you actually using?"
 * without opening YAML, and so the model can quote the limits instead of guessing them.
 *
 * @module dsh-job-ledger/tools/profile
 */

import type { LedgerConfig } from '../config.ts'
import { LIMITS } from '../shared/profile.ts'

/** Tool name as the model sees it. */
export const PROFILE_TOOL_NAME = 'job_ledger_profile'

/** Model-facing description. */
export const PROFILE_TOOL_DESCRIPTION =
  '返回当前配置与硬上限（单轮 10 / 每日 30，不可配置）。用于确认目标岗位、城市、薪资下限与隐私设置。'

/** The safe view of the configuration. */
export interface ProfileView {
  readonly dataDir: string
  readonly debugPort: number
  readonly target: {
    readonly roles: readonly string[]
    readonly cities: readonly string[]
    readonly salaryMin: number
    readonly excludeKeywords: readonly string[]
    readonly companyBlacklist: readonly string[]
  }
  readonly dedupe: { readonly cooldownDays: number; readonly simhashDistance: number }
  readonly privacy: { readonly resumeExposure: string }
  readonly reconcile: { readonly maxPages: number }
  readonly limits: { readonly runSize: number; readonly daily: number }
}

/**
 * @param config resolved configuration @returns the configuration as the model may see it
 */
export function profileView(config: LedgerConfig): ProfileView {
  return {
    dataDir: config.dataDir,
    debugPort: config.debugPort,
    target: {
      roles: [...config.profile.target.roles],
      cities: [...config.profile.target.cities],
      salaryMin: config.profile.target.salaryMin,
      excludeKeywords: [...config.profile.target.excludeKeywords],
      companyBlacklist: [...config.profile.target.companyBlacklist],
    },
    dedupe: {
      cooldownDays: config.profile.dedupe.cooldownDays,
      simhashDistance: config.profile.dedupe.simhashDistance,
    },
    privacy: { resumeExposure: config.profile.privacy.resumeExposure },
    reconcile: { maxPages: config.profile.reconcile.maxPages },
    // Shown so the user can see the ceiling, never read back from configuration.
    limits: { runSize: LIMITS.runSize, daily: LIMITS.daily },
  }
}
