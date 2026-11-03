/**
 * The `report` tool: the funnel, the sources, and one sentence that should change a decision
 * (PRD §5.8).
 *
 * The numbers come from `report/build.ts`, which excludes backfilled applications. The tool only
 * renders — a model may rephrase the conclusion, never the counts.
 *
 * @module dsh-job-ledger/tools/report
 */

import type { Ledger } from '../ledger/store.ts'
import { saveSnapshot } from '../report/snapshot.ts'
import { buildReport, reportMarkdown } from '../report/build.ts'
import type { Report } from '../report/build.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const REPORT_TOOL_NAME = 'job_ledger_report'

/** Model-facing description. */
export const REPORT_TOOL_DESCRIPTION =
  '生成投递报表：漏斗、来源回复率、周趋势，附一句结论。可同时把 Markdown 存到数据目录。回填数据不计入。'

/** What the tool returns. */
export type ReportToolResult =
  | { readonly ok: true; readonly report: Report; readonly markdown: string; readonly savedTo?: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Knobs tests pin. */
export interface ReportOptions {
  readonly now?: number | undefined
  readonly save?: boolean | undefined
  readonly dataDir?: string | undefined
}

/**
 * Build (and optionally save) the report.
 *
 * @param ledger open ledger @param options clock, save flag, data directory
 * @returns the report, its Markdown, and where it was saved
 */
export function reportForModel(ledger: Ledger, options: ReportOptions = {}): ReportToolResult {
  try {
    const now = options.now ?? Date.now()
    const report = buildReport(ledger.projection, now)
    const markdown = reportMarkdown(report)
    const savedTo =
      options.save === true && options.dataDir !== undefined
        ? saveSnapshot(options.dataDir, markdown)
        : undefined
    return { ok: true, report, markdown, ...(savedTo === undefined ? {} : { savedTo }) }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: userMessage(error.code, error.values) }
    }
    throw error
  }
}

/**
 * Render the report for the model.
 *
 * @param result tool result @returns Markdown, or the coded failure
 */
export function renderReportResult(result: ReportToolResult): string {
  return result.ok ? result.markdown : `[${result.code}] ${result.message}`
}
