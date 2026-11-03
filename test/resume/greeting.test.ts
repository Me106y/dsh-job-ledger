import assert from 'node:assert/strict'
import test from 'node:test'

import type { Resume } from '../../src/resume/parse.ts'
import {
  DEFAULT_GREETING_TEMPLATES,
  MAX_GREETING_CHARS,
  fillGreeting,
  presetGreeting,
} from '../../src/resume/greeting.ts'
import { makeJob } from '../fixtures/helpers.ts'

const JOB = makeJob({
  id: 'j_1',
  company: '字节跳动',
  title: '后端工程师',
  city: '深圳',
  externalId: 'ext_1',
  jd: '负责后端服务设计，熟悉 Go 与高并发，五年以上经验',
})

const RESUME: Resume = {
  expectedRoles: ['后端工程师'],
  expectedCities: ['深圳'],
  workYears: 5,
  education: '本科',
  skills: ['Go', 'Kubernetes', 'MySQL'],
  experiences: [{ company: '某公司', title: '后端工程师', start: '2021-07', end: '至今' }],
}

test('a full resume fills the slots that have provenance on both sides', () => {
  const result = fillGreeting({ job: JOB, resume: RESUME })

  assert.equal(result.templateId, 'direct')
  assert.match(result.text, /后端工程师/)
  assert.match(result.text, /5年/)
  // Go appears in both the resume and the JD; Kubernetes does not appear in the JD.
  assert.match(result.text, /Go/)
  assert.doesNotMatch(result.text, /Kubernetes/)
  assert.equal(result.filled['技能1'], 'Go')
  assert.equal(result.truncated, false)
})

test('a clause whose slot cannot be filled disappears whole', () => {
  const noYears: Resume = { ...RESUME, workYears: undefined }
  const result = fillGreeting({ job: JOB, resume: noYears })

  assert.doesNotMatch(result.text, /年限|\[\]|\[/)
  assert.match(result.text, /熟悉Go/)
})

test('without a resume the preset still reads like a sentence', () => {
  const result = fillGreeting({ job: JOB })

  assert.equal(result.text, '你好，我对后端工程师这个岗位很感兴趣。')
  assert.equal(presetGreeting(JOB), result.text)
})

test('a model-proposed value without provenance is dropped', () => {
  const result = fillGreeting({
    job: JOB,
    resume: RESUME,
    values: { 技能1: 'Rust' },
  })

  // Rust is in neither the resume nor the JD, so the clause is dropped, not trusted.
  assert.doesNotMatch(result.text, /Rust/)
  assert.ok(result.dropped.includes('技能1'))
  assert.equal(result.filled['技能1'], undefined)
})

test('a model-proposed value with provenance is accepted', () => {
  const result = fillGreeting({ job: JOB, resume: RESUME, values: { 技能1: '高并发' } })
  assert.equal(result.filled['技能1'], '高并发')
})

test('links, emails and IM handles never enter a greeting', () => {
  const result = fillGreeting({
    job: { ...JOB, jdText: `${JOB.jdText ?? ''} 联系 hr@example.com 或微信 abc` },
    resume: RESUME,
    values: { 技能1: 'hr@example.com', 技能2: '微信 abc' },
  })

  assert.doesNotMatch(result.text, /@|微信|abc/)
  assert.ok(result.dropped.includes('技能1'))
})

test('a long greeting is truncated at the platform cap', () => {
  const long = '后端工程师'.repeat(40)
  const result = fillGreeting({
    job: { ...JOB, title: long, jdText: long },
    resume: RESUME,
    template: '你好，我对{岗位}这个岗位很感兴趣，方便聊聊吗？',
  })

  assert.equal([...result.text].length, MAX_GREETING_CHARS)
  assert.equal(result.truncated, true)
})

test('a custom template is used as given and reported by its id', () => {
  const result = fillGreeting({
    job: JOB,
    resume: RESUME,
    template: { id: 'mine', text: '想投{岗位}，做过{技能1}。' },
  })

  assert.equal(result.templateId, 'mine')
  assert.equal(result.text, '想投后端工程师，做过Go。')
})

test('a template id resolves to the built-in preset', () => {
  const result = fillGreeting({ job: JOB, resume: RESUME, template: 'polite' })
  assert.equal(result.templateId, 'polite')
  assert.match(result.text, /^您好/)
})

test('the built-in templates all stay within the cap when filled', () => {
  for (const template of DEFAULT_GREETING_TEMPLATES) {
    const result = fillGreeting({ job: JOB, resume: RESUME, template })
    assert.ok([...result.text].length <= MAX_GREETING_CHARS, template.id)
  }
})

test('a template carrying contact details falls back to the default preset', () => {
  const job = makeJob({ title: '后端工程师', company: '字节跳动', city: '深圳' })

  const result = fillGreeting({ job, template: '加我微信 abc123，帮你内推' })

  assert.equal(result.templateId, 'direct')
  assert.doesNotMatch(result.text, /微信|abc123/)
})

test('a link in a template is refused the same way', () => {
  const job = makeJob({ title: '后端工程师', company: '字节跳动', city: '深圳' })
  const result = fillGreeting({ job, template: '简历见 https://example.com/cv' })
  assert.equal(result.templateId, 'direct')
  assert.doesNotMatch(result.text, /https?:/)
})
