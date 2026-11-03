/**
 * Plugin entry (host side).
 *
 * Status: skeleton. The design is finished (docs/PRD.md, docs/TECH-DESIGN.md) and the implementation
 * starts at milestone P0 (ledger core). This entry exists so the toolchain — typecheck, tests, build,
 * and CI — is exercised today rather than on the first real commit.
 *
 * @module dsh-job-ledger
 */

export { ERROR_MESSAGES, failure, isErrorCode, isFatal, isRetryable, userMessage } from './shared/errors.ts'
export type { ErrorCode, LedgerFailure } from './shared/errors.ts'

/** Cordis plugin name. */
export const name = 'job-ledger'

/** Services this plugin needs. Empty until P1/P5 wire the ledger and the panel. */
export const inject: readonly string[] = []

/** The slice of the cordis context this skeleton uses. */
export interface PluginContext {
  readonly logger: {
    info(message: string): void
    warn(message: string): void
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx host context
 */
export function apply(ctx: PluginContext): void {
  ctx.logger.info('dsh-job-ledger: skeleton build — ledger core lands at milestone P0')
}
