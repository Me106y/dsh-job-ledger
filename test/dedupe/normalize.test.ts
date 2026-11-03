import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeCity,
  normalizeCompany,
  normalizeTitle,
  normalizeUrl,
} from '../../src/dedupe/normalize.ts'

test('company: legal forms and marketing noise collapse', () => {
  assert.equal(normalizeCompany('小米科技有限公司'), '小米')
  assert.equal(normalizeCompany('小米科技'), '小米')
  // 北京 without 市 is part of the brand; only a two-character city + 市 is a prefix.
  assert.equal(normalizeCompany('北京字节跳动股份有限公司'), '北京字节跳动')
  assert.equal(normalizeCompany('北京市字节跳动股份有限公司'), '字节跳动')
  assert.equal(normalizeCompany('上海汽车集团股份有限公司'), '上海汽车')
  assert.equal(normalizeCompany('某某网络信息技术有限公司'), '某某')
})

test('company: a bare two-character city prefix is stripped only with 市', () => {
  assert.equal(normalizeCompany('北京市美团'), '美团')
  // No 市 in the name: the city is part of the brand and must survive.
  assert.equal(normalizeCompany('上海汽车'), '上海汽车')
})

test('company: case and whitespace are folded', () => {
  assert.equal(normalizeCompany('ＡＣＭＥ   Corp'), 'acmecorp')
  assert.equal(normalizeCompany('Acme Corp'), 'acmecorp')
})

test('title: urgency noise and the role suffix are dropped', () => {
  assert.equal(normalizeTitle('后端工程师（急招）'), '后端工程师')
  assert.equal(normalizeTitle('资深 Golang 开发'), '资深golang开发')
  assert.equal(normalizeTitle('后端工程师岗位'), '后端工程师')
  assert.equal(normalizeTitle('见习产品经理【双休】'), '见习产品经理')
})

test('title: brackets and seniority words are part of the role (decision #29)', () => {
  // 「后端工程师（Java）」and「后端工程师（Go）」are two jobs, not one.
  assert.notEqual(normalizeTitle('后端工程师（Java）'), normalizeTitle('后端工程师（Go）'))
  // 高级 and 初级 are different roles.
  assert.notEqual(normalizeTitle('高级后端工程师'), normalizeTitle('后端工程师'))
  // The qualifier itself survives normalization.
  assert.equal(normalizeTitle('数据分析师(外包)'), '数据分析师(外包)')
})

test('city: suffixes are removed and remote collapses to one value', () => {
  assert.equal(normalizeCity('深圳市'), '深圳')
  assert.equal(normalizeCity('北京地区'), '北京')
  assert.equal(normalizeCity('远程'), 'remote')
  assert.equal(normalizeCity('全国'), 'remote')
  assert.equal(normalizeCity('不限'), 'remote')
})

test('url: query and hash are dropped so tracking params cannot fork identity', () => {
  assert.equal(
    normalizeUrl('https://www.zhipin.com/job_detail/abc.html?ka=search&lid=1#top'),
    'https://www.zhipin.com/job_detail/abc.html',
  )
  assert.equal(normalizeUrl('not a url#frag'), 'not a url')
})
