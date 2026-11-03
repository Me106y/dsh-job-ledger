/**
 * Client entry: register the panel and its sidebar icon (TECH §12.1).
 *
 * ⚠️ The slot and locale services are typed **structurally**. The DSH client packages
 * (`dsh-client-ui-layout`, `dsh-client-locale`, …) are provided by the host at runtime and are not
 * devDependencies here, so this file describes just the calls it makes. If the real signatures
 * differ, this is the only file to change — everything else is plain React.
 *
 * @module dsh-job-ledger/client
 */

import type { ReactElement } from 'react'

import { App } from './app.tsx'
import { LedgerIcon } from './icon.tsx'
import { NS, messages } from './locales.ts'
import type { MessageKey } from './locales.ts'

/** The slice of `ctx.slots` this plugin uses. */
interface SlotsService {
  register(
    options: Readonly<Record<string, unknown>>,
    component: () => ReactElement,
  ): () => void
  inject(name: string, register: () => void): void
}

/** The slice of `ctx.locale` this plugin uses. */
interface LocaleService {
  register(namespace: string, table: Readonly<Record<string, unknown>>): void
  bind(namespace: string): (key: string) => string
}

/** The slice of the client context this plugin uses. */
export interface ClientContext {
  readonly slots: SlotsService
  readonly locale: LocaleService
  effect(effect: () => () => void): unknown
}

/** Services the client plugin needs. */
export const inject = ['slots', 'locale']

/**
 * Mount the panel.
 *
 * @param ctx client context
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS) as (key: MessageKey) => string

  ctx.effect(() => {
    ctx.locale.register(NS, messages)
    return () => undefined
  })

  ctx.slots.inject('main', () => {
    ctx.slots.register({ name: 'main', key: 'dsh-job-ledger', locale: NS }, () => <App t={t} />)
  })

  ctx.slots.inject('sidebar.panellist', () => {
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'dsh-job-ledger', order: 12, label: () => t('panel'), locale: NS },
      LedgerIcon,
    )
  })
}
