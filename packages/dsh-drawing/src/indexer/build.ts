/**
 * Build (or reuse) the index of one drawing set.
 *
 * The pipeline is deterministic and cheap — 353 pages in about a second and a
 * half — but it is still cached by `sha256 + PARSER_VERSION`, because the point
 * of the index is that later queries never touch the PDF again.
 *
 * Two passes over the placed runs: the first learns which sheet numbers exist,
 * the second parses cross references against that set (a bare `13-14` is a
 * contact designation, not a reference, and only the sheet set can tell them
 * apart).
 *
 * @module dsh-drawing/indexer/build
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { readDocument, type PageText } from './pdf.js'
import {
  classify,
  classifyEntity,
  groupCabinets,
  isOddPage,
  parseXrefs,
  readTitleBlock,
  type Cabinet,
  type EntityKind,
  type Run,
  type Template,
} from './rules.js'
import {
  PARSER_VERSION,
  documentDir,
  documentDirName,
  readJson,
  sha256File,
  writeJson,
  type BuildStamp,
} from './store.js'

/** One sheet row of `index/sheets.json`. */
export type Sheet = {
  cabinet: number
  sheet: number | null
  page: number
  title: string | null
  template: Template
  loc: string | null
  prev: number | null
  next: number | null
  /**
   * Display size of the page in points, `/Rotate` applied. Stored because every
   * coordinate the plugin reports is in this frame: a consumer that wants to
   * place a box needs to know it (most sheets are 842x595, the 24 portrait
   * connector sheets are 595x842).
   */
  frame: { width: number; height: number }
}

/** One cross reference, resolved against the sheet inventory when possible. */
export type Xref = {
  page: number
  sheet: number | null
  raw: string
  target: number
  column: number
  side: string | null
  targetPage: number | null
  targetCabinet: number | null
  x: number | null
  y: number | null
}

/** Where a named element appears. */
export type Occurrence = {
  page: number
  sheet: number | null
  x: number
  y: number
  w: number
  h: number
  role: EntityKind
}

/** `index/names.json`: every tracked element and where it is drawn. */
export type NameIndex = Record<string, { kind: EntityKind; occurrences: Occurrence[] }>

/** The drawing's identity card (`profile.json`), also the model's map of it. */
export type Profile = {
  document: string
  sha256: string
  pages: number
  parsedAt: string
  parserVersion: number
  vendor: string | null
  project: {
    name: string | null
    number: string | null
    revision: string | null
    date: string | null
  }
  cabinets: Cabinet[]
  templates: Record<string, number>
  numbering: Record<string, string>
  indexes: string[]
  quality: Record<string, number>
  caveats: string[]
}

/** The full index of one drawing set. */
export type Index = {
  profile: Profile
  sheets: Sheet[]
  xrefs: Xref[]
  names: NameIndex
}

/** Outcome of `openDrawing()`. */
export type OpenResult = {
  index: Index
  cached: boolean
  millis: number
}

/** Numbering families of this drawing system, as printed in the set. */
const NUMBERING: Record<string, string> = {
  '1-2': '封面 / 修订记录',
  '3-7': '目录（SUMMARY，与纸面可能不一致）',
  '80-90': '机台接地 / 连接器标记示例',
  '100-199': '电源、配电、变压器、安全供电',
  '200-299': 'PLC 机架配置与按通道类型的原理图页',
  '300-499': 'IO-Link 主站模块 / 无源模块',
  '500-599': '柜体布置图（AG / IHM / BB）',
  '600-699': '系统图',
  '800-899': '柜体布置图（BASE 腔）',
  '900-999': '系统图（BASE 腔）',
  '1100-1199': '盖板（LID）电源',
  '1200-1299': '盖板 PLC 通道',
  '1400-1499': '盖板 IO-Link 模块',
  '1800-1899': '盖板布置图',
  '1900-1999': '盖板系统图',
  '3000-3099': '电缆详图',
  '4000-4099': '端子排页 / 连接器针脚页',
}

/** Open (building when needed) the index of `pdfPath` into `drawingDir`. */
export async function openDrawing(
  drawingDir: string,
  pdfPath: string,
  options: { force?: boolean } = {},
): Promise<OpenResult> {
  const started = Date.now()
  const dir = documentDir(drawingDir, pdfPath)
  const sha256 = await sha256File(pdfPath)
  const stamp = await readJson<BuildStamp>(join(dir, 'build.json'))

  if (
    options.force !== true &&
    stamp !== undefined &&
    stamp.sha256 === sha256 &&
    stamp.parserVersion === PARSER_VERSION
  ) {
    const index = await loadIndex(dir)
    if (index !== undefined) return { index, cached: true, millis: Date.now() - started }
  }

  const bytes = await readFile(pdfPath)
  const document = await readDocument(bytes)
  const index = buildIndex(basename(pdfPath), sha256, document.pages)
  const millis = Date.now() - started

  await writeJson(join(dir, 'index', 'sheets.json'), index.sheets)
  await writeJson(join(dir, 'index', 'xrefs.json'), index.xrefs)
  await writeJson(join(dir, 'index', 'names.json'), index.names)
  await writeJson(join(dir, 'profile.json'), index.profile, true)

  const checks: Record<string, string | number | boolean> = {
    inkGate: 'pending', // needs rasterisation; see docs (P1 keeps a box sanity check instead)
    boxesInsidePage: index.profile.quality.boxesInsidePage ?? 0,
    pagesWithoutSheet: index.profile.quality.pagesWithoutSheet ?? 0,
  }
  const stampOut: BuildStamp = {
    document: basename(pdfPath),
    sha256,
    parserVersion: PARSER_VERSION,
    pages: document.pageCount,
    builtAt: new Date().toISOString(),
    millis,
    checks,
  }
  await writeJson(join(dir, 'build.json'), stampOut, true)

  return { index, cached: false, millis }
}

/** Read a previously built index, or undefined when it is incomplete. */
export async function loadIndex(dir: string): Promise<Index | undefined> {
  const profile = await readJson<Profile>(join(dir, 'profile.json'))
  const sheets = await readJson<Sheet[]>(join(dir, 'index', 'sheets.json'))
  if (profile === undefined || sheets === undefined) return undefined
  const xrefs = (await readJson<Xref[]>(join(dir, 'index', 'xrefs.json'))) ?? []
  const names = (await readJson<NameIndex>(join(dir, 'index', 'names.json'))) ?? {}
  return { profile, sheets, xrefs, names }
}

/** Pure build: placed pages in, index out. */
export function buildIndex(document: string, sha256: string, pages: PageText[]): Index {
  // ---- pass 1: sheets -----------------------------------------------------
  const sheets: Sheet[] = []
  let outOfPage = 0
  let runCount = 0
  for (const page of pages) {
    const block = readTitleBlock(page.runs, { portrait: isOddPage(page.geometry) })
    const template = classify(block.title)
    runCount += page.runs.length
    for (const run of page.runs) {
      if (run.x < -1 || run.y < -1 || run.x + run.w > page.geometry.width + 1 || run.y + run.h > page.geometry.height + 1) {
        outOfPage += 1
      }
    }
    sheets.push({
      cabinet: 0,
      sheet: block.sheet,
      page: page.page,
      title: block.title,
      template,
      loc: block.loc,
      prev: block.prev,
      next: block.next,
      frame: { width: page.geometry.width, height: page.geometry.height },
    })
  }

  const cabinets = groupCabinets(sheets)
  for (const sheet of sheets) {
    const owner = cabinets.find((cabinet) => sheet.page >= cabinet.pages[0] && sheet.page <= cabinet.pages[1])
    sheet.cabinet = owner?.id ?? 1
  }

  const sheetNumbers = new Set<number>()
  for (const sheet of sheets) if (sheet.sheet !== null) sheetNumbers.add(sheet.sheet)

  // ---- pass 2: cross references and named elements -------------------------
  const xrefs: Xref[] = []
  const names: NameIndex = {}
  const xrefSeen = new Set<string>()
  const nameSeen = new Set<string>()
  let resolved = 0
  let boxless = 0

  const pageIndex = new Map(pages.map((page) => [page.page, page]))
  for (const sheet of sheets) {
    const page = pageIndex.get(sheet.page)
    if (page === undefined) continue
    const odd = isOddPage(page.geometry)

    for (const run of page.runs) {
      if (!odd) {
        for (const parsed of parseXrefs(run.text, (n) => sheetNumbers.has(n))) {
          const bucket = `${sheet.page}|${parsed.target}|${parsed.column}|${parsed.side ?? ''}|${Math.round(run.x / 3)}|${Math.round(run.y / 3)}`
          if (xrefSeen.has(bucket)) continue
          xrefSeen.add(bucket)
          xrefs.push({
            page: sheet.page,
            sheet: sheet.sheet,
            raw: parsed.raw,
            target: parsed.target,
            column: parsed.column,
            side: parsed.side,
            targetPage: null,
            targetCabinet: null,
            x: run.x,
            y: run.y,
          })
        }
      }

      const kind = classifyEntity(run.text)
      if (kind === null) continue
      const key = `${run.text}|${sheet.page}|${Math.round(run.x)}|${Math.round(run.y)}`
      if (nameSeen.has(key)) continue
      nameSeen.add(key)
      const entry = (names[run.text] ??= { kind, occurrences: [] })
      entry.occurrences.push({
        page: sheet.page,
        sheet: sheet.sheet,
        x: run.x,
        y: run.y,
        w: run.w,
        h: run.h,
        role: kind,
      })
    }
  }

  // Resolve references: prefer the same cabinet, accept a unique other cabinet.
  const bySheet = new Map<number, Sheet[]>()
  for (const sheet of sheets) {
    if (sheet.sheet === null) continue
    const list = bySheet.get(sheet.sheet) ?? []
    list.push(sheet)
    bySheet.set(sheet.sheet, list)
  }
  for (const xref of xrefs) {
    const candidates = bySheet.get(xref.target) ?? []
    const same = candidates.find((candidate) => candidate.cabinet === sheetOf(sheets, xref.page)?.cabinet)
    const chosen = same ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (chosen === undefined) {
      boxless += 1
      continue
    }
    xref.targetPage = chosen.page
    xref.targetCabinet = chosen.cabinet
    resolved += 1
  }

  // ---- profile ------------------------------------------------------------
  const templates: Record<string, number> = {}
  for (const sheet of sheets) templates[sheet.template] = (templates[sheet.template] ?? 0) + 1

  const repeated = mostRepeated(pages)
  const caveats = buildCaveats(sheets, sheetNumbers, pages, xrefs.length, resolved)

  const profile: Profile = {
    document,
    sha256,
    pages: pages.length,
    parsedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    vendor: repeated.vendor,
    project: {
      name: repeated.project,
      number: repeated.number,
      revision: repeated.revision,
      date: repeated.date,
    },
    cabinets,
    templates,
    numbering: NUMBERING,
    indexes: ['sheets', 'xrefs', 'names'],
    quality: {
      runs: runCount,
      boxesInsidePage: runCount === 0 ? 0 : Math.round(((runCount - outOfPage) / runCount) * 1000) / 1000,
      pagesWithoutSheet: sheets.filter((sheet) => sheet.sheet === null).length,
      oddOrientationPages: pages.filter((page) => isOddPage(page.geometry)).length,
      xrefs: xrefs.length,
      xrefsResolved: resolved,
      unresolvedXrefs: boxless,
      entities: Object.keys(names).length,
    },
    caveats,
  }

  return { profile, sheets, xrefs, names }
}

function sheetOf(sheets: readonly Sheet[], page: number): Sheet | undefined {
  return sheets.find((sheet) => sheet.page === page)
}

/** Values the title block repeats on (nearly) every page. */
function mostRepeated(pages: readonly PageText[]): {
  vendor: string | null
  project: string | null
  number: string | null
  revision: string | null
  date: string | null
} {
  const projectPages = new Map<string, number>()
  const numberCounts = new Map<string, number>()
  const revisionCounts = new Map<string, number>()
  const dateCounts = new Map<string, number>()
  let sawSee = false
  let version: string | null = null

  for (const page of pages) {
    const seenOnPage = new Set<string>()
    for (const run of page.runs) {
      const text = run.text.trim()
      if (text === 'SEE') sawSee = true
      if (version === null && /^\d\.\d{2}$/.test(text) && run.size >= 5 && run.size <= 6) version = text
      if (text.length > 12 && text.length < 70 && /^[A-Z0-9 .'\-/&()]+$/.test(text) && !seenOnPage.has(text)) {
        seenOnPage.add(text)
        // Count SHEETS a string appears on, not occurrences: a table header that
        // repeats inside every cable block would otherwise outrank the project
        // title printed once per sheet.
        projectPages.set(text, (projectPages.get(text) ?? 0) + 1)
      }
      if (/^\d{5}-\d{5}-[A-Z]{2,4}$/.test(text)) numberCounts.set(text, (numberCounts.get(text) ?? 0) + 1)
      if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(text)) dateCounts.set(text, (dateCounts.get(text) ?? 0) + 1)
      if (/^[A-D]$/.test(text) && run.size >= 6.5 && run.size <= 9 && run.x < 40) {
        revisionCounts.set(text, (revisionCounts.get(text) ?? 0) + 1)
      }
    }
  }

  const top = (counts: Map<string, number>): string | null =>
    [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null

  // The project title is printed identically on every sheet: require it on at
  // least half the pages, then prefer the longest such string.
  const threshold = Math.max(1, Math.ceil(pages.length * 0.5))
  const project =
    [...projectPages.entries()]
      .filter(([, count]) => count >= threshold)
      .sort((left, right) => right[0].length - left[0].length || right[1] - left[1])[0]?.[0] ?? null
  return {
    vendor: sawSee ? `SEE Electrical${version === null ? '' : ` ${version}`}` : null,
    project,
    number: top(numberCounts),
    revision: top(revisionCounts),
    date: top(dateCounts),
  }
}

/**
 * Caveats the next reader (a model or a human) must not rediscover.
 *
 * The SUMMARY check is the important one: this drawing set's table of contents
 * lists terminal/cable/part-list sheets that the printed pages do not contain,
 * so a reader who trusts it looks in the wrong place. Reproducing that finding
 * automatically is what keeps the caveat honest for the *next* drawing too.
 */
function buildCaveats(
  sheets: readonly Sheet[],
  sheetNumbers: ReadonlySet<number>,
  pages: readonly PageText[],
  xrefCount: number,
  resolved: number,
): string[] {
  const caveats: string[] = []

  const summaryPages = new Set(sheets.filter((sheet) => sheet.template === 'summary').map((sheet) => sheet.page))
  const claimed = new Set<number>()
  for (const page of pages) {
    if (!summaryPages.has(page.page)) continue
    for (const run of page.runs) {
      const text = run.text.trim()
      // Inside the drawing area only: the frame's own column ruler (1..39) and
      // the title block also print bare numbers on these pages.
      if (run.y < 30 || run.y > 560 || run.x < 30 || run.x > 820) continue
      if (!/^\d{1,4}$/.test(text)) continue
      const number = Number(text)
      if (number >= 50) claimed.add(number)
    }
  }
  const missing = [...claimed].filter((number) => number >= 10 && !sheetNumbers.has(number)).sort((a, b) => a - b)
  if (missing.length > 0) {
    const sample = missing.slice(0, 6).join(', ')
    caveats.push(
      `目录（SUMMARY）列出 ${missing.length} 个纸面上不存在的图号（如 ${sample}），不要用目录作索引，按图框现场生成`,
    )
  }

  if (xrefCount > 0 && resolved < xrefCount) {
    caveats.push(`${xrefCount - resolved} 条交叉引用无法唯一解析（跨柜同号或缺页），跳转前需按柜名消歧`)
  }
  const duplicates = countDuplicates(sheets)
  if (duplicates.length > 0) {
    caveats.push(`图号跨柜重复（${duplicates.slice(0, 5).join(', ')} 等），主键必须是 (cabinet, sheet)`)
  }
  if (sheetNumbers.size === 0) caveats.push('未识别出任何图号，图框解析可能不适用于该文档')
  return caveats
}

function countDuplicates(sheets: readonly Sheet[]): number[] {
  const seen = new Map<number, Set<number>>()
  for (const sheet of sheets) {
    if (sheet.sheet === null) continue
    const cabinets = seen.get(sheet.sheet) ?? new Set<number>()
    cabinets.add(sheet.cabinet)
    seen.set(sheet.sheet, cabinets)
  }
  return [...seen.entries()].filter(([, cabinets]) => cabinets.size > 1).map(([number]) => number).sort((a, b) => a - b)
}

/** True when the directory already holds a finished build. */
export async function hasIndex(dir: string): Promise<boolean> {
  return existsSync(join(dir, 'build.json')) && existsSync(join(dir, 'profile.json'))
}

export { documentDir, documentDirName }



