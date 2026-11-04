/**
 * A minimal ZIP reader/writer, enough for the two things the tracker sheet needs.
 *
 * `.xlsx` is a ZIP of XML parts, and Node ships `zlib` but no ZIP. Rather than add a runtime
 * dependency (AGENTS.md: host side stays dependency-free), this file implements the stored and
 * deflated cases of the format: read every entry, and write a new archive replacing a few of them.
 * No encryption, no ZIP64, no multi-disk — none of which an Excel sheet uses.
 *
 * @module dsh-job-ledger/tracker/zip
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** One entry of an archive. */
export interface ZipEntry {
  readonly name: string
  readonly data: Buffer
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const EOCD = 0x06054b50

/** CRC-32 table, built once (the polynomial from the ZIP specification). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

/**
 * @param data bytes @returns the CRC-32 of the data
 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Find the end-of-central-directory record, scanning back over a possible comment. */
function findEnd(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset
  }
  throw new Error('not a zip archive: end of central directory not found')
}

/**
 * Read every entry of a ZIP archive.
 *
 * @param buffer archive bytes
 * @returns entries in central-directory order
 * @throws Error when the archive is malformed or uses an unsupported method
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  const end = findEnd(buffer)
  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error('corrupt central directory')
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`corrupt local header for ${name}`)
    const localName = buffer.readUInt16LE(localOffset + 26)
    const localExtra = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined
    if (data === undefined) throw new Error(`unsupported compression method ${String(method)} for ${name}`)
    if (crc32(data) !== crc) throw new Error(`checksum mismatch for ${name}`)

    entries.push({ name, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * Write a ZIP archive, deflating entries whose compressed form is smaller.
 *
 * @param entries what to write, in order
 * @returns archive bytes
 */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // Fixed timestamp (1980-01-01 00:00), so the same content produces the same bytes.
  const dosTime = 0
  const dosDate = 0x0021

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const deflated = deflateRawSync(entry.data)
    const stored = deflated.length >= entry.data.length
    const body = stored ? entry.data : deflated
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(dosTime, 12)
    header.writeUInt16LE(dosDate, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)

    locals.push(local, name, Buffer.from(body))
    central.push(header, name)
    offset += 30 + name.length + body.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...central, end])
}
