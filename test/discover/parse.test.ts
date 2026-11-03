import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { parseJobList, parseSalary } from '../../src/discover/parse.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/search.json', import.meta.url)), 'utf8'),
) as unknown

test('a list response yields the identifiable cards and counts the rest', () => {
  const parsed = parseJobList(fixture)

  assert.equal(parsed.jobs.length, 3)
  assert.equal(parsed.invalid, 1)
  assert.deepEqual(parsed.jobs[0], {
    externalId: 'job_a1',
    url: 'https://www.zhipin.com/job_detail/job_a1.html',
    title: '后端工程师',
    company: '字节跳动',
    city: '深圳',
    salaryRaw: '25-35K·13薪',
    salaryMin: 25_000,
  })
})

test('the hard cap slices the list without counting the rest as invalid', () => {
  const parsed = parseJobList(fixture, 2)
  assert.equal(parsed.jobs.length, 2)
  assert.equal(parsed.invalid, 0)
})

test('salary text becomes a floor in yuan', () => {
  assert.deepEqual(parseSalary('25-35K·13薪'), { salaryRaw: '25-35K·13薪', salaryMin: 25_000 })
  assert.deepEqual(parseSalary('20K以上'), { salaryRaw: '20K以上', salaryMin: 20_000 })
  // Already in yuan: not multiplied again.
  assert.deepEqual(parseSalary('20000-40000'), { salaryRaw: '20000-40000', salaryMin: 20_000 })
  assert.deepEqual(parseSalary('面议'), { salaryRaw: '面议' })
  assert.deepEqual(parseSalary(undefined), {})
})

test('alternative key names are accepted', () => {
  const parsed = parseJobList({
    zpData: {
      list: [
        { externalId: 'x1', title: '前端工程师', companyName: '某公司', city: '北京', salaryName: '15-25K' },
      ],
    },
  })
  assert.equal(parsed.jobs[0]?.externalId, 'x1')
  assert.equal(parsed.jobs[0]?.city, '北京')
  assert.equal(parsed.jobs[0]?.salaryMin, 15_000)
})

test('a card with no identity at all is invalid, not silently kept', () => {
  const parsed = parseJobList({ zpData: { jobList: [{ jobName: '无 id 岗位', brandName: '某公司' }] } })
  assert.equal(parsed.jobs.length, 0)
  assert.equal(parsed.invalid, 1)
})

test('an empty list is parsed as empty, not as an error', () => {
  const parsed = parseJobList({ code: 0, zpData: { jobList: [] } })
  assert.deepEqual(parsed, { jobs: [], invalid: 0 })
})

test('a body that is not an object is refused', () => {
  assert.throws(
    () => parseJobList('nope'),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_BODY_UNAVAILABLE')
      return true
    },
  )
})
