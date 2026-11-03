import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../src/index.ts'
import { Ledger } from '../src/ledger/store.ts'
import { makeApp, makeJob } from './fixtures/helpers.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * A cordis context just real enough: a registry, a logger, and an effect collector.
 *
 * This exercises the real `apply()` — the wiring that unit tests of individual modules cannot see,
 * and the part most likely to break when the harness changes.
 */
interface FakeContext {
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly logger: { info(message: string): void; warn(message: string): void }
  effect(effect: () => () => void): void
}

/** @returns a context plus what was registered and how to tear it down */
function context(): {
  ctx: FakeContext
  registered: ToolDefinition[]
  dispose: () => void
} {
  const registered: ToolDefinition[] = []
  const disposers: (() => void)[] = []
  const ctx: FakeContext = {
    tools: {
      register(definition: ToolDefinition): () => void {
        registered.push(definition)
        return () => undefined
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    effect(effect: () => () => void): void {
      const disposer = effect()
      disposers.push(disposer)
    },
  }
  return {
    ctx,
    registered,
    dispose: () => {
      for (const disposer of disposers) disposer()
    },
  }
}

/** @param suffix directory name @returns a temp data dir removed after the test */
function dataDir(t: { after(fn: () => void): void }, suffix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `job-ledger-plugin-${suffix}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('mounting the plugin registers all ten tools', (t) => {
  const dir = dataDir(t, 'mount')
  const { ctx, registered, dispose } = context()
  t.after(dispose)

  apply(ctx as never, { dataDir: dir })

  assert.deepEqual(
    registered.map((definition) => definition.name).sort(),
    [
      'job_ledger_apply',
      'job_ledger_backfill',
      'job_ledger_discover',
      'job_ledger_login',
      'job_ledger_profile',
      'job_ledger_queue',
      'job_ledger_reconcile',
      'job_ledger_record',
      'job_ledger_report',
      'job_ledger_resume',
    ],
  )
  assert.equal(name, 'job-ledger')
})

test('mounting creates the data directory, an empty ledger, and the weekly snapshot', (t) => {
  const dir = dataDir(t, 'snapshot')
  const { ctx, dispose } = context()
  t.after(dispose)

  apply(ctx as never, { dataDir: dir })

  // Opening the ledger creates the file; it stays empty until the first event.
  assert.equal(existsSync(join(dir, 'events.jsonl')), true)
  assert.equal(statSync(join(dir, 'events.jsonl')).size, 0)
  assert.equal(existsSync(join(dir, 'snapshot.md')), true)
})

test('the queue tool runs end to end through the registered definition', async (t) => {
  const dir = dataDir(t, 'queue')
  const { ctx, registered, dispose } = context()
  t.after(dispose)
  apply(ctx as never, { dataDir: dir })

  const queue = registered.find((definition) => definition.name === 'job_ledger_queue')
  assert.ok(queue !== undefined)
  const result = (await queue.execute({}, {} as never)) as { ok: boolean; total: number }

  assert.equal(result.ok, true)
  assert.equal(result.total, 0)
})

test('the profile tool reports the hard-coded limits, not the config', async (t) => {
  const dir = dataDir(t, 'profile')
  const { ctx, registered, dispose } = context()
  t.after(dispose)
  apply(ctx as never, { dataDir: dir })

  const profile = registered.find((definition) => definition.name === 'job_ledger_profile')
  assert.ok(profile !== undefined)
  const result = (await profile.execute({}, {} as never)) as {
    limits: { runSize: number; daily: number }
    dataDir: string
  }

  assert.deepEqual(result.limits, { runSize: 10, daily: 30 })
  assert.equal(result.dataDir, dir)
})

test('the report tool renders Markdown through the registry', async (t) => {
  const dir = dataDir(t, 'report')
  const { ctx, registered, dispose } = context()
  t.after(dispose)
  apply(ctx as never, { dataDir: dir })

  const report = registered.find((definition) => definition.name === 'job_ledger_report')
  assert.ok(report !== undefined)
  const result = (await report.execute({}, {} as never)) as { ok: boolean; markdown: string }

  assert.equal(result.ok, true)
  assert.match(result.markdown, /## 漏斗/)
})

test('mounting recovers an application interrupted mid-run', (t) => {
  const dir = dataDir(t, 'recover')
  const seed = Ledger.open(join(dir, 'events.jsonl'))
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  seed.append({ type: 'job/add', job, at: '2026-11-03T00:00:00.000Z' })
  seed.append({ type: 'app/create', app: makeApp(job.id, 'applying'), at: '2026-11-03T00:00:00.000Z' })
  seed.close()

  const { ctx, dispose } = context()
  t.after(dispose)
  apply(ctx as never, { dataDir: dir })

  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; state?: string })
  const recovered = lines.find((event) => event.type === 'app/state')

  assert.equal(recovered?.state, 'uncertain')
})
