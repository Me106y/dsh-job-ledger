/**
 * 待投 screen: pick jobs, then apply — or refresh the list, or delete a posting (PRD §5.10).
 *
 * Three actions, three different trust levels: applying is irreversible and goes through the single
 * run entry; updating reaches the network but changes no application; deleting only records "not
 * this one". Keeping them visually separate is the point of the screen.
 *
 * @module dsh-job-ledger/client/queue
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { QueueUpdateView, QueueView, RunView } from '../api/contract.ts'
import { postApi, usePoll } from './api.ts'
import type { ScreenProps } from './app.tsx'
import {
  RUN_KEYS,
  pruneSelection,
  reasonKey,
  toggleSelection,
  withoutRows,
} from './model.ts'

/** One run never exceeds this; the host refuses more (PRD §5.5). */
const RUN_SIZE = 10

/** A transient line under the list: what just happened, or why it did not. */
interface Notice {
  readonly text: string
  readonly ok: boolean
}

/**
 * @param props run flag and translator
 * @returns the queue tab
 */
export function Queue({ running, t }: ScreenProps): ReactElement {
  const view = usePoll<QueueView>('queue?filter=new', running)
  // The queue a POST returned, shown until a newer poll arrives: one round trip renders itself.
  const [updated, setUpdated] = useState<QueueView | undefined>(undefined)
  // Rows deleted since the last payload; hidden immediately so they do not flash back before the poll.
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)

  const current =
    view !== undefined && (updated === undefined || view.revision >= updated.revision)
      ? view
      : updated
  const rows = withoutRows(current?.rows ?? [], removed)

  useEffect(() => {
    if (current === undefined) return
    const present = new Set(current.rows.map((row) => row.jobId))
    setSelected((previous) => pruneSelection(current.rows, previous))
    // A deleted id stays hidden while a stale payload still lists it, and is forgotten once it is gone.
    setRemoved((previous) => {
      const next = new Set([...previous].filter((id) => present.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [current])

  const allSelected = rows.length > 0 && selected.size === rows.length
  const overLimit = selected.size > RUN_SIZE
  const locked = running || busy || updating || deleting !== undefined

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

  const update = async (): Promise<void> => {
    setUpdating(true)
    setNotice(undefined)
    const result = await postApi<QueueUpdateView>('queue/update', {})
    setUpdating(false)
    if (!result.ok) {
      // Keep the list as it is: a failed refresh must not look like "nothing new".
      setNotice({ text: result.failure.error, ok: false })
      return
    }
    const next = result.value
    setUpdated(next.queue)
    setNotice({
      text: [
        `${t('addedCount')} ${String(next.added)}`,
        `${t('duplicateCount')} ${String(next.duplicates)}`,
        `${t('filteredCount')} ${String(next.filtered)}`,
        `${t('suspectCount')} ${String(next.suspects)}`,
      ].join(' · '),
      ok: true,
    })
  }

  const remove = async (jobId: string): Promise<void> => {
    setDeleting(jobId)
    setNotice(undefined)
    const result = await postApi<{ jobId: string; status: string }>(
      `jobs/${encodeURIComponent(jobId)}/skip`,
      {},
    )
    setDeleting(undefined)
    if (!result.ok) {
      setNotice({ text: result.failure.error, ok: false })
      return
    }
    setRemoved((previous) => new Set(previous).add(jobId))
    setSelected((previous) => {
      const next = new Set(previous)
      next.delete(jobId)
      return next
    })
    // Deleting is a ledger edit, not a reason to reach the network: new postings arrive when the
    // person presses 更新 (PRD §5.10 #34).
    setNotice({ text: t('deleted'), ok: true })
  }

  return (
    <div className="jl-card is-fill">
      <div className="jl-card-head">
        <h2 className="jl-card-title">
          {t('queueList')}
          {rows.length > 0 ? (
            <span className="jl-badge" style={{ marginLeft: 8 }}>
              {String(rows.length)}
            </span>
          ) : null}
        </h2>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <label className="jl-pill" style={{ cursor: rows.length === 0 ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              className="jl-check"
              checked={allSelected}
              disabled={rows.length === 0 || locked}
              aria-label={t('selectAll')}
              onChange={() => {
                setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.jobId)))
              }}
            />
            {t('selectAll')}
          </label>
          <button
            type="button"
            className="jl-btn"
            disabled={locked}
            onClick={() => void update()}
          >
            {updating ? t('updating') : t('update')}
          </button>
        </span>
      </div>

      {current === undefined ? (
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
                  disabled={locked}
                  onChange={() => {
                    setSelected((previous) => toggleSelection(previous, row.jobId))
                  }}
                />
                <div>
                  <div className="jl-row-title">
                    {row.url !== undefined && /^https?:\/\//.test(row.url) ? (
                      // The platform page is the source of truth for "what is this job"; open it in
                      // the person's own browser instead of driving their tab.
                      <a
                        className="jl-row-link"
                        href={row.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={`${t('openOnBoss')}：${row.title}`}
                      >
                        {row.title}
                      </a>
                    ) : (
                      row.title
                    )}
                  </div>
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
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <span
                    className={`jl-tag ${row.decision === 'suspect' ? 'is-suspect' : 'is-new'}`}
                    title={row.reason}
                  >
                    {key === undefined ? row.reason : t(key)}
                  </span>
                  <button
                    type="button"
                    className="jl-btn is-ghost"
                    disabled={locked}
                    title={t('deleteRow')}
                    aria-label={`${t('deleteRow')} ${row.title}`}
                    onClick={() => void remove(row.jobId)}
                  >
                    {deleting === row.jobId ? t('deleting') : t('deleteRow')}
                  </button>
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
            disabled={locked || selected.size === 0 || overLimit}
            onClick={() => void apply()}
          >
            {busy ? t('applying') : `${t('apply')} ${String(selected.size)}`}
          </button>
        </span>
      </div>
    </div>
  )
}
