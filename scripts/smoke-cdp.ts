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

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { CdpReader } from '../src/cdp/browser.ts'
import { BOSS_URLS, isLoginUrl } from '../src/cdp/boss.ts'
import { waitForLogin } from '../src/cdp/login.ts'
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

      console.log('8. a page that reports what happened to it')
      const page = createServer((request, response) => {
        if (request.url === '/api/ping') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, trusted: true }))
          return
        }
        if (request.url === '/web/geek/job') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><html><body><p id="result">logged in</p></body></html>')
          return
        }
        if (request.url === '/web/user/') {
          // Behaves like a completed scan: the login URL leaves on its own after a moment.
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          // A meta refresh was firing immediately in this Chrome; a timer is unambiguous.
          response.end(
            '<!doctype html><script>setTimeout(() => { location.href = "/web/geek/job" }, 1500)</script>'
          )
          return
        }
        if (request.url === '/web/user/stay') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><title>login</title><p>nobody scans</p>')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><html><body>
          <button id="go">go</button>
          <input id="name" />
          <p id="result">idle</p>
          <p id="echo"></p>
          <script>
            document.getElementById('go').addEventListener('click', (event) => {
              document.getElementById('result').textContent = event.isTrusted ? 'trusted' : 'synthetic'
            })
            document.getElementById('name').addEventListener('input', (event) => {
              document.getElementById('echo').textContent = event.target.value
            })
            fetch('/api/ping')
          </script>
        </body></html>`)
      })
      await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${String((page.address() as AddressInfo).port)}`

      console.log('9. capture a response the page requested itself')
      const pending = reader.capture(/\/api\/ping/)
      await reader.navigate(`${origin}/`)
      const payload = (await pending) as { ok?: boolean }
      if (payload.ok !== true) fail('capture', `unexpected payload ${JSON.stringify(payload)}`)
      ok('capture', JSON.stringify(payload))

      console.log('10. a click is a trusted event (no synthetic .click())')
      await reader.click('#go', 3_000)
      const result = await reader.text('#result')
      if (result !== 'trusted') fail('click', `page saw "${result}"`)
      ok('click', 'page reports event.isTrusted === true')

      console.log('11. typing reaches the element')
      await reader.typeText('#name', 'hello', 3_000)
      const echoed = await reader.text('#echo')
      if (echoed !== 'hello') fail('type', `page echoes "${echoed}"`)
      ok('type', 'input event carries the inserted text')

      console.log('12. login wait succeeds when the login URL is left')
      await reader.navigate(`${origin}/web/user/`)
      // Wait until the browser actually reports the page we navigated to.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (isLoginUrl(await reader.currentUrl())) break
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
      const started = Date.now()
      const loggedIn = await waitForLogin(reader, { timeoutMs: 10_000, pollMs: 250 })
      if (!loggedIn) fail('login wait', 'never saw the login URL go away')
      ok('login wait', `saw it leave after ${String(Date.now() - started)}ms`)

      console.log('13. login wait gives up when nobody scans')
      await reader.navigate(`${origin}/web/user/stay`)
      const gaveUp = await waitForLogin(reader, { timeoutMs: 1_200, pollMs: 200 })
      if (gaveUp) fail('login wait timeout', 'reported success on a page that never moved')
      ok('login wait timeout', 'returned false instead of pretending')

      await new Promise<void>((resolve) => page.close(() => resolve()))
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
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
    // Best effort: Chrome may still be flushing its profile when the process is asked to leave, and
    // a leftover temp directory is not a failed smoke test.
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      console.log(`  note temp profile left behind: ${profileDir}`)
    }
  }
}

await main()
