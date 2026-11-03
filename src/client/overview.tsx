/**
 * 概览 screen: five numbers that must equal the lists they link to (PRD §5.10).
 *
 * @module dsh-job-ledger/client/overview
 */

import type { ReactElement } from 'react'

import type { OverviewView } from '../api/contract.ts'
import type { ScreenProps } from './app.tsx'
import { remainingQuota, runLabel } from './model.ts'

/**
 * @param props overview payload, run flag, translator
 * @returns the overview tab
 */
export function Overview({
  view,
  running,
}: ScreenProps & { readonly view: OverviewView | undefined }): ReactElement {
  if (view === undefined) return <p style={{ opacity: 0.7 }}>…</p>

  const cards: readonly { label: string; value: string }[] = [
    { label: '今日已投', value: String(view.today.submitted) },
    { label: '剩余额度', value: String(remainingQuota(view)) },
    { label: '待处理的不确定', value: String(view.uncertain) },
    { label: '对账差异', value: String(view.discrepancies) },
    { label: '昨日回复', value: String(view.repliedYesterday) },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
        {cards.map((card) => (
          <div
            key={card.label}
            style={{
              padding: '10px 12px',
              border: '1px solid var(--dsh-border, #e2e2e2)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>{card.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{card.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: running ? 'var(--dsh-accent, #2563eb)' : 'var(--dsh-border, #bbb)',
          }}
        />
        <span>
          {runLabel(view.run.state)}
          {view.run.total > 0 ? ` ${String(view.run.done)}/${String(view.run.total)}` : ''}
        </span>
        {view.run.haltReason !== undefined ? <span style={{ opacity: 0.7 }}>({view.run.haltReason})</span> : null}
      </div>
    </div>
  )
}
