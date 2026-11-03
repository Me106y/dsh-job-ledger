import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import { captureResponse, parseJsonBody } from '../../src/cdp/network.ts'
import { CdpSession } from '../../src/cdp/session.ts'
import { FakeTransport } from '../fixtures/transports.ts'

/** @returns a session wired to a fake browser */
function connected(): { transport: FakeTransport; session: CdpSession } {
  const transport = new FakeTransport()
  return { transport, session: new CdpSession(transport) }
}

/** @returns a tick that lets queued microtasks run */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('a matching response resolves with its parsed body', async () => {
  const { transport, session } = connected()
  const pending = captureResponse(session, /baseinfo\/query\.json/, 500)

  transport.receive({
    method: 'Network.responseReceived',
    params: {
      requestId: 'r1',
      response: {
        url: 'https://www.zhipin.com/wapi/zpgeek/resume/baseinfo/query.json?ka=track',
      },
    },
  })
  await tick()

  const bodyRequest = transport.requestsFor('Network.getResponseBody')[0]
  assert.equal(bodyRequest?.params?.requestId, 'r1')
  transport.receive({ id: bodyRequest?.id, result: { body: '{"code":0}', base64Encoded: false } })

  assert.deepEqual(await pending, { code: 0 })
  session.close()
})

test('responses that do not match the pattern are ignored', async () => {
  const { transport, session } = connected()
  const pending = captureResponse(session, /resume\/expect/, 500)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { url: 'https://www.zhipin.com/other.json' } },
  })
  await tick()
  assert.equal(transport.requestsFor('Network.getResponseBody').length, 0)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r2', response: { url: 'https://www.zhipin.com/wapi/resume/expect.json' } },
  })
  await tick()
  const bodyRequest = transport.requestsFor('Network.getResponseBody')[0]
  transport.receive({ id: bodyRequest?.id, result: { body: '{"code":0}', base64Encoded: false } })
  assert.deepEqual(await pending, { code: 0 })
  session.close()
})

test('a base64 body is decoded before parsing', async () => {
  const { transport, session } = connected()
  const pending = captureResponse(session, /status/, 500)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { url: 'https://x/wapi/resume/status.json' } },
  })
  await tick()
  const bodyRequest = transport.requestsFor('Network.getResponseBody')[0]
  transport.receive({
    id: bodyRequest?.id,
    result: { body: Buffer.from('{"code":0,"zpData":{}}').toString('base64'), base64Encoded: true },
  })

  assert.deepEqual(await pending, { code: 0, zpData: {} })
  session.close()
})

test('a response that never arrives fails as a navigation timeout', async () => {
  const { session } = connected()
  await assert.rejects(captureResponse(session, /never/, 5), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_NAV_TIMEOUT')
    return true
  })
  session.close()
})

test('an unreadable body fails as E_BODY_UNAVAILABLE after one retry', async () => {
  const { transport, session } = connected()
  const pending = captureResponse(session, /apply/, 2_000)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { url: 'https://x/wapi/apply.json' } },
  })
  await tick()
  const first = transport.requestsFor('Network.getResponseBody')[0]
  transport.receive({ id: first?.id, error: { message: 'No resource with given identifier' } })

  // The retry lands after a short delay; wait for the second request before answering it.
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  const second = transport.requestsFor('Network.getResponseBody')[1]
  assert.ok(second !== undefined, 'a retry should have been attempted')
  transport.receive({ id: second?.id, error: { message: 'still gone' } })

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_BODY_UNAVAILABLE')
    return true
  })
  session.close()
})

test('a retry that succeeds is not reported as a failure', async () => {
  const { transport, session } = connected()
  const pending = captureResponse(session, /apply/, 2_000)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { url: 'https://x/wapi/apply.json' } },
  })
  await tick()
  const first = transport.requestsFor('Network.getResponseBody')[0]
  transport.receive({ id: first?.id, error: { message: 'not buffered yet' } })

  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  const second = transport.requestsFor('Network.getResponseBody')[1]
  transport.receive({ id: second?.id, result: { body: '{"code":0}', base64Encoded: false } })

  assert.deepEqual(await pending, { code: 0 })
  session.close()
})

test('a body that is not JSON fails as E_BODY_UNAVAILABLE', () => {
  assert.throws(
    () => parseJsonBody('<html>login</html>', /x/),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_BODY_UNAVAILABLE')
      return true
    },
  )
})

test('a global pattern does not stick between URLs', async () => {
  const { transport, session } = connected()
  const pattern = /resume\/expect\.json/g
  const pending = captureResponse(session, pattern, 500)

  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { url: 'https://x/other.json' } },
  })
  transport.receive({
    method: 'Network.responseReceived',
    params: { requestId: 'r2', response: { url: 'https://x/resume/expect.json' } },
  })
  await tick()
  const bodyRequest = transport.requestsFor('Network.getResponseBody')[0]
  assert.equal(bodyRequest?.params?.requestId, 'r2')
  transport.receive({ id: bodyRequest?.id, result: { body: '{}', base64Encoded: false } })

  await pending
  session.close()
})
