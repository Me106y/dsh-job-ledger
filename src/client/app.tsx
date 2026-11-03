/**
 * The panel shell: three tabs, one polled overview, and the run bar.
 *
 * @module dsh-job-ledger/client/app
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { OverviewView } from '../api/contract.ts'
import { usePoll } from './api.ts'
import { TABS } from './model.ts'
import type { Tab } from './model.ts'
import { Overview } from './overview.tsx'
import { Queue } from './queue.tsx'
import { Reconcile } from './reconcile.tsx'
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
  const [running, setRunning] = useState(false)

  const overview = usePoll<OverviewView>('overview', running)

  useEffect(() => {
    const state = overview?.run.state
    setRunning(state === 'running' || state === 'queued')
  }, [overview])

  const screen = (): ReactElement => {
    if (tab === 'overview') return <Overview view={overview} running={running} t={t} />
    if (tab === 'reconcile') return <Reconcile running={running} t={t} />
    return <Queue running={running} t={t} />
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <nav style={{ display: 'flex', gap: 8 }}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              setTab(name)
            }}
            aria-pressed={tab === name}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--dsh-border, #d0d0d0)',
              background: tab === name ? 'var(--dsh-accent, #2563eb)' : 'transparent',
              color: tab === name ? '#fff' : 'inherit',
              cursor: 'pointer',
            }}
          >
            {t(name)}
          </button>
        ))}
      </nav>
      {screen()}
    </section>
  )
}
