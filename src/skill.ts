/**
 * The `job-ledger` skill: orchestration constraints, registered as text (PRD §5.9, TECH §13.2).
 *
 * The body lives in `assets/job-ledger/SKILL.md` and ships in the npm package, so editing the rules
 * is editing prose — no rebuild, no code review of a template string. If the file cannot be read the
 * plugin still mounts; a missing skill is a degraded experience, not a broken ledger.
 *
 * @module dsh-job-ledger/skill
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Skill name the model sees. */
export const SKILL_NAME = 'job-ledger'

/** One-line routing description. */
export const SKILL_DESCRIPTION =
  '求职投递账本的编排硬约束：先对账、清单确认、uncertain 必须人工、不得改判重结论。'

/**
 * Locate the skill file.
 *
 * `import.meta.url` is `lib/index.js` in the published package and `src/skill.ts` in the repo; both
 * have `assets/` one level up.
 *
 * @returns an absolute path
 */
export function skillPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'job-ledger', 'SKILL.md')
}

/**
 * Read the skill body, dropping the frontmatter the registry already has as fields.
 *
 * @returns the instruction text, or undefined when the file is missing
 */
export function loadSkillBody(): string | undefined {
  try {
    const raw = readFileSync(skillPath(), 'utf8')
    const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
    return withoutFrontmatter.trim()
  } catch {
    return undefined
  }
}

/**
 * Build the registration record.
 *
 * @param content instruction text @returns the skill registration
 */
export function skillRegistration(content: string): SkillRegistration {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content,
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** The slice of the host skill registry this module uses. */
export interface SkillRegistry {
  register(skill: SkillRegistration): () => void
}

/**
 * Register the skill when the host has a skill registry.
 *
 * The registry is read with `ctx.get` rather than `ctx.skills`: cordis rejects property access to a
 * service that is not in `inject`, which would fail the whole plugin on a headless host. `get`
 * answers "is it there?" without making it a requirement.
 *
 * @param ctx host context @param content body to register @returns the disposer, or undefined
 */
export function registerSkill(ctx: Context, content: string): (() => void) | undefined {
  const skills = ctx.get('skills') as SkillRegistry | undefined
  if (skills === undefined) return undefined
  return skills.register(skillRegistration(content))
}
