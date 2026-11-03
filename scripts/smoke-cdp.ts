/**
 * Browser-plumbing smoke test that needs no account.
 *
 * It launches the real Chrome, connects over CDP, opens BOSS, and checks the things that cannot be
 * checked without a browser: navigation, DOM evaluation, screenshots, the missing-selector error,
 * and login-wall detection. It deliberately does **not** log in or apply to anything.
 *
 * Run: `pnpm smoke:cdp`
 *
 * @module dsh-job-ledger/scripts/smoke-cdp
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CdpReader } from '../src/cdp/browser.ts'
import { BOSS_URLS, isLoginUrl } from '../src/cdp/boss.ts'
import { ensureChrome, findPageTarget } from '../src/cdp/chrome.ts'
import { PluginError } from '../src/shared/errors.ts'

/** A free-ish debug port, different from the plugin default so a running one is left alone. */
const PORT = 9333

/**
 * @param label what was checked @param detail what was found
 */
function ok(label: string, detail: string): void {
  console.log(`  ok   ${label}: ${detail}`)
}

/**
 * @param label what failed @param detail why @returns never
 */
function fail(label: string, detail: string): never {
  console.error(`  FAIL ${label}: ${detail}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const profileDir = mkdtempSync(join(tmpdir(), 'job-ledger-smoke-'))
  let handle
  try {
    console.log('1. launch Chrome')
    handle = await ensureChrome({ debugPort: PORT, profileDir })
    ok('chrome', `${handle.launched ? 'launched' : 'reused'} on :${String(handle.port)}`)

    console.log('2. connect over CDP (page target)')
    const page = await findPageTarget(handle.port)
    if (page === undefined) fail('page target', 'none found in /json/list')
    const reader = await CdpReader.open(page.webSocketDebuggerUrl)
    try {
      ok('session', 'websocket open, Page+Network enabled')

      console.log('3. navigate to BOSS')
      await reader.navigate(BOSS_URLS.search)
      const url = await reader.currentUrl()
      ok('navigate', url)

      console.log('4. DOM evaluation')
      const bodyPresent = await reader.waitFor('body', 8_000)
      if (!bodyPresent) fail('dom', 'body never appeared')

      // The shell can be up before the app renders; a bounded poll tells "slow" from "empty".
      let text = ''
      for (let attempt = 0; attempt < 12; attempt += 1) {
        text = await reader.text('body')
        if (text.trim() !== '') break
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      }
      if (text.trim() === '') {
        const png = await reader.screenshot()
        const path = '/tmp/job-ledger-smoke.png'
        writeFileSync(path, png)
        const where = await reader.currentUrl()
        fail('dom', `body text still empty after 12s at ${where}; screenshot: ${path}`)
      }
      ok('dom', `body text ${String(text.length)} chars`)

      console.log('5. screenshot')
      const png = await reader.screenshot()
      if (png.length === 0) fail('screenshot', 'empty buffer')
      ok('screenshot', `${String(png.length)} bytes, PNG magic ${png.subarray(0, 4).toString('hex')}`)

      console.log('6. missing selector is a coded error')
      try {
        await reader.click('#job-ledger-smoke-does-not-exist', 400)
        fail('missing selector', 'click resolved instead of throwing')
      } catch (error) {
        if (!(error instanceof PluginError) || error.code !== 'E_SELECTOR_MISSING') throw error
        ok('missing selector', `E_SELECTOR_MISSING after 400ms`)
      }

      console.log('7. login wall detection (URL only)')
      // The redirect lands after the frame commits; poll like the real reader does.
      let finalUrl = url
      for (let attempt = 0; attempt < 10 && !isLoginUrl(finalUrl); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
        finalUrl = await reader.currentUrl()
      }
      // A login overlay without a URL change is not detectable here — say so instead of guessing.
      ok(
        'login wall',
        isLoginUrl(finalUrl)
          ? `redirected to ${finalUrl}`
          : `stayed at ${finalUrl} (an overlay would not be detected)`,
      )
    } finally {
      reader.close()
    }
  } finally {
    if (handle?.launched === true) {
      // Only the browser we started, identified by its own profile directory.
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync('pkill', ['-f', `user-data-dir=${profileDir}`])
      } catch {
        // Already gone.
      }
    }
    rmSync(profileDir, { recursive: true, force: true })
  }
}

await main()
