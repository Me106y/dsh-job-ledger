/**
 * 对账差异 screen: the two lists and a re-run button (PRD §5.10).
 *
 * @module dsh-job-ledger/client/reconcile
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { ReconcileRowView, ReconcileView } from '../api/contract.ts'
import { postApi, usePoll } from './api.ts'
import type { ScreenProps } from './app.tsx'

/**
 * @param props run flag and translator
 * @returns the reconcile tab
 */
export function Reconcile({ running, t }: ScreenProps): ReactElement {
  const [view, setView] = useState<ReconcileView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const polled = usePoll<ReconcileView>('reconcile', running)

  const shown = view ?? polled

  const rerun = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const result = await postApi<ReconcileView>('reconcile/run', {})
    setBusy(false)
    if (result.ok) setView(result.value)
    else setError(result.failure.error)
  }

  const list = (title: string, rows: readonly ReconcileRowView[]): ReactElement => (
    <div className="jl-card">
      <div className="jl-card-head">
        <h2 className="jl-card-title">
          {title}
          <span className="jl-badge" style={{ marginLeft: 8 }}>
            {String(rows.length)}
          </span>
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="jl-empty">
          <strong>{t('emptyReconcile')}</strong>
        </div>
      ) : (
        <ul className="jl-list">
          {rows.map((row, index) => (
            <li key={`${row.company}-${row.title}-${String(index)}`} className="jl-list-row">
              <div className="jl-list-title">{row.title === '' ? t('emptyReconcile') : row.title}</div>
              <div className="jl-list-sub">{row.company}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="jl-card">
        <div className="jl-card-head">
          <span className="jl-note" style={{ maxWidth: 620 }}>
            {t('reconcileHint')}
          </span>
          <button type="button" className="jl-btn is-primary" disabled={busy} onClick={() => void rerun()}>
            {busy ? t('loading') : t('rerun')}
          </button>
        </div>
        {shown?.partial === true ? (
          <div className="jl-card-body is-padded">
            <span className="jl-note">{t('partial')}</span>
          </div>
        ) : null}
        {error === undefined ? null : (
          <div className="jl-card-body is-padded">
            <span className="jl-error">{error}</span>
          </div>
        )}
      </div>

      <div className="jl-split">
        {list(t('ledgerOnly'), shown?.ledgerOnly ?? [])}
        {list(t('platformOnly'), shown?.platformOnly ?? [])}
      </div>
    </div>
  )
}
