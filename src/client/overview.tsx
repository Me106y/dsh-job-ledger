/**
 * 概览 screen: five numbers that must equal the lists they link to (PRD §5.10).
 *
 * @module dsh-job-ledger/client/overview
 */

import type { ReactElement } from 'react'

import type { OverviewView, SettingsView } from '../api/contract.ts'
import type { ScreenProps } from './app.tsx'
import { RUN_KEYS, remainingQuota } from './model.ts'

/**
 * @param props overview payload, target settings, translator
 * @returns the overview tab
 */
export function Overview({
  view,
  settings,
  running,
  t,
  onOpenSettings,
}: ScreenProps & {
  readonly view: OverviewView | undefined
  readonly settings: SettingsView | undefined
  readonly onOpenSettings: () => void
}): ReactElement {
  if (view === undefined) {
    return (
      <div className="jl-card">
        <p className="jl-loading">{t('loading')}</p>
      </div>
    )
  }

  const cards: readonly { label: string; value: number; tone: string }[] = [
    { label: t('todaySubmitted'), value: view.today.submitted, tone: '' },
    { label: t('quota'), value: remainingQuota(view), tone: '' },
    { label: t('uncertain'), value: view.uncertain, tone: view.uncertain > 0 ? 'is-alert' : '' },
    { label: t('discrepancies'), value: view.discrepancies, tone: view.discrepancies > 0 ? 'is-warn' : '' },
    { label: t('repliedYesterday'), value: view.repliedYesterday, tone: '' },
  ]

  const target = settings?.target
  const roles = target === undefined || target.roles.length === 0 ? t('rolesFromResume') : target.roles.join('、')
  const cities = target === undefined || target.cities.length === 0 ? t('citiesUnlimited') : target.cities.join('、')
  const salary =
    target === undefined || target.salaryMin === 0
      ? ''
      : ` · ${t('salaryAtLeast', { value: target.salaryMin })}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="jl-stats">
        {cards.map((card) => (
          <div key={card.label} className={`jl-stat ${card.tone}`}>
            <div className="jl-stat-label">{card.label}</div>
            <div className="jl-stat-value">{String(card.value)}</div>
          </div>
        ))}
      </div>

      <div className="jl-card">
        <div className="jl-card-head">
          <h2 className="jl-card-title">{t('targetSummary')}</h2>
          <button type="button" className="jl-inline-link" onClick={onOpenSettings}>
            {t('changeInSettings')}
          </button>
        </div>
        <div className="jl-card-body is-padded">
          <div className="jl-row-meta" style={{ fontSize: 13 }}>
            <span>{roles}</span>
            <span className="jl-sep">·</span>
            <span>{cities}</span>
            {salary === '' ? null : <span>{salary}</span>}
          </div>
        </div>
      </div>

      <div className="jl-card">
        <div className="jl-card-body is-padded">
          <span className={`jl-pill${running ? ' is-running' : ''}`}>
            <i className="jl-dot" />
            {t(RUN_KEYS[view.run.state])}
            {view.run.total > 0 ? ` ${String(view.run.done)}/${String(view.run.total)}` : ''}
          </span>
          {view.run.haltReason === undefined ? null : (
            <span className="jl-error" style={{ marginLeft: 10 }}>
              {view.run.haltReason}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
