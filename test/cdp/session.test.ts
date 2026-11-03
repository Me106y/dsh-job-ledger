import assert from 'node:assert/strict'
import test from 'node:test'

import { CdpError, CdpSession } from '../../src/cdp/session.ts'
import { FakeTransport } from '../fixtures/transports.ts'

test('a call resolves with the result of its reply', async () => {
  const transport = new FakeTransport()
  const session = new CdpSession(transport)

  const pending = session.call<{ frameId: string }>('Page.navigate', { url: 'about:blank' })
  transport.receive({ id: 1, result: { frameId: 'f_1' } })

  assert.deepEqual(await pending, { frameId: 'f_1' })
  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Page.navigate',
    params: { url: 'about:blank' },
  })
  session.close()
})

test('a protocol error rejects the call instead of leaving it pending', async () => {
  const transport = new FakeTransport()
  const session = new CdpSession(transport)

  const pending = session.call('Network.enable')
  transport.receive({ id: 1, error: { message: 'not allowed' } })

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CdpError)
    assert.equal(error.kind, 'protocol')
    assert.equal(error.method, 'Network.enable')
    return true
  })
  session.close()
})

test('a call that never answers times out', async () => {
  const session = new CdpSession(new FakeTransport())
  await assert.rejects(session.call('No.such.method', {}, 5), (error: unknown) => {
    assert.ok(error instanceof CdpError)
    assert.equal(error.kind, 'timeout')
    return true
  })
  session.close()
})

test('events reach subscribers and unsubscribe stops them', () => {
  const transport = new FakeTransport()
  const session = new CdpSession(transport)
  const seen: unknown[] = []
  const off = session.on('Network.responseReceived', (params) => {
    seen.push(params.requestId)
  })

  transport.receive({ method: 'Network.responseReceived', params: { requestId: 'r1' } })
  transport.receive({ method: 'Network.responseReceived', params: { requestId: 'r2' } })
  off()
  transport.receive({ method: 'Network.responseReceived', params: { requestId: 'r3' } })

  assert.deepEqual(seen, ['r1', 'r2'])
  session.close()
})

test('closing rejects everything still waiting with a disconnect', async () => {
  const session = new CdpSession(new FakeTransport())
  const pending = session.call('Page.enable', {}, 10_000)
  session.close()

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CdpError)
    assert.equal(error.kind, 'disconnect')
    return true
  })
})

test('calling after close is refused immediately', async () => {
  const session = new CdpSession(new FakeTransport())
  session.close()
  await assert.rejects(session.call('Page.enable'), (error: unknown) => {
    assert.ok(error instanceof CdpError)
    assert.equal(error.kind, 'disconnect')
    return true
  })
})

test('a malformed frame does not break the session', async () => {
  const transport = new FakeTransport()
  const session = new CdpSession(transport)

  const pending = session.call('Page.enable')
  // A peer that sends a non-frame must not take the session down with it.
  transport.receive('not an object')
  transport.receive({ id: 1, result: {} })

  assert.deepEqual(await pending, {})
  session.close()
})
