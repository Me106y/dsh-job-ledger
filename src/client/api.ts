/**
 * The client's data layer: one typed caller and one polling hook.
 *
 * Every call carries the panel header the host requires, and every response is the contract's shape.
 * The hook stops polling when the tab is hidden — a background tab should not keep a browser busy
 * (TECH §11.4).
 *
 * @module dsh-job-ledger/client/api
 */

import { useEffect, useRef, useState } from 'react'

import type { Api, OverviewView, QueueView, ReconcileView, RunView } from '../api/contract.ts'
import { isStale, pollInterval } from './model.ts'

/** Header the host checks before answering anything (TECH §11.1). */
export const REQUEST_HEADER = 'x-job-ledger-request'

/** Base path of the API, as mounted by `api/mount.ts`. */
export const API_BASE = '/job-ledger/api'

/** A failure body the host returns instead of a payload. */
export interface ApiFailure {
  readonly error: string
  readonly code: string
}

/** Either a payload or a failure. */
export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure }

/**
 * Call the host API.
 *
 * @param route route key from the contract @returns the parsed result
 */
export async function callApi<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}/${path}`, {
      headers: { [REQUEST_HEADER]: '1' },
    })
    const body = (await response.json()) as unknown
    if (!response.ok) {
      const failure = body as Partial<ApiFailure>
      return {
        ok: false,
        failure: {
          error: failure.error ?? `HTTP ${String(response.status)}`,
          code: failure.code ?? 'E_BODY_UNAVAILABLE',
        },
      }
    }
    return { ok: true, value: body as T }
  } catch (error) {
    return {
      ok: false,
      failure: { error: error instanceof Error ? error.message : String(error), code: 'E_BODY_UNAVAILABLE' },
    }
  }
}

/**
 * POST to the host API.
 *
 * @param path route below the API base @param body JSON body @returns the parsed result
 */
export async function postApi<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}/${path}`, {
      method: 'POST',
      headers: { [REQUEST_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const parsed = (await response.json()) as unknown
    if (!response.ok) {
      const failure = parsed as Partial<ApiFailure>
      return {
        ok: false,
        failure: {
          error: failure.error ?? `HTTP ${String(response.status)}`,
          code: failure.code ?? 'E_BODY_UNAVAILABLE',
        },
      }
    }
    return { ok: true, value: parsed as T }
  } catch (error) {
    return {
      ok: false,
      failure: { error: error instanceof Error ? error.message : String(error), code: 'E_BODY_UNAVAILABLE' },
    }
  }
}

/**
 * Poll one endpoint while the component is mounted and the tab is visible.
 *
 * @param path route below the API base
 * @param onValue called with every payload whose revision changed
 * @param active whether the run is active, which chooses the cadence
 * @returns the latest payload, or undefined before the first answer
 */
export function usePoll<T extends { revision: number }>(
  path: string,
  active: boolean,
  onValue?: (value: T) => void,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined)
  const revision = useRef<number | undefined>(undefined)
  const run = active ? { state: 'running' as const, total: 0, done: 0 } : { state: 'idle' as const, total: 0, done: 0 }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') {
        const result = await callApi<T>(path)
        if (!cancelled && result.ok && isStale(revision.current, result.value.revision)) {
          revision.current = result.value.revision
          setValue(result.value)
          onValue?.(result.value)
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), pollInterval(run))
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [path, active, onValue])

  return value
}

/** Convenience aliases so components read like the screens they render. */
export type { OverviewView, QueueView, ReconcileView, RunView }
export type Contract = Api
