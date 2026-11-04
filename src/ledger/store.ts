/**
 * The event store: one file, one writer, append-only, fsync before success (TECH §6.2).
 *
 * The rules this module enforces are the ones that make the ledger worth trusting:
 *
 * - **Single writer.** Only this class holds a file descriptor. `run`, `tools` and `api` write
 *   through it; there is no second `open()` anywhere, so no interleaving is possible.
 * - **Append-only.** Nothing here rewrites or deletes an event. The one exception is deliberate:
 *   a corrupt tail left by a crash is truncated away so the next append starts on a clean line
 *   (TECH §6.3) — a half-written line is not history, it is debris.
 * - **Replay stops at the first unreadable line.** Skipping would splice unrelated bytes together
 *   and produce a state the file never described.
 *
 * Writes are synchronous on purpose. A promise queue would only be needed if writes could
 * interleave, and `writeSync` on a single-threaded runtime cannot be pre-empted mid-write; that
 * buys ordering without adding an await that callers must remember.
 *
 * @module dsh-job-ledger/ledger/store
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { EVENT_VERSION, isEventType } from './events.ts'
import type { EventInput, LedgerEvent } from './events.ts'
import { applyEvent, createProjection } from './project.ts'
import type { Projection } from './project.ts'
import { PluginError } from '../shared/errors.ts'
import type { Profile } from '../shared/profile.ts'

/** Hard cap on one line, so a runaway JD cannot make the log unreadable (TECH §6.2). */
export const MAX_LINE_BYTES = 64 * 1024

/** Default file name inside `dataDir`. */
export const LEDGER_FILE = 'events.jsonl'

/** Outcome of reading an existing log. */
export interface ReplayResult {
  /** State rebuilt from the readable prefix. */
  readonly projection: Projection
  /** Number of events applied. */
  readonly appliedLines: number
  /** Bytes of the readable prefix; the file may be truncated to this offset before appending. */
  readonly validBytes: number
  /** True when the readable prefix does not end with a newline (a crash after the last byte). */
  readonly needsNewline: boolean
  /** 0-based index of the first unreadable line, when the tail was corrupt. */
  readonly truncatedAt?: number
  /** Events skipped because this version does not know their `type`. */
  readonly unknownTypes: number
}

/**
 * Rebuild state from raw log bytes.
 *
 * Kept separate from the file handle so the truncation, version and unknown-type rules can be
 * tested without touching a disk.
 *
 * @param raw file contents (empty buffer for a new ledger)
 * @param base profile from configuration, before any `profile/set` events are applied
 * @returns the rebuilt projection and where the readable prefix ends
 * @throws PluginError `E_LEDGER_VERSION` when the log was written by a newer schema
 */
export function replay(raw: Buffer, base?: Profile): ReplayResult {
  const projection = createProjection(base)
  let validBytes = 0
  let appliedLines = 0
  let unknownTypes = 0
  let truncatedAt: number | undefined

  const text = raw.toString('utf8')
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? ''
    // The split's tail entry never carries a newline, so neither does its byte count.
    const terminator = index === lines.length - 1 ? 0 : 1
    const lineBytes = Buffer.byteLength(rawLine) + terminator
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.trim() === '') {
      // A trailing newline leaves one empty tail; anything else is blank padding.
      if (index === lines.length - 1) break
      validBytes += lineBytes
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      truncatedAt = index
      break
    }
    if (!isEnvelope(parsed)) {
      truncatedAt = index
      break
    }
    if (parsed.v > EVENT_VERSION) {
      throw new PluginError('E_LEDGER_VERSION', { v: String(parsed.v) })
    }
    if (!isEventType(parsed.type)) {
      unknownTypes += 1
      validBytes += lineBytes
      appliedLines += 1
      projection.unknownEvents = unknownTypes
      continue
    }

    const missing = missingField(parsed as Record<string, unknown>, parsed.type)
    if (missing !== undefined) {
      throw new PluginError('E_LEDGER_STATE', {
        what: `line ${String(index + 1)} is a ${parsed.type} event without ${missing}`,
      })
    }

    const event = parsed as LedgerEvent
    try {
      applyEvent(projection, event)
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError('E_LEDGER_STATE', {
        what: `line ${String(index + 1)} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    appliedLines += 1
    validBytes += lineBytes
  }

  const needsNewline = truncatedAt === undefined && raw.length > 0 && raw[raw.length - 1] !== 0x0a

  return {
    projection,
    appliedLines,
    validBytes,
    needsNewline,
    ...(truncatedAt === undefined ? {} : { truncatedAt }),
    unknownTypes,
  }
}

/** Minimal envelope check: without `v`, `at` and `type` a line is not an event. */
function isEnvelope(value: unknown): value is { v: number; at: string; type: string } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { v?: unknown; at?: unknown; type?: unknown }
  return (
    typeof candidate.v === 'number' &&
    typeof candidate.at === 'string' &&
    typeof candidate.type === 'string'
  )
}

/**
 * Fields each event type must carry for replay to mean anything.
 *
 * Replay trusts the writer, but a hand-edited or half-written line is exactly the case the ledger
 * must refuse rather than crash on. Checking the envelope here turns a TypeError deep inside the
 * projection into a coded error naming the line.
 */
const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'profile/set': ['profile'],
  'job/add': ['job'],
  'job/decision': ['jobId', 'decision', 'reason'],
  'job/status': ['jobId', 'status'],
  'app/create': ['app'],
  'app/state': ['appId', 'state'],
  'lease/grant': ['jobId', 'owner', 'expiresAt'],
  'lease/release': ['jobId'],
  'ingest/summary': ['added', 'duplicates', 'filtered', 'invalid'],
  'reconcile/summary': ['matched', 'backfilled', 'discrepancies'],
  'run/start': ['runId', 'ids', 'grantedBy'],
  'run/halt': ['runId', 'reason'],
  'run/end': ['runId', 'summary'],
}

/**
 * @param event parsed event with a known type @returns the first missing required field, if any
 */
function missingField(event: Record<string, unknown>, type: string): string | undefined {
  for (const field of REQUIRED_FIELDS[type] ?? []) {
    if (event[field] === undefined) return field
  }
  return undefined
}

/** What `open` discovered about the existing file. */
export interface OpenReport {
  readonly appliedLines: number
  readonly unknownTypes: number
  /** Set when a corrupt tail was dropped. */
  readonly truncatedAt?: number
}

/**
 * The only object allowed to write the ledger file.
 *
 * Open it once during plugin `apply()` and inject it; do not open a second one.
 */
export class Ledger {
  /** Absolute path of `events.jsonl`. */
  readonly file: string
  /** Current state, always the result of replay + every append. */
  readonly projection: Projection
  /** What opening the file found. */
  readonly report: OpenReport

  #fd: number
  #closed = false

  private constructor(file: string, projection: Projection, fd: number, report: OpenReport) {
    this.file = file
    this.projection = projection
    this.#fd = fd
    this.report = report
  }

  /**
   * Open (or create) a ledger and replay it.
   *
   * A corrupt tail is truncated so the next append starts a clean line; `report.truncatedAt`
   * records that it happened instead of hiding it.
   *
   * @param file path to `events.jsonl`
   * @param base profile from configuration; `profile/set` events are merged on top of it
   * @returns the open ledger
   * @throws PluginError `E_LEDGER_VERSION` for a newer schema, `E_LEDGER_WRITE` on I/O failure
   */
  static open(file: string, base?: Profile): Ledger {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (error) {
      throw new PluginError('E_LEDGER_WRITE', { what: String(error) })
    }

    let raw: Buffer
    try {
      raw = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
    } catch (error) {
      throw new PluginError('E_LEDGER_WRITE', { what: String(error) })
    }

    const result = replay(raw, base)

    let fd: number
    try {
      fd = openSync(file, 'a')
    } catch (error) {
      throw new PluginError('E_LEDGER_WRITE', { what: String(error) })
    }

    // Repairing the tail can fail halfway; without this the descriptor leaks and the caller gets a
    // bare errno instead of a code it can act on.
    try {
      if (result.validBytes < raw.length) {
        ftruncateSync(fd, result.validBytes)
        fsyncSync(fd)
      } else if (result.needsNewline) {
        // The log ends mid-line (crash after the last byte). Start a fresh line so the next event
        // is not concatenated onto the previous one.
        writeSync(fd, '\n')
        fsyncSync(fd)
      }
    } catch (error) {
      closeSync(fd)
      if (error instanceof PluginError) throw error
      throw new PluginError('E_LEDGER_WRITE', { what: String(error) })
    }
    return new Ledger(
      file,
      result.projection,
      fd,
      {
        appliedLines: result.appliedLines,
        unknownTypes: result.unknownTypes,
        ...(result.truncatedAt === undefined ? {} : { truncatedAt: result.truncatedAt }),
      },
    )
  }

  /**
   * Append one event.
   *
   * The projection is updated *before* the write so an illegal event never lands on disk; a write
   * failure then throws and must halt the run (TECH §6.2), which is why the in-memory projection
   * being ahead of the file is not a state anyone observes.
   *
   * @param input event without `v`/`at` (or with an explicit `at` for backfill)
   * @returns the event as written, envelope included
   * @throws PluginError `E_LEDGER_WRITE` when the line is too large or the disk refuses it
   */
  append(input: EventInput): LedgerEvent {
    if (this.#closed) throw new PluginError('E_LEDGER_WRITE', { what: 'ledger is closed' })

    const event = { ...input, v: EVENT_VERSION, at: input.at ?? new Date().toISOString() } as LedgerEvent
    const line = JSON.stringify(event)
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_LINE_BYTES) {
      throw new PluginError('E_LEDGER_WRITE', {
        what: `event line is ${String(bytes)} bytes, over the ${String(MAX_LINE_BYTES)} cap`,
      })
    }

    applyEvent(this.projection, event)

    try {
      const payload = `${line}\n`
      const expected = Buffer.byteLength(payload)
      const written = writeSync(this.#fd, payload)
      // A short write is not a success: the line on disk would be truncated, and fsync would make
      // that truncation durable.
      if (written !== expected) {
        throw new PluginError('E_LEDGER_WRITE', {
          what: `short write: ${String(written)} of ${String(expected)} bytes`,
        })
      }
      fsyncSync(this.#fd)
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError('E_LEDGER_WRITE', { what: String(error) })
    }
    return event
  }

  /** Close the descriptor. Idempotent; a closed ledger refuses appends. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.#fd)
  }
}
