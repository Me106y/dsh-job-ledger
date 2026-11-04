/**
 * The panel shell: a header, four tabs, and the polling that feeds them.
 *
 * @module dsh-job-ledger/client/app
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { OverviewView, SettingsView } from '../api/contract.ts'
import { callApi, usePoll } from './api.ts'
import { RUN_KEYS, TABS, runActive } from './model.ts'
import type { Tab } from './model.ts'
import { Overview } from './overview.tsx'
import { Queue } from './queue.tsx'
import { Reconcile } from './reconcile.tsx'
import { Settings } from './settings.tsx'
import type { MessageKey } from './locales.ts'

/** Props every screen receives. */
export interface ScreenProps {
  readonly running: boolean
  readonly t: (key: MessageKey) => string
}

/**
 * @param props translation function
 * @returns the whole panel
 */
export function App({ t }: { readonly t: (key: MessageKey) => string }): ReactElement {
  const [tab, setTab] = useState<Tab>('queue')
  const [settings, setSettings] = useState<SettingsView | undefined>(undefined)
  const [active, setActive] = useState(false)

  const overview = usePoll<OverviewView>('overview', active)

  useEffect(() => {
    setActive(runActive(overview))
  }, [overview])

  useEffect(() => {
    let cancelled = false
    void callApi<SettingsView>('profile').then((result) => {
      if (!cancelled && result.ok) setSettings(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const run = overview?.run
  const submitted = overview?.today.submitted ?? 0
  const quota = overview?.today.quota ?? 30
  const running = runActive(overview)
  const discrepancies = overview?.discrepancies ?? 0

  const screen = (): ReactElement => {
    if (tab === 'overview') {
      return (
        <Overview
          view={overview}
          settings={settings}
          running={running}
          t={t}
          onOpenSettings={() => {
            setTab('settings')
          }}
        />
      )
    }
    if (tab === 'reconcile') return <Reconcile running={running} t={t} />
    if (tab === 'settings') return <Settings view={settings} t={t} onSaved={setSettings} />
    return <Queue running={running} t={t} />
  }

  return (
    <section className="jl-root">
      <header className="jl-head">
        <div>
          <h1 className="jl-title">{t('panel')}</h1>
          <p className="jl-sub">{t('subtitle')}</p>
        </div>
        <div className="jl-head-right">
          <span className={`jl-pill${running ? ' is-running' : ''}`}>
            <i className="jl-dot" />
            {t(RUN_KEYS[run?.state ?? 'idle'])}
            {run !== undefined && run.total > 0 ? ` ${String(run.done)}/${String(run.total)}` : ''}
          </span>
          <span className="jl-pill">
            {t('todaySubmitted')} {String(submitted)}/{String(quota)}
          </span>
        </div>
      </header>

      <div className="jl-tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            className="jl-tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name)
            }}
          >
            {t(name)}
            {name === 'reconcile' && discrepancies > 0 ? (
              <span className="jl-badge is-danger">{String(discrepancies)}</span>
            ) : null}
          </button>
        ))}
      </div>

      {screen()}
    </section>
  )
}
