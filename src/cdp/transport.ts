/**
 * The real CDP transport, on top of Node's global `WebSocket` (Node 22+, no dependency).
 *
 * Node ships a browser-compatible `WebSocket`, so the host side needs nothing installed. The
 * global is reached through a narrow structural type: `lib` is ES2023 (no DOM), and pulling DOM
 * types in just to name a socket would make the rest of the project think it runs in a browser.
 *
 * @module dsh-job-ledger/cdp/transport
 */

import { CdpError } from './session.ts'
import type { CdpTransport } from './session.ts'

/** How long to wait for the WebSocket handshake. */
export const CONNECT_TIMEOUT_MS = 10_000

/** The slice of `WebSocket` this module uses. */
interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void
}

/**
 * Wrap an open socket as a {@link CdpTransport}.
 *
 * @param url `webSocketDebuggerUrl` from `/json/version`
 * @param timeoutMs handshake budget
 * @returns the transport
 * @throws CdpError when the handshake fails or times out
 */
export function webSocketTransport(url: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    let socket: SocketLike
    try {
      socket = new WebSocket(url) as unknown as SocketLike
    } catch (error) {
      reject(new CdpError('disconnect', `cannot open ${url}: ${String(error)}`))
      return
    }

    const messageHandlers: ((text: string) => void)[] = []
    const closeHandlers: (() => void)[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.close()
      reject(new CdpError('timeout', `handshake with ${url} timed out`))
    }, timeoutMs)

    socket.addEventListener('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        send(text: string): void {
          socket.send(text)
        },
        close(): void {
          socket.close()
        },
        onMessage(handler: (text: string) => void): void {
          messageHandlers.push(handler)
        },
        onClose(handler: () => void): void {
          closeHandlers.push(handler)
        },
      })
    })

    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data)
      for (const handler of messageHandlers) handler(text)
    })

    socket.addEventListener('close', () => {
      for (const handler of closeHandlers) handler()
    })

    socket.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new CdpError('disconnect', `cannot connect to ${url}`))
    })
  })
}
