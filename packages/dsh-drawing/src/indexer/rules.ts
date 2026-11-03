/**
 * Pure SEE-Electrical rules: placement math and the drawing conventions.
 *
 * Everything here is a function of the page's text runs — no PDF library, no
 * filesystem — so the test suite can drive it with fixtures and the extractor
 * stays auditable.
 *
 * The conventions were read off the real drawing set (353 pages) and are
 * documented in `docs/research/electrical-drawings-see-swt2-pei.md`:
 *
 *   - the print job draws every sheet rotated (+90 deg on most pages, +180 on
 *     the portrait connector sheets) and relies on the page's `/Rotate` to
 *     display it upright, so raw text matrices are meaningless for layout work;
 *   - the title block carries the sheet number next to the literal `SHEET`, the
 *     sheet title as the widest 8 pt run in the block, `LOCALISATION :` and a
 *     printed prev/next pair;
 *   - cross references are `(sheet-column)` or `side(sheet-column)`;
 *   - a reference's leading 3 digits are the sheet it lives on, which is a
 *     useful prior (verified on 97% of device tags).
 *
 * @module dsh-drawing/indexer/rules
 */

/** One text run placed in the display frame (842x595 on A4 landscape sheets). */
export type Run = {
  text: string
  /** Display-frame box, origin top-left. */
  x: number
  y: number
  w: number
  h: number
  /** Nominal text height in points. */
  size: number
  /** Baseline direction in degrees, in the display frame (0 = horizontal). */
  angle: number
}

/** A pdf.js text item, as much of it as placement needs. */
export type RawTextItem = {
  str: string
  width: number
  height: number
  transform: [number, number, number, number, number, number]
}

/** Page geometry after `/Rotate` is applied. */
export type PageGeometry = {
  /** Display width/height in points (rotation applied). */
  width: number
  height: number
  /** `/Rotate` value. */
  rotation: number
}

const EPS = 1e-6

/**
 * Place one text run in the display frame.
 *
 * The text matrix puts the run's baseline start at `(e, f)` in the page's
 * **unrotated** space, advancing along `(a, b)` for `width` points, with the
 * glyph box extending `height` points along `(c, d)`. Rotating by the page's
 * `/Rotate` then maps that box into the displayed page:
 *
 *   - `90`:  display x = unrotated y, display y = unrotated x  (verified: the
 *            transform of `MICHELIN` and PDFium's char box agree to the digit);
 *   - `0`:   display x = x, display y = H - y;
 *   - `180`: transpose-like fallback; the portrait connector sheets never
 *            validated, so callers treat them as box-less (see `isOddPage`).
 */
export function placeItem(item: RawTextItem, geometry: PageGeometry): Run {
  const [a, b, c, d, e, f] = item.transform
  const uLen = Math.hypot(a, b) || 1
  const vLen = Math.hypot(c, d) || 1
  const ux = a / uLen
  const uy = b / uLen
  const vx = c / vLen
  const vy = d / vLen
  const w = Math.max(item.width, 0)
  const h = Math.max(item.height, 0)

  // Four corners of the run's box, in unrotated page space.
  const xs: number[] = []
  const ys: number[] = []
  for (const [along, up] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const) {
    xs.push(e + ux * along + vx * up)
    ys.push(f + uy * along + vy * up)
  }
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)

  let box: { x: number; y: number; w: number; h: number }
  if (geometry.rotation === 90) {
    box = { x: y0, y: x0, w: y1 - y0, h: x1 - x0 }
  } else if (geometry.rotation === 270) {
    box = { x: geometry.height - y1, y: x0, w: y1 - y0, h: x1 - x0 }
  } else if (geometry.rotation === 180) {
    box = { x: geometry.width - x1, y: geometry.height - y1, w: x1 - x0, h: y1 - y0 }
  } else {
    box = { x: x0, y: geometry.height - y1, w: x1 - x0, h: y1 - y0 }
  }

  return {
    text: item.str,
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(box.h),
    size: round(item.height),
    angle: round((Math.atan2(uy, ux) * 180) / Math.PI),
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** Pages whose geometry never validated (the portrait connector sheets). */
export function isOddPage(geometry: PageGeometry): boolean {
  return geometry.rotation === 180
}

/** The title-block values this drawing set prints on every sheet. */
export type TitleBlock = {
  sheet: number | null
  title: string | null
  loc: string | null
  prev: number | null
  next: number | null
}

/** Labels printed in the title-block band that are never the sheet title. */
const TITLE_BLOCK_LABELS = new Set([
  'MAIN CABINET',
  'MICHELIN',
  'SEE',
  'WA+10',
  'D3',
  'Code',
  'REV.',
  'Conservation',
  'DTM CLASS',
  'DTE CLASS',
  'Version SEE',
  'SHEET',
  'The :',
  'By :',
])

/**
 * Words that open a drawing's own title. The block prints more than one text
 * line (a job/cavity name above the drawing name), so "the widest run" alone
 * picks the wrong one; these are the sheet-type words this drawing system uses
 * and they outrank width.
 */
const TITLE_TYPE_WORDS = [
  'SUMMARY',
  'REVISIONS',
  'MAIN PAGE',
  'SYNOPTIC',
  'LAYOUT',
  'CONNECTOR',
  'TERMINAL',
  'CABLE',
  'POWER SUPPLY',
  'TRANSFO',
  '24V DISTRIBUTION',
  'MACHINE GROUND',
  'MARKING',
  'IO-LINK',
  'PASSIVE MODULE',
]

/** Printed length of a run, tolerant of vertical (rotated) text. */
function runLength(run: Run): number {
  return Math.max(run.w, run.h)
}

/** Pick the sheet title out of a candidate list. */
function pickTitle(candidates: readonly Run[]): string | null {
  const usable = candidates.filter((run) => {
    const text = run.text.trim()
    return text !== '' && !/^\d+$/.test(text) && !TITLE_BLOCK_LABELS.has(text)
  })
  if (usable.length === 0) return null
  const typed = usable.filter((run) =>
    TITLE_TYPE_WORDS.some((word) => run.text.trim().toUpperCase().startsWith(word)),
  )
  const pool = typed.length > 0 ? typed : usable
  return [...pool].sort((left, right) => runLength(right) - runLength(left))[0]?.text.trim() ?? null
}

/** Read the title block. */
export function readTitleBlock(runs: readonly Run[], options: { portrait?: boolean } = {}): TitleBlock {
  const label = runs.find((run) => run.text.trim() === 'SHEET')

  let sheet: number | null = null
  if (label !== undefined) {
    // Proximity to the literal `SHEET`, not an absolute position: 24 sheets in
    // this set are portrait and their title block is drawn at 90 deg to the
    // landscape frame, so a fixed band would miss them. The number is printed
    // roughly one line above the label at ~2x its type size.
    const candidates = runs
      .filter((run) => /^\d{1,4}$/.test(run.text.trim()) && run.size >= Math.max(7, label.size * 1.5))
      .map((run) => ({
        run,
        distance: Math.hypot(run.x - label.x, run.y - label.y),
      }))
      .filter((entry) => entry.distance < 40)
      .sort((left, right) => left.distance - right.distance)
    const first = candidates[0]
    if (first !== undefined) sheet = Number(first.run.text.trim())
  }

  // `LOCALISATION : AG` may arrive as one run (PDFium) or as three
  // ('LOCALISATION', ':', 'AG', pdf.js), so the value is read inline first and
  // off the label's own line second.
  let loc: string | null = null
  const locLabel = runs.find((run) => run.text.trim().startsWith('LOCALISATION'))
  if (locLabel !== undefined) {
    const inline = locLabel.text.slice(locLabel.text.indexOf(':') + 1).trim()
    if (locLabel.text.includes(':') && inline !== '') {
      loc = inline
    } else {
      const following = runs
        .filter(
          (run) =>
            run !== locLabel &&
            Math.abs(run.y - locLabel.y) <= 4 &&
            run.x > locLabel.x + locLabel.w - 2 &&
            run.text.trim() !== ':' &&
            run.text.trim() !== '',
        )
        .sort((left, right) => left.x - right.x)
      const parts: string[] = []
      let cursor = locLabel.x + locLabel.w
      for (const run of following) {
        if (run.x - cursor > 14) break
        parts.push(run.text.trim())
        cursor = run.x + run.w
        if (parts.length >= 3) break
      }
      const value = parts.join(' ').trim()
      if (value !== '') loc = value
    }
  }

  const titleCandidates = runs.filter((run) => run.size >= 6.4 && run.size <= 9.6 && run.text.trim() !== '')
  const inBand = titleCandidates.filter(
    (run) => run.y >= 500 && run.y <= 548 && run.x >= 420 && run.x <= 772,
  )
  // Portrait sheets draw the block at 90 deg to the frame, so the band rule
  // cannot apply: fall back to the type vocabulary across the whole page.
  const nearLabel =
    label === undefined
      ? []
      : titleCandidates.filter((run) => Math.hypot(run.x - label.x, run.y - label.y) < 260)
  const title =
    pickTitle(inBand) ?? pickTitle(options.portrait === true ? titleCandidates : nearLabel)

  // A cover sheet has no sheet number by construction — whatever numeral the
  // proximity rule found near the label belongs to another field.
  if (title === 'MAIN PAGE') sheet = null

  const navRuns = runs
    .filter(
      (run) =>
        run.y >= 548 &&
        run.y <= 568 &&
        run.x >= 752 &&
        run.x <= 822 &&
        /^\d{2,4}$/.test(run.text.trim()),
    )
    .sort((left, right) => left.x - right.x)

  return {
    sheet,
    title,
    loc,
    prev: navRuns.length >= 2 ? Number(navRuns[0]?.text) : null,
    next: navRuns.length >= 2 ? Number(navRuns[navRuns.length - 1]?.text) : null,
  }
}

/** One cross reference as printed on a sheet. */
export type ParsedXref = {
  raw: string
  target: number
  column: number
  side: string | null
}

const XREF_PAREN = /\((\d{3,4})-(\d{1,2})\)/g
const XREF_SIDE = /([A-D])\((\d{3,4})-(\d{1,2})\)/g
const XREF_BARE = /(?<![\w(])(\d{3,4})-(\d{1,2})(?![\w-])/g

/**
 * Extract cross references from one run's text.
 *
 * `existing` is the set of sheet numbers printed in the whole document: a bare
 * `13-14` is a contact designation, not a reference, and only survives when
 * `13` is a real sheet number. The caller passes it so this stays pure.
 */
export function parseXrefs(text: string, isSheet: (n: number) => boolean): ParsedXref[] {
  const found: ParsedXref[] = []
  const push = (raw: string, target: string | undefined, column: string | undefined, side: string | null) => {
    if (target === undefined || column === undefined) return
    const sheet = Number(target)
    const col = Number(column)
    if (!isSheet(sheet) || col < 1 || col > 39) return
    found.push({ raw, target: sheet, column: col, side })
  }

  for (const match of text.matchAll(XREF_SIDE)) {
    push(match[0], match[2], match[3], match[1] ?? null)
  }
  for (const match of text.matchAll(XREF_PAREN)) {
    // Skip the inner part of a side-prefixed reference already recorded above.
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 1), match.index ?? 0)
    const side = /[A-D]/.test(prefix) ? prefix : null
    if (side !== null && found.some((entry) => entry.raw === `${side}${match[0]}`)) continue
    push(match[0], match[1], match[2], side)
  }
  for (const match of text.matchAll(XREF_BARE)) {
    push(match[0], match[1], match[2], null)
  }
  return found
}

/** What kind of drawing a sheet is, from its title. */
export type Template =
  | 'main'
  | 'revision'
  | 'summary'
  | 'ground'
  | 'marking'
  | 'layout'
  | 'synoptic'
  | 'terminal'
  | 'connector'
  | 'cable'
  | 'power'
  | 'schematic'

/** Classify a sheet by its printed title. */
export function classify(title: string | null): Template {
  const text = (title ?? '').toUpperCase()
  if (text === 'MAIN PAGE') return 'main'
  if (text === 'REVISIONS') return 'revision'
  if (text === 'SUMMARY') return 'summary'
  if (text.includes('MACHINE GROUND')) return 'ground'
  if (text.includes('MARKING')) return 'marking'
  if (text.startsWith('LAYOUT')) return 'layout'
  if (text.startsWith('SYNOPTIC')) return 'synoptic'
  if (text.includes('TERMINAL')) return 'terminal'
  if (text.includes('CONNECTOR')) return 'connector'
  if (text.startsWith('CABLE')) return 'cable'
  if (/POWER SUPPLY|TRANSFO|24V DISTRIBUTION|^PLC$/.test(text)) return 'power'
  return 'schematic'
}

/** The entity kinds the index tracks. */
export type EntityKind = 'tag' | 'wire' | 'cable' | 'address' | 'terminal'

const ADDRESS = /%[IQCDM]+\d+\.\d+/
const CABLE = /^W[T]?\d{2,4}$/
const WIRE = /^\d{3}\.[A-Z0-9]{1,4}$/
const TAG = /^\d{3}[A-Z]{1,2}\d{1,2}$/
const TERMINAL = /^X\d+[A-Z0-9.]*$/

/** Classify one run as an entity, if it is one. */
export function classifyEntity(text: string): EntityKind | null {
  const value = text.trim()
  if (value === '') return null
  if (ADDRESS.test(value)) return 'address'
  if (CABLE.test(value)) return 'cable'
  if (WIRE.test(value)) return 'wire'
  if (TAG.test(value)) return 'tag'
  if (TERMINAL.test(value)) return 'terminal'
  return null
}

/** The three-digit sheet prefix of a reference, when it has one. */
export function sheetPrefix(name: string): number | null {
  const match = /^(\d{3})/.exec(name)
  return match === null ? null : Number(match[1])
}

/** A block ("cabinet") of sheets, delimited by the MAIN PAGE cover sheets. */
export type Cabinet = {
  id: number
  name: string
  pages: [number, number]
  sheets: number
}

/**
 * Group pages into cabinets.
 *
 * Each print job in the set opens with a MAIN PAGE cover that carries no sheet
 * number — that is the only reliable delimiter, so the grouping is derived
 * rather than guessed from page ranges.
 */
export function groupCabinets(
  pages: Array<{ page: number; sheet: number | null; loc: string | null | undefined }>,
): Cabinet[] {
  const starts: number[] = []
  for (const entry of pages) if (entry.sheet === null) starts.push(entry.page)
  if (starts.length === 0) starts.push(pages[0]?.page ?? 1)

  const cabinets: Cabinet[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    if (from === undefined) continue
    const to = (starts[index + 1] ?? (pages[pages.length - 1]?.page ?? from) + 1) - 1
    const members = pages.filter((entry) => entry.page >= from && entry.page <= to)
    const counts = new Map<string, number>()
    for (const entry of members) {
      const loc = (entry.loc ?? '').trim()
      if (loc === '') continue
      counts.set(loc, (counts.get(loc) ?? 0) + 1)
    }
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1])
    cabinets.push({
      id: index + 1,
      name: ranked[0]?.[0] ?? `cabinet-${index + 1}`,
      pages: [from, to],
      sheets: members.filter((entry) => entry.sheet !== null).length,
    })
  }
  return cabinets
}

/** Tolerance used when deciding two runs share a baseline. */
export const BASELINE_TOLERANCE = 2.5

