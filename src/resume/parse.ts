/**
 * Turn the three resume payloads into a structured resume (PRD §5.1).
 *
 * ⚠️ The response shapes are **not yet verified against a live account** (TECH §20). The parser is
 * therefore written to be tolerant of shifted keys but strict about being able to recognize the
 * payload at all: a body that yields none of the known fields is an error, never an empty resume.
 * Showing "未填期望" for a resume that is actually full would be worse than failing.
 *
 * @module dsh-job-ledger/resume/parse
 */

import { PluginError } from '../shared/errors.ts'

/** One job in the resume's work history. */
export interface ResumeExperience {
  readonly company: string
  readonly title: string
  readonly start?: string
  readonly end?: string
}

/** Personal details. Dropped entirely unless `resumeExposure` is `full` (TECH §16.2). */
export interface ResumeContact {
  readonly name?: string
  readonly phone?: string
  readonly email?: string
}

/** What the plugin knows about the user's online resume. */
export interface Resume {
  readonly expectedRoles: readonly string[]
  readonly expectedCities: readonly string[]
  readonly salaryMin?: number
  readonly salaryMax?: number
  readonly workYears?: number
  readonly education?: string
  readonly skills: readonly string[]
  readonly experiences: readonly ResumeExperience[]
  readonly completeness?: number
  readonly contact?: ResumeContact
}

/** The three responses PRD §5.1 names. */
export interface ResumePayloads {
  readonly baseinfo: unknown
  readonly expect: unknown
  readonly status: unknown
}

/** @param value candidate @returns it as a plain object, when it is one */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** @param value candidate @returns it as an array, or empty */
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** @param value candidate @returns it as a non-empty trimmed string, or undefined */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** @param value candidate @returns it as a finite number, or undefined */
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Unwrap `zpData` (BOSS wraps everything), tolerating a bare body.
 *
 * @param payload response body
 * @param label which endpoint, for the error message
 * @returns the payload's data object
 * @throws PluginError `E_BODY_UNAVAILABLE` when the body is not an object at all
 */
function dataOf(payload: unknown, label: string): Record<string, unknown> {
  const body = record(payload)
  if (body === undefined) {
    throw new PluginError('E_BODY_UNAVAILABLE', { what: `${label} is not an object` })
  }
  return record(body.zpData) ?? record(body.data) ?? body
}

/**
 * BOSS reports salary either as a range string (`25-35K`) or as bare numbers (`25`, `35`).
 *
 * Bare numbers below 1000 are read as K/month; anything else is taken as yuan. ⚠️ Unverified.
 *
 * @param min minimum, as sent
 * @param max maximum, as sent
 * @returns salary bounds in yuan per month
 */
function salaryBounds(
  min: unknown,
  max: unknown,
): { salaryMin?: number; salaryMax?: number } {
  const toYuan = (value: number | undefined): number | undefined => {
    if (value === undefined) return undefined
    return value > 0 && value < 1000 ? value * 1000 : value
  }
  const minYuan = toYuan(numeric(min))
  const maxYuan = toYuan(numeric(max))
  return {
    ...(minYuan === undefined ? {} : { salaryMin: minYuan }),
    ...(maxYuan === undefined ? {} : { salaryMax: maxYuan }),
  }
}

/** @param desc e.g. `5年` @returns the number of years, when parseable */
function yearsFromDescription(desc: string | undefined): number | undefined {
  if (desc === undefined) return undefined
  const match = /(\d+)/.exec(desc)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Parse the three payloads.
 *
 * @param payloads baseinfo / expect / status bodies
 * @returns the structured resume
 * @throws PluginError `E_BODY_UNAVAILABLE` when the base payload contains no recognizable field
 */
export function parseResume(payloads: ResumePayloads): Resume {
  const base = dataOf(payloads.baseinfo, 'resume baseinfo')
  const expect = dataOf(payloads.expect, 'resume expectation')
  const status = dataOf(payloads.status, 'resume status')

  const experiences: ResumeExperience[] = []
  for (const entry of list(base.workExpList ?? base.workExperienceList)) {
    const item = record(entry)
    if (item === undefined) continue
    const company = text(item.companyName)
    const title = text(item.positionName)
    if (company === undefined && title === undefined) continue
    const start = text(item.startDate)
    const end = text(item.endDate)
    experiences.push({
      company: company ?? '未知公司',
      title: title ?? '未知职位',
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    })
  }

  const skills: string[] = []
  for (const entry of list(base.skillList ?? base.skills)) {
    const item = record(entry)
    const name = item === undefined ? text(entry) : text(item.skillName)
    if (name !== undefined) skills.push(name)
  }

  const expectedRoles: string[] = []
  const expectedCities: string[] = []
  let expectMin: unknown
  let expectMax: unknown
  for (const entry of list(expect.expectList ?? expect.expectationList)) {
    const item = record(entry)
    if (item === undefined) continue
    const role = text(item.positionName)
    const city = text(item.cityName)
    if (role !== undefined) expectedRoles.push(role)
    if (city !== undefined) expectedCities.push(city)
    if (expectMin === undefined) expectMin = item.salaryMin
    if (expectMax === undefined) expectMax = item.salaryMax
  }

  const name = text(base.name)
  const workYears =
    numeric(base.workYears) ??
    numeric(base.workYear) ??
    yearsFromDescription(text(base.workYearDesc))

  const recognized =
    name !== undefined ||
    skills.length > 0 ||
    experiences.length > 0 ||
    expectedRoles.length > 0 ||
    workYears !== undefined
  if (!recognized) {
    throw new PluginError('E_BODY_UNAVAILABLE', {
      what: 'resume payload has no recognizable field — the page shape likely changed',
    })
  }

  const bounds = salaryBounds(expectMin, expectMax)
  const education = text(base.degreeCategory) ?? text(base.degree)
  const completeness = numeric(status.completePercent) ?? numeric(status.completeness)

  return {
    expectedRoles,
    expectedCities,
    ...bounds,
    ...(workYears === undefined ? {} : { workYears }),
    ...(education === undefined ? {} : { education }),
    skills,
    experiences,
    ...(completeness === undefined ? {} : { completeness }),
    ...(name === undefined ? {} : { contact: { name } }),
  }
}

/**
 * One line a person can check at a glance (PRD §8.1 step 2).
 *
 * @param resume structured resume
 * @returns e.g. `后端工程师 / 深圳 / 25-35K / 5 年`
 */
export function summarizeResume(resume: Resume): string {
  const role = resume.expectedRoles[0] ?? '未填期望'
  const city = resume.expectedCities[0] ?? '城市不限'
  const salary =
    resume.salaryMin !== undefined && resume.salaryMax !== undefined
      ? `${String(resume.salaryMin / 1000)}-${String(resume.salaryMax / 1000)}K`
      : '薪资不限'
  const years = resume.workYears !== undefined ? `${String(resume.workYears)} 年` : '年限未知'
  return `${role} / ${city} / ${salary} / ${years}`
}
