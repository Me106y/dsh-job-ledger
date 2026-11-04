/**
 * Build a minimal `.xlsx` in memory for the tracker tests.
 *
 * Not a test file: the runner only picks up `*.test.ts`. The workbook has the parts the reader
 * needs (workbook, rels, one worksheet) plus one unrelated part, so a test can prove the writer
 * copies archives through instead of rebuilding them.
 *
 * @module dsh-job-ledger/test/fixtures/xlsx
 */

import { writeZip } from '../../src/tracker/zip.ts'
import type { ZipEntry } from '../../src/tracker/zip.ts'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** @param column zero-based index @returns spreadsheet column letters */
function letters(column: number): string {
  let name = ''
  let rest = column + 1
  while (rest > 0) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
    rest = Math.floor((rest - 1) / 26)
  }
  return name
}

/** @param text cell text @returns an inline-string cell body (no reference) */
function textCell(text: string): string {
  return `<is><t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is>`
}

/**
 * @param header header cells
 * @param rows data rows
 * @param extra archive entries appended as they are
 * @returns the workbook bytes
 */
export function makeXlsx(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  extra: readonly ZipEntry[] = [],
): Buffer {
  const all = [header, ...rows]
  const body = all
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => `<c r="${letters(column)}${rowIndex + 1}" t="inlineStr">${textCell(value)}</c>`)
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')

  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="A1:${letters(Math.max(header.length - 1, 0))}${all.length}"/><sheetData>${body}</sheetData></worksheet>`
  const workbook = `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
    + 'Target="worksheets/sheet1.xml"/></Relationships>'

  return writeZip([
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
    ...extra,
  ])
}
