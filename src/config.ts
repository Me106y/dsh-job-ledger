/**
 * Configuration: the YAML a user writes, reduced to what the plugin runs on (TECH §14).
 *
 * Deliberately plain TypeScript rather than a schemastery schema: the module must be testable
 * without a cordis context, and `runSize`/`daily` are **not** read from here at all. They are
 * hard-coded limits (`LIMITS`), because a config file should not be able to raise the ceiling on
 * how many strangers a bad afternoon can message (TECH §9.3).
 *
 * @module dsh-job-ledger/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_DEBUG_PORT } from './cdp/chrome.ts'
import { DEFAULT_PROFILE, mergeProfile } from './shared/profile.ts'
import type { Profile, ProfilePatch, TargetRules } from './shared/profile.ts'

/** Everything resolved at startup. */
export interface LedgerConfig {
  /** Directory holding `events.jsonl`, evidence and the Chrome profile. */
  readonly dataDir: string
  /** Explicit Chrome binary, or `''` for auto-detection. */
  readonly chromePath: string
  readonly debugPort: number
  readonly profile: Profile
}

/** The shape a user may write in `cordis.patch.yml`. */
export interface ConfigInput {
  readonly dataDir?: string
  readonly chromePath?: string
  readonly debugPort?: number
  readonly privacy?: ProfilePatch['privacy']
  readonly target?: Partial<TargetRules>
  readonly dedupe?: ProfilePatch['dedupe']
  readonly reconcile?: ProfilePatch['reconcile']
}

/** @param env environment @returns the DSH home directory, honouring `DSH_HOME` */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** @param env environment @returns the default ledger directory */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'job-ledger')
}

/**
 * Expand a leading `~`, because YAML authors write `~/.dsh` and `join` does not.
 *
 * @param path configured path
 * @returns an absolute path
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve user input against defaults.
 *
 * @param input parsed YAML config
 * @param env environment, for `DSH_HOME`
 * @returns a complete config
 */
export function resolveConfig(
  input: ConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): LedgerConfig {
  return {
    dataDir: input.dataDir === undefined ? defaultDataDir(env) : expandHome(input.dataDir),
    chromePath: input.chromePath === undefined ? '' : expandHome(input.chromePath),
    debugPort: input.debugPort ?? DEFAULT_DEBUG_PORT,
    profile: mergeProfile(DEFAULT_PROFILE, {
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.dedupe === undefined ? {} : { dedupe: input.dedupe }),
      ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
      ...(input.reconcile === undefined ? {} : { reconcile: input.reconcile }),
    }),
  }
}
