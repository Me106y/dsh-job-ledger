import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { parseDeliverList } from '../../src/reconcile/parse.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

test('the delivered list yields identifiable rows and counts the rest', () => {
  const parsed = parseDeliverList(fixture)

  assert.equal(parsed.rows.length, 3)
  assert.equal(parsed.invalid, 1)
  assert.deepEqual(parsed.rows[0], {
    externalId: 'job_a1',
    company: '字节跳动',
    title: '后端工程师',
    city: '深圳',
    at: '2026-11-01T02:00:00.000Z',
  })
})

test('a row without a platform id is invalid, not matched by fuzzy fields', () => {
  const parsed = parseDeliverList({
    zpData: { jobList: [{ brandName: '某公司', jobName: '后端工程师', cityName: '深圳' }] },
  })
  assert.equal(parsed.rows.length, 0)
  assert.equal(parsed.invalid, 1)
})

test('alternative key names are accepted', () => {
  const parsed = parseDeliverList({
    zpData: { list: [{ encryptJobId: 'x', companyName: '甲公司', positionName: '前端', city: '北京' }] },
  })
  assert.deepEqual(parsed.rows[0], {
    externalId: 'x',
    company: '甲公司',
    title: '前端',
    city: '北京',
  })
})

test('a body that is not an object is refused', () => {
  assert.throws(
    () => parseDeliverList('nope'),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_BODY_UNAVAILABLE')
      return true
    },
  )
})
