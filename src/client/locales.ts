/**
 * Localized strings for the panel.
 *
 * Two languages, one table. The host's locale service picks one; nothing else in the client hard-codes
 * user-visible text.
 *
 * @module dsh-job-ledger/client/locales
 */

/** Locale namespace, unique to this plugin. */
export const NS = 'dsh-job-ledger'

/** Messages by key, per locale. */
export const messages = {
  zh: {
    panel: '求职账本',
    queue: '待投',
    overview: '概览',
    reconcile: '对账差异',
    apply: '投递',
    applying: '投递中…',
    emptyQueue: '没有新岗位：今天发现的都已被判重或过滤。',
    emptySuspect: '没有待裁决的疑似重复。',
    emptyFiltered: '没有可捞回的岗位。',
    emptyReconcile: '已平账，无需处理。',
    rerun: '重新对账',
    runIdle: '空闲',
    runActive: '投递中',
    todaySubmitted: '今日已投',
    quota: '剩余额度',
    uncertain: '待处理的不确定',
    discrepancies: '对账差异',
    repliedYesterday: '昨日回复',
    ledgerOnly: '账本有、平台无',
    platformOnly: '平台有、账本无',
    partial: '只核对了平台最近一页，差异可能包含更早的投递。',
  },
  en: {
    panel: 'Job Ledger',
    queue: 'Queue',
    overview: 'Overview',
    reconcile: 'Discrepancies',
    apply: 'Apply',
    applying: 'Applying…',
    emptyQueue: 'No new postings: everything found today was a duplicate or filtered out.',
    emptySuspect: 'No suspected duplicates to decide.',
    emptyFiltered: 'Nothing to recover.',
    emptyReconcile: 'Balanced, nothing to do.',
    rerun: 'Reconcile',
    runIdle: 'Idle',
    runActive: 'Running',
    todaySubmitted: 'Applied today',
    quota: 'Quota left',
    uncertain: 'Uncertain',
    discrepancies: 'Discrepancies',
    repliedYesterday: 'Replies yesterday',
    ledgerOnly: 'In ledger, not on platform',
    platformOnly: 'On platform, not in ledger',
    partial: 'Only the latest platform page was checked; older applications may show as differences.',
  },
} as const

/** One message key. */
export type MessageKey = keyof (typeof messages)['zh']
