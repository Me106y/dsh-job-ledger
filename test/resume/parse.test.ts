import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { parseResume, summarizeResume } from '../../src/resume/parse.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/resume.json', import.meta.url)), 'utf8'),
) as { baseinfo: unknown; expect: unknown; status: unknown }

test('the three payloads become one structured resume', () => {
  const resume = parseResume(fixture)

  assert.deepEqual(resume.expectedRoles, ['后端工程师'])
  assert.deepEqual(resume.expectedCities, ['深圳'])
  assert.equal(resume.salaryMin, 25_000)
  assert.equal(resume.salaryMax, 35_000)
  assert.equal(resume.workYears, 5)
  assert.equal(resume.education, '本科')
  assert.deepEqual(resume.skills, ['Go', 'Kubernetes', 'MySQL'])
  assert.equal(resume.experiences.length, 2)
  assert.deepEqual(resume.experiences[0], {
    company: '字节跳动',
    title: '后端工程师',
    start: '2021-07',
    end: '至今',
  })
  assert.equal(resume.completeness, 85)
  assert.equal(resume.contact?.name, '张三')
})

test('the summary line matches the shape the product promises', () => {
  assert.equal(summarizeResume(parseResume(fixture)), '后端工程师 / 深圳 / 25-35K / 5 年')
})

test('a payload without recognized fields is an error, not an empty resume', () => {
  // The dangerous failure mode is showing "未填期望" for a resume that is actually full.
  assert.throws(
    () =>
      parseResume({
        baseinfo: { code: 0, zpData: { somethingElse: true } },
        expect: { code: 0, zpData: {} },
        status: { code: 0, zpData: {} },
      }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_BODY_UNAVAILABLE')
      return true
    },
  )
})

test('a non-object payload is refused', () => {
  assert.throws(
    () => parseResume({ baseinfo: 'nope', expect: {}, status: {} }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_BODY_UNAVAILABLE')
      return true
    },
  )
})

test('missing optional sections degrade to empty rather than throwing', () => {
  const resume = parseResume({
    baseinfo: { code: 0, zpData: { name: '张三', workExpList: [] } },
    expect: { code: 0, zpData: {} },
    status: { code: 0, zpData: {} },
  })

  assert.deepEqual(resume.skills, [])
  assert.deepEqual(resume.experiences, [])
  assert.deepEqual(resume.expectedRoles, [])
  assert.equal(resume.workYears, undefined)
  assert.equal(summarizeResume(resume), '未填期望 / 城市不限 / 薪资不限 / 年限未知')
})

test('a bare body without zpData is still readable', () => {
  const resume = parseResume({
    baseinfo: { name: '张三', skillList: [{ skillName: 'Go' }] },
    expect: {},
    status: {},
  })
  assert.deepEqual(resume.skills, ['Go'])
})

test('salary given in yuan is not multiplied again', () => {
  const resume = parseResume({
    baseinfo: { zpData: { skillList: [{ skillName: 'Go' }] } },
    expect: { zpData: { expectList: [{ positionName: '后端', salaryMin: 20000, salaryMax: 40000 }] } },
    status: { zpData: {} },
  })
  assert.equal(resume.salaryMin, 20_000)
  assert.equal(resume.salaryMax, 40_000)
})
