/**
 * Text normalization for dedupe (TECH §7.1).
 *
 * Every rule here is deliberately narrow. A normalizer that is too clever turns two different jobs
 * into one, and a wrong duplicate is unrecoverable: the job never appears again and the user never
 * learns why (PRD §5.3). So: no segmentation, no pinyin, no synonyms — only the noise that clearly
 * is not part of the company or role name.
 *
 * The known side effects are accepted and listed next to each rule rather than discovered later.
 *
 * @module dsh-job-ledger/dedupe/normalize
 */

/** Legal-form and marketing noise stripped from company names, longest first. */
const COMPANY_NOISE: readonly string[] = [
  '股份有限公司',
  '有限责任公司',
  '信息技术',
  '电子商务',
  '有限公司',
  '科技',
  '网络',
  '技术',
  '软件',
  '集团',
  '控股',
]

/** Seniority and urgency words stripped from job titles. */
const TITLE_NOISE: readonly string[] = [
  '高级',
  '资深',
  '中级',
  '初级',
  '专家',
  '首席',
  '见习',
  'senior',
  'junior',
  'lead',
  '急招',
  '急聘',
  '双休',
  '五险一金',
]

/** Cities that mean "location does not restrict this job". */
const REMOTE_WORDS: ReadonlySet<string> = new Set(['远程', '全国', '不限', 'remote', '线上'])

/** Loop guard for the noise-stripping passes. */
const MAX_PASSES = 8

/**
 * NFKC plus a lowercase pass. NFKC folds full-width Latin and digits, which is what makes
 * `Senior` and `Ｓｅｎｉｏｒ` the same token.
 *
 * @param raw input text
 * @returns folded text
 */
export function fold(raw: string): string {
  return raw.normalize('NFKC').toLowerCase()
}

/**
 * Normalize a company name.
 *
 * Known side effects (accepted, TECH §7.1): 「小米科技」and「小米」collapse; a leading
 * two-character city plus 市 is dropped, so「北京市字节跳动」and「字节跳动」match while
 * 「上海汽车」is left alone (it has no 市).
 *
 * @param raw company name as shown by the platform
 * @returns normalized company name
 */
export function normalizeCompany(raw: string): string {
  let text = fold(raw).replace(/\s+/g, '')
  text = text.replace(/^[\u4e00-\u9fa5]{2}市/, '')
  // Strip legal forms and noise in passes: removing「有限责任公司」can expose a trailing「科技」.
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = text
    for (const noise of COMPANY_NOISE) {
      text = text.split(noise).join('')
    }
    if (text === before) break
  }
  return text
}

/**
 * Normalize a job title.
 *
 * Known side effect: 「高级后端工程师（急招）」→「后端工程师」. A parenthesized qualifier is dropped
 * wholesale, on the theory that it is a modifier rather than the role.
 *
 * @param raw job title
 * @returns normalized title
 */
export function normalizeTitle(raw: string): string {
  let text = fold(raw)
  text = text.replace(/[（(【[][^）)】\]]*[）)】\]]/g, '')
  for (const noise of TITLE_NOISE) {
    text = text.split(noise).join('')
  }
  text = text.replace(/(岗位|职位)$/g, '')
  return text.replace(/\s+/g, '')
}

/**
 * Normalize a city.
 *
 * @param raw city as shown by the platform
 * @returns normalized city, with remote-style locations collapsed to `remote`
 */
export function normalizeCity(raw: string): string {
  const text = fold(raw).replace(/\s+/g, '')
  if (REMOTE_WORDS.has(text)) return 'remote'
  return text.replace(/(市|地区|站)$/g, '')
}

/**
 * Normalize a job URL.
 *
 * Query and hash are dropped: tracking parameters must not create a second identity for the same
 * posting (TECH §7.1).
 *
 * @param raw absolute URL
 * @returns URL without query or hash; the input is returned unchanged when it cannot be parsed
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split('#')[0]?.split('?')[0] ?? raw
  }
}
