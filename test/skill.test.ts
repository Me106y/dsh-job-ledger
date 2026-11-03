import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_DESCRIPTION,
  SKILL_NAME,
  loadSkillBody,
  registerSkill,
  skillPath,
  skillRegistration,
} from '../src/skill.ts'

test('the skill file ships with the package and is readable from the repo', () => {
  const body = loadSkillBody()
  assert.ok(body !== undefined)
  assert.match(body, /job_ledger_reconcile/)
  assert.match(body, /uncertain/)
  // The frontmatter is registry metadata, not part of the instructions.
  assert.doesNotMatch(body, /^---/)
  assert.match(skillPath(), /assets\/job-ledger\/SKILL\.md$/)
})

test('the registration matches the skill registry contract', () => {
  const registration = skillRegistration('body')
  assert.equal(registration.name, SKILL_NAME)
  assert.equal(registration.description, SKILL_DESCRIPTION)
  assert.equal(registration.content, 'body')
  assert.equal(registration.source, 'runtime')
  assert.deepEqual(registration.invocation, { modelInvocable: true, userInvocable: true })
})

test('registration is skipped when the host has no skill registry', () => {
  const disposer = registerSkill({} as never, 'body')
  assert.equal(disposer, undefined)
})

test('registration hands the skill to the registry and returns its disposer', () => {
  let registered: unknown
  let disposed = false
  const ctx = {
    skills: {
      register(skill: unknown) {
        registered = skill
        return () => {
          disposed = true
        }
      },
    },
  }

  const dispose = registerSkill(ctx as never, 'body')
  assert.ok(registered !== undefined)
  dispose?.()
  assert.equal(disposed, true)
})
