/**
 * 待投 screen: pick jobs, then apply (PRD §5.10).
 *
 * @module dsh-job-ledger/client/queue
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { QueueView, RunView } from '../api/contract.ts'
import { postApi, usePoll } from './api.ts'
import type { ScreenProps } from './app.tsx'
import { pruneSelection, rowSubtitle, toggleSelection } from './model.ts'

/**
 * @param props run flag and translator
 * @returns the queue tab
 */
export function Queue({ running, t }: ScreenProps): ReactElement {
  const view = usePoll<QueueView>('queue?filter=new', running)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (view !== undefined) setSelected((previous) => pruneSelection(view.rows, previous))
  }, [view])

  const rows = view?.rows ?? []

  const apply = async (): Promise<void> => {
    setBusy(true)
    const result = await postApi<RunView>('run/start', { ids: [...selected] })
    setBusy(false)
    setNotice(result.ok ? result.value.state : result.failure.error)
    if (result.ok) setSelected(new Set())
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.length === 0 ? <p style={{ opacity: 0.7 }}>{t('emptyQueue')}</p> : null}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {rows.map((row) => (
          <li
            key={row.jobId}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'baseline',
              padding: '8px 10px',
              border: '1px solid var(--dsh-border, #e2e2e2)',
              borderRadius: 6,
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(row.jobId)}
              onChange={() => {
                setSelected((previous) => toggleSelection(previous, row.jobId))
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <strong>{row.title}</strong>
              <span style={{ opacity: 0.7, fontSize: 12 }}>
                {rowSubtitle(row)} · {row.reason}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void apply()}
        >
          {busy ? t('applying') : `${t('apply')} ${String(selected.size)}`}
        </button>
        {notice !== undefined ? <span style={{ opacity: 0.7 }}>{notice}</span> : null}
      </div>
    </div>
  )
}
