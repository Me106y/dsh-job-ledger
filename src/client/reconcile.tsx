/**
 * 对账差异 screen: the two lists and a re-run button (PRD §5.10).
 *
 * @module dsh-job-ledger/client/reconcile
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { ReconcileView } from '../api/contract.ts'
import { postApi, usePoll } from './api.ts'
import type { ScreenProps } from './app.tsx'

/**
 * @param props run flag and translator
 * @returns the reconcile tab
 */
export function Reconcile({ running, t }: ScreenProps): ReactElement {
  const [view, setView] = useState<ReconcileView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const polled = usePoll<ReconcileView>('reconcile', running)

  const shown = view ?? polled

  const rerun = async (): Promise<void> => {
    setBusy(true)
    const result = await postApi<ReconcileView>('reconcile/run', {})
    setBusy(false)
    if (result.ok) setView(result.value)
  }

  const list = (title: string, rows: readonly { title: string; company: string }[]): ReactElement => (
    <div>
      <h4 style={{ margin: '8px 0' }}>{title}</h4>
      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>{t('emptyReconcile')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {rows.map((row, index) => (
            <li key={`${row.company}-${row.title}-${String(index)}`}>
              {row.company} · {row.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" disabled={busy} onClick={() => void rerun()}>
          {t('rerun')}
        </button>
        {shown?.partial === true ? <span style={{ opacity: 0.7, fontSize: 12 }}>{t('partial')}</span> : null}
      </div>
      {list(t('ledgerOnly'), shown?.ledgerOnly ?? [])}
      {list(t('platformOnly'), shown?.platformOnly ?? [])}
    </div>
  )
}
