/**
 * Plugin entry (host side).
 *
 * In: the ledger core (P0), the browser/CDP read layer and resume tool (P1), discovery + ingestion
 * (P2). Still missing: the apply path, reconciliation, the host API and the panel — P3 onward
 * (docs/PRD.md §12).
 *
 * @module dsh-job-ledger
 */

import type { Context } from '@deepseek-ai/cordis'

import { join } from 'node:path'

import { resolveConfig } from './config.ts'
import type { ConfigInput } from './config.ts'
import { createApplier } from './cdp/applier.ts'
import type { Job } from './ledger/events.ts'
import { JobRunner } from './run/executor.ts'
import { fillGreeting } from './resume/greeting.ts'
import { loadSkillBody, registerSkill } from './skill.ts'
import { weeklySnapshot } from './report/snapshot.ts'
import { recoverInterrupted } from './run/recovery.ts'
import { readResume } from './resume/read.ts'
import type { Resume } from './resume/parse.ts'
import { createApi } from './api/handlers.ts'
import { mountApi } from './api/mount.ts'
import type { WebServerLike } from './api/mount.ts'
import { createRunTracker } from './api/views.ts'
import { BrowserRuntime } from './runtime/browser.ts'
import { Ledger } from './ledger/store.ts'
import {
  registerApplyTool,
  registerBackfillTool,
  registerDiscoverTool,
  registerLoginTool,
  registerRecordTool,
  registerProfileTool,
  registerReportTool,
  registerQueueTool,
  registerReconcileTool,
  registerResumeTool,
} from './tools/register.ts'

export { ERROR_MESSAGES, failure, isErrorCode, isFatal, isRetryable, userMessage, PluginError } from './shared/errors.ts'
export type { ErrorCode, LedgerFailure } from './shared/errors.ts'

export { DEFAULT_PROFILE, LIMITS, mergeProfile } from './shared/profile.ts'
export type { Profile, ProfilePatch, ResumeExposure, TargetRules } from './shared/profile.ts'

export { EVENT_TYPES, EVENT_VERSION, isEventType } from './ledger/events.ts'
export type {
  AppSource,
  AppState,
  Application,
  EventInput,
  EventType,
  GrantedBy,
  HaltReason,
  Job,
  JobSource,
  JobStatus,
  LedgerEvent,
  Lease,
  Platform,
  RunSummary,
} from './ledger/events.ts'

export {
  APP_STATES,
  APP_TRANSITIONS,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  isTerminal,
} from './ledger/states.ts'
export {
  ATTEMPTED_STATES,
  BLOCKING_STATES,
  activeLease,
  appsInState,
  applyEvent,
  attemptsFor,
  blockingAppForJob,
  blocksReapply,
  companyTitleKey,
  countsAsAttempt,
  createProjection,
  dayOf,
  jobsInWindow,
  requireJob,
} from './ledger/project.ts'
export type {
  DecisionRecord,
  IngestRecord,
  Projection,
  ReconcileRecord,
  RunRecord,
} from './ledger/project.ts'

export { LEDGER_FILE, MAX_LINE_BYTES, Ledger, replay } from './ledger/store.ts'
export type { OpenReport, ReplayResult } from './ledger/store.ts'

export { fingerprint } from './dedupe/fingerprint.ts'
export { NO_JD_DISTANCE, hammingDistance, hasJd, simhash, tokenize } from './dedupe/simhash.ts'
export {
  fold,
  normalizeCity,
  normalizeCompany,
  normalizeTitle,
  normalizeUrl,
} from './dedupe/normalize.ts'
export { FINGERPRINT_WINDOW_DAYS, SIMHASH_WINDOW_DAYS, decide } from './dedupe/decide.ts'
export type { Candidate, Decision, DecisionReason } from './dedupe/decide.ts'

export { hardFilter } from './filter/rules.ts'
export type { FilterHit, FilterInput, FilterReason } from './filter/rules.ts'

export { RUN_TRANSITIONS, isRunActive, isRunFinished, transition } from './run/machine.ts'
export type { RunAction, RunOutcome, RunState } from './run/machine.ts'
export { LEASE_TTL_MS, claimVerdict, leaseExpiry } from './run/lease.ts'
export type { ClaimInput, ClaimVerdict } from './run/lease.ts'

export { buildReport, reportMarkdown } from './report/build.ts'
export type { Funnel, Report, SourceRow, WeekRow } from './report/build.ts'

export { defaultDataDir, dshHome, expandHome, resolveConfig } from './config.ts'
export type { ConfigInput, LedgerConfig } from './config.ts'

export {
  BOSS_API,
  BOSS_BUSINESS_CODES,
  BOSS_URLS,
  BOSS_VERSION,
  assertBossSuccess,
  bossErrorCode,
  isLoginUrl,
} from './cdp/boss.ts'
export { CdpReader, NAVIGATE_TIMEOUT_MS } from './cdp/browser.ts'
export type { BrowserReader } from './cdp/browser.ts'
export {
  DEFAULT_DEBUG_PORT,
  chromeCandidates,
  ensureChrome,
  launchArgs,
  probeDebugPort,
} from './cdp/chrome.ts'
export type { ChromeDeps, ChromeHandle, ChromeOptions, DebugTarget } from './cdp/chrome.ts'
export { CAPTURE_TIMEOUT_MS, captureResponse, parseJsonBody } from './cdp/network.ts'
export { CDP_CALL_TIMEOUT_MS, CdpError, CdpSession } from './cdp/session.ts'
export type { CdpErrorKind, CdpEvent, CdpTransport } from './cdp/session.ts'
export { CONNECT_TIMEOUT_MS, webSocketTransport } from './cdp/transport.ts'

export { parseResume, summarizeResume } from './resume/parse.ts'
export type {
  Resume,
  ResumeContact,
  ResumeExperience,
  ResumePayloads,
} from './resume/parse.ts'
export { readResume } from './resume/read.ts'
export { redactResume } from './resume/redact.ts'

export { DISCOVERY_LIMIT, discoveryUrl, readJobList } from './discover/read.ts'
export type { DiscoveryResult, DiscoverySource } from './discover/read.ts'
export { MAX_JD_CHARS, candidateFor, ingestJobs } from './discover/ingest.ts'
export type { IngestDecision, IngestOptions, IngestResult } from './discover/ingest.ts'
export { parseJobList, parseSalary } from './discover/parse.ts'
export type { ParsedJobList, RawJob } from './discover/parse.ts'

export { BrowserRuntime } from './runtime/browser.ts'
export type { BrowserRuntimeDeps, ReaderProvider } from './runtime/browser.ts'

export {
  RESUME_TOOL_DESCRIPTION,
  RESUME_TOOL_NAME,
  readResumeForModel,
  renderResumeResult,
} from './tools/resume.ts'
export type { JsonLike, ResumeToolResult } from './tools/resume.ts'
export {
  discoverTool,
  queueTool,
  registerDiscoverTool,
  registerQueueTool,
  registerResumeTool,
  resumeTool,
} from './tools/register.ts'
export { QUEUE_TOOL_NAME, queueForModel, renderQueueResult } from './tools/queue.ts'
export { QUEUE_LIMIT, queueRows, queueTotal } from './ledger/queue.ts'
export type { QueueFilter, QueueRow } from './ledger/queue.ts'
export {
  DISCOVER_TOOL_DESCRIPTION,
  DISCOVER_TOOL_NAME,
  discoverForModel,
  renderDiscoverResult,
} from './tools/discover.ts'
export type { DiscoverOptions, DiscoverToolResult, DiscoveredJob } from './tools/discover.ts'

/**
 * Build the greeting for one job (PRD §5.5).
 *
 * The resume is read once per session and cached: it changes rarely, and reading it for every job
 * would turn a run into a series of page loads. If it cannot be read, the greeting falls back to
 * the bare preset rather than inventing anything.
 *
 * @param runtime browser access
 * @returns a function from job to greeting text
 */
function createGreeting(runtime: BrowserRuntime): (job: Job) => Promise<string> {
  let resume: Promise<Resume> | undefined
  return async (job: Job): Promise<string> => {
    try {
      resume ??= runtime.reader().then((reader) => readResume(reader))
      return fillGreeting({ job, resume: await resume }).text
    } catch {
      return fillGreeting({ job }).text
    }
  }
}

/**
 * Cordis plugin name.
 *
 * Exported as `name` for the bundle patch; see `cordis.patch.yml`.
 */
export const name = 'job-ledger'

/** Services this plugin needs: `tools` to register, nothing else at P2. */
export const inject: readonly string[] = ['tools']

/**
 * Mount the plugin.
 *
 * The browser is opened lazily on the first tool call, not here: installing the plugin must not
 * launch Chrome behind the user's back.
 *
 * @param ctx host context (needs the `tools` service)
 * @param config user configuration from `cordis.patch.yml`
 */
export function apply(ctx: Context, config: ConfigInput = {}): void {
  const resolved = resolveConfig(config)
  const ledger = Ledger.open(join(resolved.dataDir, 'events.jsonl'))
  const runtime = new BrowserRuntime(resolved)

  const greeting = createGreeting(runtime)

  const runner = new JobRunner({
    ledger,
    // CdpReader implements BrowserPort; the runtime's type is the narrower reader because tests
    // substitute a reader-only double.
    applier: createApplier(async () => runtime.reader()),
    dataDir: resolved.dataDir,
    greeting,
  })

  registerResumeTool(ctx, runtime, resolved)
  registerDiscoverTool(ctx, ledger, runtime, resolved)
  registerQueueTool(ctx, ledger)
  registerApplyTool(ctx, runner)
  registerReconcileTool(ctx, ledger, runtime)
  registerReportTool(ctx, ledger, resolved.dataDir)
  registerProfileTool(ctx, resolved)
  registerLoginTool(ctx, runtime)
  registerBackfillTool(ctx, ledger, runtime)
  registerRecordTool(ctx, ledger)

  const skill = loadSkillBody()
  if (skill !== undefined) registerSkill(ctx, skill)

  // The panel API is optional: a profile without a web server (headless) still gets the tools.
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer !== undefined) {
    const tracker = createRunTracker()
    mountApi(webServer, createApi({ ledger, runner, provider: runtime, tracker }))
  }

  // A process that died mid-application left `applying` behind, which does not block a retry.
  recoverInterrupted(ledger)

  // Weekly, idempotent, and best-effort: a read-only data directory must not stop the plugin.
  try {
    weeklySnapshot(resolved.dataDir, ledger.projection, Date.now())
  } catch {
    // The report is a convenience; the ledger is the product.
  }

  // One place to release both handles when the plugin is unloaded.
  ctx.effect(() => () => {
    runtime.close()
    ledger.close()
  })

  ctx.logger.info(
    `dsh-job-ledger: tools registered (dataDir: ${resolved.dataDir}, replay: ${String(ledger.report.appliedLines)} lines)`,
  )
}
