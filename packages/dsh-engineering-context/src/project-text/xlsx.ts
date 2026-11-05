/**
 * Reading and writing the TIA Portal "project texts" XLSX.
 *
 * The workbook is the official translation format: one row per text item, with
 * fixed system columns (`Category`, `ViewPath`, `Internal ID`, `Substitutions`),
 * one source-language column (header ends in `*`), one target-language column,
 * and sixteen `ref="N"` placeholder columns.
 *
 * TIA writes a non-default OOXML flavour (prefixed `x:` elements, relationship
 * ids like `R2f…`, `sheet.xml`); ExcelJS 4.4 cannot read it (measured
 * 2026-11-04). The maintained SheetJS fork handles it.
 *
 * `mergeTextWorkbook` writes a **subset**: header + translated rows only. TIA
 * treats an empty target cell as "clear" (T5), so untouched rows must be absent,
 * not blank; a full export also makes TIA try to update every read-only object
 * (13,637 warnings on the real project). A one-row subset imports cleanly.
 *
 * @module dsh-engineering-context/project-text/xlsx
 */

import { readFile, writeFile } from 'node:fs/promises'

import * as XLSX from '@e965/xlsx'

/** Sheet the translation workflow reads. `System Texts` is deliberately ignored. */
export const USER_TEXTS_SHEET = 'User Texts'

/** The fixed system columns of the TIA project-texts export. */
export const SYSTEM_COLUMNS = {
  category: 'Category',
  viewPath: 'ViewPath',
  internalId: 'Internal ID',
  substitutions: 'Substitutions',
} as const

/** One project-text row, with its sheet row number (1-based, header is row 1). */
export interface ProjectTextRow {
  rowNumber: number
  category: string
  viewPath: string
  internalId: string
  substitutions: string
  source: string
  target: string
}

/** A parsed `User Texts` worksheet. */
export interface ProjectTextWorkbook {
  file: string
  sheetName: string
  header: string[]
  sourceColumn: number
  targetColumn: number
  rows: ProjectTextRow[]
}

/** The result of writing a merged workbook. */
export interface MergeResult {
  outputFile: string
  rows: number
  translated: number
  preserved: number
}

/**
 * Normalize a header for lookup: trim, drop the reference-language `*`, and
 * collapse internal whitespace.
 *
 * @param value - raw header text.
 */
export function normalizeHeader(value: string): string {
  return value.trim().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return String(value)
}

function headerColumns(header: readonly unknown[]): Map<string, number> {
  const columns = new Map<string, number>()
  header.forEach((value, index) => {
    const text = normalizeHeader(cellText(value))
    if (text.length > 0 && !columns.has(text)) columns.set(text, index + 1)
  })
  return columns
}

function requireColumn(columns: Map<string, number>, name: string, language?: string): number {
  const column = columns.get(name)
  if (column === undefined) {
    const available = [...columns.keys()].join(', ')
    throw new Error(
      `The project-texts workbook has no ${language === undefined ? name : `${language} (${name})`} column. Available: ${available}`,
    )
  }
  return column
}

function readRows(worksheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  }) as unknown[][]
}

/**
 * Read the `User Texts` sheet and locate the source/target language columns by
 * their culture headers (the source header carries a trailing `*`).
 *
 * @param file - absolute path of the exported workbook.
 * @param sourceLanguage - e.g. `en-GB`; matched after stripping `*`.
 * @param targetLanguage - e.g. `zh-CN`.
 */
export async function readTextWorkbook(
  file: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<ProjectTextWorkbook> {
  const workbook = XLSX.read(await readFile(file), { type: 'buffer', cellDates: false })
  const worksheet = workbook.Sheets[USER_TEXTS_SHEET]
  if (worksheet === undefined) {
    throw new Error(`The workbook has no "${USER_TEXTS_SHEET}" sheet.`)
  }
  const table = readRows(worksheet)
  const header = (table[0] ?? []).map((value) => cellText(value))
  const columns = headerColumns(header)
  const categoryColumn = requireColumn(columns, SYSTEM_COLUMNS.category)
  const viewPathColumn = requireColumn(columns, SYSTEM_COLUMNS.viewPath)
  const internalIdColumn = requireColumn(columns, SYSTEM_COLUMNS.internalId)
  const substitutionsColumn = requireColumn(columns, SYSTEM_COLUMNS.substitutions)
  const sourceColumn = requireColumn(columns, sourceLanguage)
  const targetColumn = requireColumn(columns, targetLanguage)

  const rows: ProjectTextRow[] = []
  for (let index = 1; index < table.length; index += 1) {
    const row = table[index] ?? []
    rows.push({
      rowNumber: index + 1,
      category: cellText(row[categoryColumn - 1]),
      viewPath: cellText(row[viewPathColumn - 1]),
      internalId: cellText(row[internalIdColumn - 1]),
      substitutions: cellText(row[substitutionsColumn - 1]),
      source: cellText(row[sourceColumn - 1]),
      target: cellText(row[targetColumn - 1]),
    })
  }

  return { file, sheetName: USER_TEXTS_SHEET, header, sourceColumn, targetColumn, rows }
}

/**
 * Write a translation back into a **new** workbook containing only the header
 * and the translated rows.
 *
 * @param sourceFile - the original export; never modified.
 * @param outputFile - the new workbook to write.
 * @param sourceLanguage - source culture header.
 * @param targetLanguage - target culture header.
 * @param translations - sheet row number to new target text.
 */
export async function mergeTextWorkbook(
  sourceFile: string,
  outputFile: string,
  sourceLanguage: string,
  targetLanguage: string,
  translations: ReadonlyMap<number, string>,
): Promise<MergeResult> {
  const workbook = XLSX.read(await readFile(sourceFile), { type: 'buffer', cellDates: false })
  const worksheet = workbook.Sheets[USER_TEXTS_SHEET]
  if (worksheet === undefined) {
    throw new Error(`The workbook has no "${USER_TEXTS_SHEET}" sheet.`)
  }
  const table = readRows(worksheet)
  const header = (table[0] ?? []).map((value) => cellText(value))
  const columns = headerColumns(header)
  // Require both columns even though only the target is written: a file with the
  // wrong source column was not exported for this run.
  requireColumn(columns, sourceLanguage)
  const targetColumn = requireColumn(columns, targetLanguage)

  const rows = Math.max(0, table.length - 1)
  const rowNumbers = [...translations.keys()].sort((left, right) => left - right)
  const output: unknown[][] = [header]
  for (const rowNumber of rowNumbers) {
    const source = table[rowNumber - 1]
    if (source === undefined) {
      throw new Error(`Translation row ${rowNumber} does not exist in ${sourceFile}.`)
    }
    const copy = source.slice()
    copy[targetColumn - 1] = translations.get(rowNumber) ?? ''
    output.push(copy)
  }

  const outputWorkbook = XLSX.utils.book_new()
  const outputSheet = XLSX.utils.aoa_to_sheet(output)
  XLSX.utils.book_append_sheet(outputWorkbook, outputSheet, USER_TEXTS_SHEET)
  const buffer = XLSX.write(outputWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true })
  await writeFile(outputFile, buffer)

  return { outputFile, rows, translated: rowNumbers.length, preserved: rows - rowNumbers.length }
}
