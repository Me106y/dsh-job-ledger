/**
 * Sidebar icon: a ledger page with a check.
 *
 * @module dsh-job-ledger/client/icon
 */

import type { ReactElement } from 'react'

/**
 * @returns a 20×20 SVG that inherits the current colour
 */
export function LedgerIcon(): ReactElement {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 6.5h7M6.5 9.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M6.8 13.2l1.8 1.8 3.6-3.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
