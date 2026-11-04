import assert from 'node:assert/strict'
import test from 'node:test'

import { hardFilter } from '../../src/filter/rules.ts'
import { DEFAULT_PROFILE, mergeProfile } from '../../src/shared/profile.ts'
import type { FilterInput } from '../../src/filter/rules.ts'

/** @param jobType wanted kind @param title posting title @param jd optional JD text @returns the first rejection */
function check(jobType: 'all' | 'intern' | 'campus' | 'social', title: string, jd?: string): string | undefined {
  const profile = mergeProfile(DEFAULT_PROFILE, {
    target: { jobType, excludeKeywords: [], cities: [], salaryMin: 0 },
  })
  const input: FilterInput = {
    companyNorm: '某公司',
    title,
    cityNorm: '上海',
    ...(jd === undefined ? {} : { jdText: jd }),
  }
  return hardFilter(input, profile)?.reason
}

test('求职类型 不限 keeps every posting', () => {
  assert.equal(check('all', 'AI 应用开发实习'), undefined)
  assert.equal(check('all', '后端工程师'), undefined)
})

test('实习 keeps internship postings and rejects the rest', () => {
  assert.equal(check('intern', 'AI 应用开发实习'), undefined)
  assert.equal(check('intern', '算法实习生（可转正）'), undefined)
  assert.equal(check('intern', '后端工程师'), 'job-type-mismatch')
  // The JD counts too, not just the title.
  assert.equal(check('intern', 'AI 工程师', '该岗位接收实习生'), undefined)
})

test('校招 recognises campus wording', () => {
  assert.equal(check('campus', '2026 届校招 · 后端'), undefined)
  assert.equal(check('campus', '后端开发（应届生）'), undefined)
  assert.equal(check('campus', '后端工程师'), 'job-type-mismatch')
})

test('社招 excludes internships and campus roles', () => {
  assert.equal(check('social', '后端工程师'), undefined)
  assert.equal(check('social', 'AI 应用开发实习'), 'job-type-mismatch')
  assert.equal(check('social', '2026 校招后端'), 'job-type-mismatch')
})
