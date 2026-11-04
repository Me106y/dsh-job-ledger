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
import { RUN_KEYS, pruneSelection, reasonKey, toggleSelection } from './model.ts'

/** One run never exceeds this; the host refuses more (PRD §5.5). */
const RUN_SIZE = 10

/**
 * @param props run flag and translator
 * @returns the queue tab
 */
export function Queue({ running, t }: ScreenProps): ReactElement {
  const view = usePoll<QueueView>('queue?filter=new', running)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly text: string; readonly ok: boolean } | undefined>(
    undefined,
  )

  useEffect(() => {
    if (view !== undefined) setSelected((previous) => pruneSelection(view.rows, previous))
  }, [view])

  const rows = view?.rows ?? []
  const allSelected = rows.length > 0 && selected.size === rows.length
  const overLimit = selected.size > RUN_SIZE

  const apply = async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const result = await postApi<RunView>('run/start', { ids: [...selected] })
    setBusy(false)
    if (result.ok) {
      const run = result.value
      setNotice({ text: `${t(RUN_KEYS[run.state])} ${String(run.done)}/${String(run.total)}`, ok: true })
      setSelected(new Set())
    } else {
      setNotice({ text: result.failure.error, ok: false })
    }
  }

  return (
    <div className="jl-card">
      <div className="jl-card-head">
        <h2 className="jl-card-title">
          {t('queueList')}
          {rows.length > 0 ? (
            <span className="jl-badge" style={{ marginLeft: 8 }}>
              {String(rows.length)}
            </span>
          ) : null}
        </h2>
        <label className="jl-pill" style={{ cursor: rows.length === 0 ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            className="jl-check"
            checked={allSelected}
            disabled={rows.length === 0}
            aria-label={t('selectAll')}
            onChange={() => {
              setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.jobId)))
            }}
          />
          {t('selectAll')}
        </label>
      </div>

      {view === undefined ? (
        <p className="jl-loading">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <div className="jl-empty">
          <strong>{t('emptyQueue')}</strong>
          <span>{t('emptyQueueHint')}</span>
        </div>
      ) : (
        <ul className="jl-rows">
          {rows.map((row) => {
            const key = reasonKey(row.reason)
            return (
            <li key={row.jobId} className="jl-row">
              <input
                type="checkbox"
                className="jl-check"
                checked={selected.has(row.jobId)}
                aria-label={row.title}
                onChange={() => {
                  setSelected((previous) => toggleSelection(previous, row.jobId))
                }}
              />
              <div>
                <div className="jl-row-title">{row.title}</div>
                <div className="jl-row-meta">
                  <span>{row.company}</span>
                  {row.city === '' ? null : (
                    <>
                      <span className="jl-sep">·</span>
                      <span>{row.city}</span>
                    </>
                  )}
                  {row.salary === '' ? null : (
                    <>
                      <span className="jl-sep">·</span>
                      <span>{row.salary}</span>
                    </>
                  )}
                </div>
              </div>
              <span
                className={`jl-tag ${row.decision === 'suspect' ? 'is-suspect' : 'is-new'}`}
                title={row.reason}
              >
                {key === undefined ? row.reason : t(key)}
              </span>
            </li>
            )
          })}
        </ul>
      )}

      <div className="jl-actions">
        <span className="jl-actions-note">
          {t('selected')} {String(selected.size)}/{String(RUN_SIZE)}
          {notice === undefined ? null : (
            <span className={notice.ok ? 'jl-saved' : 'jl-error'} style={{ marginLeft: 10 }}>
              {notice.text}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <button
            type="button"
            className="jl-btn is-ghost"
            disabled={busy || selected.size === 0}
            onClick={() => {
              setSelected(new Set())
            }}
          >
            {t('clear')}
          </button>
          <button
            type="button"
            className="jl-btn is-primary"
            disabled={busy || selected.size === 0 || overLimit}
            onClick={() => void apply()}
          >
            {busy ? t('applying') : `${t('apply')} ${String(selected.size)}`}
          </button>
        </span>
      </div>
    </div>
  )
}
