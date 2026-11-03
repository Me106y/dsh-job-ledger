/**
 * Greeting by template and slot filling, never by free generation (PRD §5.5).
 *
 * The rule that makes this safe: **every slot value must be quotable from the resume or the JD**.
 * If it cannot be found, the slot is dropped, and the sentence around it goes with it — a shorter
 * honest greeting beats a fluent invented one that falls apart in the first interview.
 *
 * The model may choose a template and propose values; this module re-checks the provenance of every
 * proposed value, so the model cannot smuggle an invention in through the side door.
 *
 * Templates use `[[...]]` for an optional clause: the whole clause disappears when any slot inside
 * it cannot be filled, which is how "省略整个分句" is implemented without sentence surgery.
 *
 * @module dsh-job-ledger/resume/greeting
 */

import type { Job } from '../ledger/events.ts'
import { fold } from '../dedupe/normalize.ts'
import type { Resume } from './parse.ts'

/** BOSS caps the greeting; longer text is truncated rather than rejected. */
export const MAX_GREETING_CHARS = 100

/** One base greeting a model or the user can pick. */
export interface GreetingTemplate {
  readonly id: string
  readonly text: string
}

/**
 * The presets. They are deliberately plain: the personality should come from the filled facts,
 * not from adjectives.
 */
export const DEFAULT_GREETING_TEMPLATES: readonly GreetingTemplate[] = [
  {
    id: 'direct',
    text: '你好，我对{岗位}这个岗位很感兴趣[[，有{年限}相关经验]][[，熟悉{技能1}]]。',
  },
  {
    id: 'polite',
    text: '您好，看到您在招{岗位}[[，我有{年限}经验]][[，{技能1}比较熟]]，方便聊聊吗？',
  },
  {
    id: 'match',
    text: '{岗位}和我{方向}的背景比较匹配[[，{技能1}这块做过]]，想和您沟通一下。',
  },
]

/** What the caller (tool, panel or test) provides. */
export interface GreetingRequest {
  readonly job: Job
  /** Omitted when the resume could not be read: the greeting then uses the bare preset. */
  readonly resume?: Resume | undefined
  /** A template object, an id from {@link DEFAULT_GREETING_TEMPLATES}, or raw template text. */
  readonly template?: GreetingTemplate | string | undefined
  /** Values the model proposed; each one is provenance-checked before use. */
  readonly values?: Readonly<Record<string, string>> | undefined
}

/** What was produced, plus the audit trail. */
export interface GreetingResult {
  readonly text: string
  readonly templateId: string
  /** Slot name to the exact value used. */
  readonly filled: Readonly<Record<string, string>>
  /** Slots dropped because no value had provenance. */
  readonly dropped: readonly string[]
  readonly truncated: boolean
}

/** Slot syntax. */
const SLOT = /\{([^{}]+)\}/g

/** Optional clause syntax: the whole `[[...]]` disappears if a slot inside cannot be filled. */
const CLAUSE = /\[\[([\s\S]*?)\]\]/g

/** Things a greeting must never contain (PRD §5.5, hard rule). */
const FORBIDDEN = /https?:|www\.|@|微信|wechat|qq/i

/**
 * Flatten everything quotable from the resume and the job into one searchable text.
 *
 * @param job job being applied to
 * @param resume resume, when available
 * @returns the provenance corpus
 */
function corpusOf(job: Job, resume: Resume | undefined): string {
  const parts: string[] = [job.title, job.jdText ?? '', job.company]
  if (resume !== undefined) {
    parts.push(...resume.expectedRoles, ...resume.expectedCities, ...resume.skills)
    if (resume.education !== undefined) parts.push(resume.education)
    // The years are derived from the work history, so they count as quotable from the resume.
    if (resume.workYears !== undefined) {
      parts.push(`${String(resume.workYears)}年`, String(resume.workYears))
    }
    for (const experience of resume.experiences) {
      parts.push(experience.company, experience.title)
    }
  }
  return fold(parts.join('\n'))
}

/**
 * @param value candidate slot value @param corpus provenance text @returns whether it is quotable
 */
function hasProvenance(value: string, corpus: string): boolean {
  const needle = fold(value).trim()
  if (needle === '') return false
  return corpus.includes(needle)
}

/**
 * Skills that appear in both the resume and the job description.
 *
 * @param job job @param resume resume @returns shared skills, resume order
 */
function sharedSkills(job: Job, resume: Resume): string[] {
  const jd = fold(job.jdText ?? '')
  if (jd === '') return []
  return resume.skills.filter((skill) => fold(skill).length > 0 && jd.includes(fold(skill)))
}

/**
 * @returns the default template, or throws when the preset table is empty
 */
function defaultTemplate(): GreetingTemplate {
  const fallback = DEFAULT_GREETING_TEMPLATES[0]
  if (fallback === undefined) throw new Error('no default greeting template')
  return fallback
}

/**
 * Resolve the template from the request.
 *
 * Template *text* is not provenance-checked (only slot values are), so a template carrying contact
 * details or a link would slip past the slot guard. Decision 25 says greetings are presets plus
 * slots, not free prose: a template that trips the forbidden pattern falls back to the default
 * rather than being sent.
 *
 * @param template object, id or raw text @returns the template and its id
 */
function resolveTemplate(template: GreetingTemplate | string | undefined): GreetingTemplate {
  if (template === undefined) return defaultTemplate()
  const resolved: GreetingTemplate =
    typeof template === 'object'
      ? template
      : (DEFAULT_GREETING_TEMPLATES.find((candidate) => candidate.id === template) ?? {
          id: 'custom',
          text: template,
        })
  return FORBIDDEN.test(resolved.text) ? defaultTemplate() : resolved
}

/**
 * Candidate values for every slot, before provenance filtering.
 *
 * @param request what the caller supplied
 * @param shared shared skills
 * @returns slot name to candidate value
 */
function candidates(
  request: GreetingRequest,
  shared: readonly string[],
): Map<string, string | undefined> {
  const { job, resume, values } = request
  const pick = (name: string): string | undefined => values?.[name]

  const firstSkill = shared[0]
  const secondSkill = shared[1]

  return new Map<string, string | undefined>([
    ['岗位', pick('岗位') ?? job.title],
    ['方向', pick('方向') ?? resume?.expectedRoles[0] ?? job.title],
    ['年限', pick('年限') ?? (resume?.workYears === undefined ? undefined : `${String(resume.workYears)}年`)],
    ['技能1', pick('技能1') ?? firstSkill],
    ['技能2', pick('技能2') ?? secondSkill],
    // Extraction of a "matched requirement" from arbitrary JD prose waits for real JD text; until
    // then only a model-proposed value with provenance can fill it.
    ['匹配点', pick('匹配点')],
  ])
}

/**
 * Fill a greeting.
 *
 * @param request job, resume, template and proposed values
 * @returns the text plus what was used and what was dropped
 */
export function fillGreeting(request: GreetingRequest): GreetingResult {
  const template = resolveTemplate(request.template)
  const corpus = corpusOf(request.job, request.resume)
  const proposed = candidates(request, request.resume === undefined ? [] : sharedSkills(request.job, request.resume))

  const filled: Record<string, string> = {}
  const dropped: string[] = []
  for (const [name, value] of proposed) {
    if (value === undefined || value.trim() === '') {
      dropped.push(name)
      continue
    }
    if (FORBIDDEN.test(value) || !hasProvenance(value, corpus)) {
      dropped.push(name)
      continue
    }
    filled[name] = value
  }

  // 岗位 is the one required slot: without it the whole rewrite is pointless.
  if (filled['岗位'] === undefined) {
    return {
      text: '',
      templateId: template.id,
      filled: {},
      dropped: [...new Set([...dropped, '岗位'])],
      truncated: false,
    }
  }

  const withClauses = template.text.replace(CLAUSE, (clause, inner: string) => {
    for (const match of inner.matchAll(SLOT)) {
      const name = match[1] ?? ''
      if (filled[name] === undefined) return ''
    }
    return inner
  })

  const text = withClauses.replace(SLOT, (_all, name: string) => filled[name] ?? '')
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/，{2,}/g, '，')
    .replace(/，\s*。/g, '。')
    .replace(/^[，。\s]+/, '')
    .trim()

  const characters = [...cleaned]
  const truncated = characters.length > MAX_GREETING_CHARS
  return {
    text: truncated ? characters.slice(0, MAX_GREETING_CHARS).join('') : cleaned,
    templateId: template.id,
    filled,
    dropped: [...new Set(dropped)],
    truncated,
  }
}

/**
 * The bare preset, used when nothing is known about the job beyond its title.
 *
 * @param job job @returns a greeting that cannot be wrong
 */
export function presetGreeting(job: Job): string {
  return fillGreeting({ job }).text
}
