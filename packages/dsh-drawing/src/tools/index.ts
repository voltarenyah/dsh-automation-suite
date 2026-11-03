/**
 * The five P0 tools.
 *
 * Deliberately few and small: the model chooses better between five verbs than
 * between nine, and each returns a bounded payload (a hit list, one sheet's
 * structured content, one line of confirmation) rather than page text. The
 * page itself is for the human — `drawing_show` only tells the sidebar where
 * to look.
 *
 * @module dsh-drawing/tools
 */

import { join } from 'node:path'
import { defineTool, type ContentBlock, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Logger } from '@deepseek-ai/cordis'

import { openDrawing, type Index, type Occurrence, type Sheet, type Xref } from '../indexer/build.js'
import { renderPage } from '../indexer/render.js'
import { documentDir, ingest } from '../indexer/store.js'
import {
  listDocuments,
  loadDocument,
  scopeOf,
  writeManifest,
  writeView,
  type DocumentEntry,
  type DrawingView,
  type Scope,
  type Settings,
} from '../workspace.js'

/** Everything a tool body needs. */
export interface ToolDependencies {
  settings: Settings
  log: Logger
}

/** Entity kinds the index tracks, plus the two query-only kinds. */
const KINDS = ['any', 'tag', 'wire', 'cable', 'address', 'terminal', 'xref', 'text'] as const

/** One search hit. */
type Hit = {
  document?: string
  cabinet: number
  sheet: number | null
  page: number
  title: string | null
  kind: string
  text: string
  detail?: string
  x?: number
  y?: number
  w?: number
  h?: number
  targetPage?: number | null
  targetSheet?: number | null
  column?: number
}

/** Resolve the document the caller means, or report what exists. */
async function resolveDocument(
  scope: Scope,
  requested: string | undefined,
): Promise<{ entry: DocumentEntry; index: Index } | { error: string; hint?: string[] }> {
  if (requested !== undefined) {
    const loaded = await loadDocument(scope, requested)
    if ('error' in loaded) return loaded
    return loaded
  }
  const documents = await listDocuments(scope)
  if (documents.length === 0) return { error: 'no_drawing', hint: [] }
  if (documents.length > 1) {
    return { error: 'document_required', hint: documents.map((entry) => entry.file) }
  }
  const only = documents[0]
  if (only === undefined) return { error: 'no_drawing' }
  const loaded = await loadDocument(scope, only.file)
  if ('error' in loaded) return loaded
  return loaded
}

/** Cabinet + sheet label for messages. */
function where(sheet: Pick<Sheet, 'cabinet' | 'sheet' | 'title'>): string {
  const number = sheet.sheet === null ? `p?` : `sheet ${sheet.sheet}`
  return `cabinet ${sheet.cabinet} / ${number}${sheet.title === null ? '' : ` · ${sheet.title}`}`
}

/** Build the sheet lookup that every by-sheet tool needs. */
function sheetIndex(index: Index): Map<string, Sheet> {
  const map = new Map<string, Sheet>()
  for (const sheet of index.sheets) {
    if (sheet.sheet !== null) map.set(`${sheet.cabinet}:${sheet.sheet}`, sheet)
    map.set(`page:${sheet.page}`, sheet)
  }
  return map
}

/** Occurrences of every name on one page. */
function occurrencesOnPage(index: Index, page: number): Array<{ name: string; kind: string; occurrence: Occurrence }> {
  const found: Array<{ name: string; kind: string; occurrence: Occurrence }> = []
  for (const [name, entry] of Object.entries(index.names)) {
    for (const occurrence of entry.occurrences) {
      if (occurrence.page === page) found.push({ name, kind: entry.kind, occurrence })
    }
  }
  return found.sort((left, right) => left.occurrence.y - right.occurrence.y || left.occurrence.x - right.occurrence.x)
}

/** Cross references printed on one page. */
function xrefsOnPage(index: Index, page: number): Xref[] {
  return index.xrefs.filter((xref) => xref.page === page)
}

/**
 * Text rendering of a hit list.
 *
 * The model only sees this text — the structured value is for programmatic
 * consumers — so the box has to be printed. Without it, locating an element
 * (`drawing_show`) means re-deriving coordinates from the PDF by hand, which is
 * exactly what the first real test session ended up doing.
 */
function renderHits(document: string, hits: readonly Hit[]): string {
  if (hits.length === 0) return `No match in ${document}.`
  const lines = hits.map((hit) => {
    const place = `cabinet ${hit.cabinet} / sheet ${hit.sheet ?? '—'} (p${hit.page}) · ${hit.kind} ${hit.text}`
    const box =
      typeof hit.x === 'number' && typeof hit.y === 'number'
        ? ` box ${hit.x},${hit.y},${hit.w ?? 0},${hit.h ?? 0}`
        : ''
    const extra =
      hit.targetPage !== null && hit.targetPage !== undefined
        ? ` → p${hit.targetPage}${hit.column === undefined ? '' : ` col ${hit.column}`}`
        : ''
    const detail = hit.detail === undefined ? '' : ` — ${hit.detail}`
    return `- ${place}${box}${extra}${detail}`
  })
  return [
    `${hits.length} match(es) in ${document}.`,
    'box = x,y,w,h in display points (landscape sheets are 842x595, origin top-left, /Rotate already applied) —',
    'pass the box straight to drawing_show to mark it on screen.',
    ...lines,
  ].join('\n')
}

/** Register all five tools; returns the disposers. */
export function registerTools(
  register: (definition: ToolDefinition) => () => void,
  dependencies: ToolDependencies,
): Array<() => void> {
  const { settings, log } = dependencies

  const status = defineTool({
    name: 'drawing_status',
    description:
      'List the electrical drawings available in this workspace and whether each has been indexed. ' +
      'Call this first whenever the user mentions drawings, schematics, wiring, terminals or cables: ' +
      'it is a cheap directory probe and never parses a PDF. Prints the cabinets (id, name, page range, ' +
      'sheet count), sheet-type counts and the caveats of each indexed drawing — no follow-up needed to learn the layout.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          drawingDir: { type: 'string' },
          documents: { type: 'array', items: { type: 'json' } },
          hint: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const documents = Array.isArray(value.documents) ? value.documents : []
        if (documents.length === 0) {
          return [{ type: 'text', text: `${String(value.hint ?? 'No drawing in this workspace yet.')}` }] as ContentBlock[]
        }
        const blocks: string[] = []
        for (const entry of documents) {
          const row = entry as {
            file?: string
            indexed?: boolean
            pages?: number | null
            project?: string | null
            vendor?: string | null
            cabinets?: Array<{ id: number; name: string; sheets: number; pages?: number[] }>
            templates?: Record<string, number>
            quality?: Record<string, number>
            caveats?: string[]
          }
          const head = `${row.file ?? '?'}${row.indexed === true ? '' : ' (NOT indexed yet — call drawing_open)'}`
          blocks.push(head)
          if (row.project !== null && row.project !== undefined) blocks.push(`  project: ${row.project}`)
          if (row.pages !== null && row.pages !== undefined) blocks.push(`  pages: ${row.pages}`)
          const cabinets = Array.isArray(row.cabinets) ? row.cabinets : []
          for (const cabinet of cabinets) {
            const range = Array.isArray(cabinet.pages) ? ` pages ${cabinet.pages[0]}–${cabinet.pages[1]},` : ''
            blocks.push(`  cabinet ${cabinet.id}: ${cabinet.name} —${range} ${cabinet.sheets} sheets`)
          }
          const quality = row.quality ?? {}
          if (typeof quality.xrefs === 'number') {
            blocks.push(
              `  index: ${quality.entities ?? '?'} elements, ${quality.xrefs} cross references ` +
                `(${quality.xrefsResolved ?? '?'} resolved)`,
            )
          }
          const templates = row.templates ?? {}
          const types = Object.entries(templates)
            .sort((left, right) => right[1] - left[1])
            .map(([name, count]) => `${name} ${count}`)
            .join(', ')
          if (types !== '') blocks.push(`  sheet types: ${types}`)
          for (const caveat of row.caveats ?? []) blocks.push(`  ! ${caveat}`)
        }
        return [{ type: 'text', text: blocks.join('\n') }] as ContentBlock[]
      },
    },
    async execute(_args, exec) {
      const scope = scopeOf(exec, settings)
      if ('error' in scope) return { ok: false, error: scope.error, documents: [] }
      const documents = await listDocuments(scope)
      await writeManifest(scope).catch(() => undefined)
      return {
        ok: true,
        drawingDir: scope.drawingDir,
        documents: documents.map((entry) => ({
          file: entry.file,
          indexed: entry.indexed,
          pages: entry.pages ?? null,
          project: entry.profile?.project?.name ?? null,
          vendor: entry.profile?.vendor ?? null,
          cabinets: (entry.profile?.cabinets ?? []).map((cabinet) => ({
            id: cabinet.id,
            name: cabinet.name,
            sheets: cabinet.sheets,
            pages: cabinet.pages,
          })),
          templates: entry.profile?.templates ?? {},
          quality: entry.profile?.quality ?? {},
          caveats: entry.profile?.caveats ?? [],
        })),
        hint:
          documents.length === 0
            ? `No drawing found. Ask the user for the PDF path (or an uploaded attachment) and call drawing_open; it will be copied into ${scope.drawingDir}.`
            : 'Use drawing_search / drawing_sheet to look things up; drawing_show to put a page on screen.',
      }
    },
  })

  const open = defineTool({
    name: 'drawing_open',
    description:
      'Ingest a PDF drawing into the workspace and build its index (sheets, cross references, named elements). ' +
      'Copies the source file into the workspace drawing directory (never moves or modifies the original), ' +
      'then parses it once — a repeat call on unchanged content returns the cached index without reparsing. ' +
      'Returns the drawing profile, which is the map for every later lookup.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Absolute path of the PDF to ingest (or a path already inside the drawing directory).',
      },
      force: { type: 'boolean', description: 'Rebuild even when the cached index matches the file hash.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          document: { type: 'string' },
          cached: { type: 'boolean' },
          millis: { type: 'integer' },
          pages: { type: 'integer' },
          project: { type: 'json' },
          cabinets: { type: 'array', items: { type: 'json' } },
          templates: { type: 'json' },
          quality: { type: 'json' },
          caveats: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `drawing_open failed: ${value.error ?? 'unknown'}` }]
        const cabinets = Array.isArray(value.cabinets) ? value.cabinets : []
        const project = value.project as { name?: string | null; number?: string | null; revision?: string | null } | undefined
        const quality = value.quality as Record<string, number> | undefined
        const templates = value.templates as Record<string, number> | undefined
        const lines = [
          `${value.document}: ${value.pages ?? '?'} pages${value.cached === true ? ' (cached index)' : ` (parsed in ${value.millis ?? '?'} ms)`}`,
        ]
        if (project?.name !== undefined && project?.name !== null) lines.push(`project: ${project.name}`)
        if (project?.number !== undefined && project?.number !== null) {
          lines.push(`drawing no: ${project.number}${project.revision ? ` rev ${project.revision}` : ''}`)
        }
        for (const cabinet of cabinets) {
          const row = cabinet as { id: number; name: string; sheets: number; pages?: number[] }
          const range = Array.isArray(row.pages) ? ` pages ${row.pages[0]}–${row.pages[1]},` : ''
          lines.push(`cabinet ${row.id}: ${row.name} —${range} ${row.sheets} sheets`)
        }
        if (templates !== undefined) {
          lines.push(
            `sheet types: ${Object.entries(templates)
              .sort((left, right) => right[1] - left[1])
              .map(([name, count]) => `${name} ${count}`)
              .join(', ')}`,
          )
        }
        if (quality !== undefined) {
          lines.push(
            `index: ${quality.entities ?? '?'} elements, ${quality.xrefs ?? '?'} cross references (${quality.xrefsResolved ?? '?'} resolved), ${quality.oddOrientationPages ?? 0} portrait sheets`,
          )
        }
        for (const caveat of (value.caveats as string[] | undefined) ?? []) lines.push(`! ${caveat}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const scope = scopeOf(exec, settings)
      if ('error' in scope) return { ok: false, error: scope.error }
      try {
        const pdfPath = await ingest(scope.drawingDir, args.source)
        const result = await openDrawing(scope.drawingDir, pdfPath, { force: args.force === true })
        await writeManifest(scope).catch(() => undefined)
        log.info?.(`drawing_open ${result.index.profile.document} cached=${result.cached} ${result.millis}ms`)
        return {
          ok: true,
          document: result.index.profile.document,
          cached: result.cached,
          millis: result.millis,
          pages: result.index.profile.pages,
          project: result.index.profile.project,
          cabinets: result.index.profile.cabinets,
          templates: result.index.profile.templates,
          quality: result.index.profile.quality,
          caveats: result.index.profile.caveats,
        }
      } catch (error) {
        log.warn?.(`drawing_open failed: ${String(error)}`)
        return { ok: false, error: `ingest_failed: ${String(error)}` }
      }
    },
  })

  const search = defineTool({
    name: 'drawing_search',
    description:
      'Search an indexed drawing for an element and get the pages that draw it: device tags (220KA3), ' +
      'wire numbers (210.VS4), cables (W015), PLC addresses (%Q430.2), terminal strips (X3), ' +
      'cross references, or free text from sheet titles. Returns locations, not page text: each hit prints ' +
      '`box x,y,w,h` in display points (page frame after /Rotate, origin top-left; most sheets are 842x595) — ' +
      'that box goes straight into drawing_show.',
    parameters: {
      query: { type: 'string', required: true, description: 'Exact identifier, or a fragment for text search.' },
      document: { type: 'string', description: 'PDF file name (or unique prefix). Optional when one drawing exists.' },
      kind: { type: 'string', enum: KINDS, description: 'Restrict the element kind. Default any.' },
      cabinet: { type: 'integer', description: 'Only this cabinet id (1-based, as printed in the profile).' },
      limit: { type: 'integer', description: 'Maximum hits (default 20, hard cap 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          document: { type: 'string' },
          total: { type: 'integer' },
          hits: { type: 'array', items: { type: 'json' } },
          error: { type: 'string' },
          hint: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return [{ type: 'text', text: `drawing_search: ${value.error ?? 'failed'}` }]
        }
        const hits = Array.isArray(value.hits) ? (value.hits as unknown as Hit[]) : []
        return [{ type: 'text', text: renderHits(value.document ?? '?', hits) }]
      },
    },
    async execute(args, exec) {
      const scope = scopeOf(exec, settings)
      if ('error' in scope) return { ok: false, error: scope.error }
      const loaded = await resolveDocument(scope, args.document)
      if ('error' in loaded) return { ok: false, error: loaded.error, hint: loaded.hint ?? [] }

      const { entry, index } = loaded
      const query = args.query.trim()
      const kind = args.kind ?? 'any'
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
      const sheetByPage = new Map(index.sheets.map((sheet) => [sheet.page, sheet]))
      const hits: Hit[] = []
      const seen = new Set<string>()

      const push = (hit: Hit): void => {
        if (args.cabinet !== undefined && hit.cabinet !== args.cabinet) return
        const key = `${hit.page}|${hit.text}|${Math.round((hit.x ?? 0) / 6)}|${Math.round((hit.y ?? 0) / 6)}`
        if (seen.has(key)) return
        seen.add(key)
        hits.push(hit)
      }

      const entityKinds = kind === 'any' ? null : kind
      if (entityKinds === null || ['tag', 'wire', 'cable', 'address', 'terminal', 'text'].includes(entityKinds)) {
        for (const [name, named] of Object.entries(index.names)) {
          if (entityKinds !== null && entityKinds !== 'text' && named.kind !== entityKinds) continue
          const exact = name.toLowerCase() === query.toLowerCase()
          const contains = name.toLowerCase().includes(query.toLowerCase())
          if (!exact && !contains) continue
          for (const occurrence of named.occurrences) {
            const sheet = sheetByPage.get(occurrence.page)
            push({
              cabinet: sheet?.cabinet ?? 0,
              sheet: sheet?.sheet ?? null,
              page: occurrence.page,
              title: sheet?.title ?? null,
              kind: named.kind,
              text: name,
              detail: sheet?.title ?? undefined,
              x: occurrence.x,
              y: occurrence.y,
              w: occurrence.w,
              h: occurrence.h,
            })
          }
          if (hits.length >= limit) break
        }
      }

      if (entityKinds === null || entityKinds === 'xref') {
        for (const xref of index.xrefs) {
          const matches =
            xref.raw === query ||
            `${xref.target}-${xref.column}` === query.trim() ||
            (Number.isFinite(Number(query)) && xref.target === Number(query))
          if (!matches) continue
          const sheet = sheetByPage.get(xref.page)
          const target = xref.targetPage === null ? undefined : sheetByPage.get(xref.targetPage)
          push({
            cabinet: sheet?.cabinet ?? 0,
            sheet: sheet?.sheet ?? null,
            page: xref.page,
            title: sheet?.title ?? null,
            kind: 'xref',
            text: xref.raw,
            detail: target === undefined ? '目标不可解析' : `→ ${where(target)}`,
            x: xref.x ?? undefined,
            y: xref.y ?? undefined,
            targetPage: xref.targetPage,
            targetSheet: target?.sheet ?? null,
            column: xref.column,
          })
        }
      }

      if (entityKinds === null || entityKinds === 'text') {
        const needle = query.toLowerCase()
        for (const sheet of index.sheets) {
          const haystack = `${sheet.title ?? ''} ${sheet.loc ?? ''}`.toLowerCase()
          if (!haystack.includes(needle)) continue
          push({
            cabinet: sheet.cabinet,
            sheet: sheet.sheet,
            page: sheet.page,
            title: sheet.title,
            kind: 'sheet',
            text: sheet.title ?? '',
            detail: `模板 ${sheet.template}`,
          })
          if (hits.length >= limit) break
        }
      }

      hits.sort((left, right) => left.page - right.page || (left.y ?? 0) - (right.y ?? 0))
      const trimmed = hits.slice(0, limit)
      return {
        ok: true,
        document: entry.file,
        total: hits.length,
        hits: trimmed,
        hint: trimmed.map((hit) => {
          const target = index.sheets.find((sheet) => sheet.page === hit.page)
          return target === undefined ? '' : `drawing_sheet: cabinet ${target.cabinet}, sheet ${target.sheet} or page ${target.page}`
        }).filter((line) => line !== '').slice(0, 3),
      }
    },
  })

  const sheet = defineTool({
    name: 'drawing_sheet',
    description:
      'Read one sheet of an indexed drawing: its title block, the page frame, every element drawn on it ' +
      '(tag, wire, cable, address, terminal — each with its box), and its cross references already resolved ' +
      'to target sheets. Use after drawing_search, or when the user names a sheet number. The boxes are in ' +
      'display points, so a highlight never has to be computed from the PDF by hand.',
    parameters: {
      cabinet: { type: 'integer', description: 'Cabinet id (1-based). Required when the sheet number repeats across cabinets.' },
      sheet: { type: 'integer', description: 'Sheet number as printed in the title block.' },
      page: { type: 'integer', description: 'Physical PDF page (1-based). Alternative to cabinet+sheet.' },
      document: { type: 'string', description: 'PDF file name (or unique prefix). Optional when one drawing exists.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          document: { type: 'string' },
          cabinet: { type: 'integer' },
          sheet: { type: 'json' },
          page: { type: 'integer' },
          title: { type: 'json' },
          template: { type: 'string' },
          loc: { type: 'json' },
          frame: { type: 'json' },
          elements: { type: 'array', items: { type: 'json' } },
          xrefs: { type: 'array', items: { type: 'json' } },
          incoming: { type: 'integer' },
          error: { type: 'string' },
          candidates: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `drawing_sheet: ${value.error ?? 'failed'}` }]
        const elements = Array.isArray(value.elements) ? value.elements : []
        const xrefs = Array.isArray(value.xrefs) ? value.xrefs : []
        const frame = value.frame as { width?: number; height?: number } | undefined
        const head =
          `${value.document} · cabinet ${value.cabinet} / sheet ${value.sheet ?? '—'} (p${value.page})\n` +
          `${value.title ?? '—'} · ${value.template ?? '?'}${value.loc === undefined || value.loc === null ? '' : ` · loc ${value.loc}`}` +
          `${frame === undefined ? '' : `\nframe ${frame.width ?? '?'}x${frame.height ?? '?'} display points (origin top-left, /Rotate applied)`}`
        const elementLines = elements.slice(0, 60).map((element) => {
          const row = element as { kind?: string; name?: string; x?: number; y?: number; w?: number; h?: number }
          return `  ${row.kind ?? '?'} ${row.name ?? '?'}  box ${row.x ?? 0},${row.y ?? 0},${row.w ?? 0},${row.h ?? 0}`
        })
        const more = elements.length > elementLines.length ? [`  … ${elements.length - elementLines.length} more element(s)`] : []
        const xrefLines = xrefs.slice(0, 40).map((xref) => {
          const row = xref as {
            raw?: string
            target?: number
            column?: number
            side?: string | null
            targetPage?: number | null
            targetSheet?: number | null
            targetCabinet?: number | null
          }
          const destination =
            row.targetPage === null || row.targetPage === undefined
              ? 'unresolved'
              : `→ cabinet ${row.targetCabinet ?? '?'} / sheet ${row.targetSheet ?? '—'} (p${row.targetPage})`
          return `  ${row.raw ?? '?'} ${destination}${row.column === undefined ? '' : ` col ${row.column}`}`
        })
        return [
          {
            type: 'text',
            text: [
              head,
              `elements (${elements.length}):`,
              ...(elementLines.length === 0 ? ['  (none drawn as tagged elements)'] : elementLines),
              ...more,
              `cross references (${xrefs.length}):`,
              ...(xrefLines.length === 0 ? ['  (none)'] : xrefLines),
              `referenced from other sheets: ${value.incoming ?? 0}`,
            ].join('\n'),
          },
        ] as ContentBlock[]
      },
    },
    async execute(args, exec) {
      const scope = scopeOf(exec, settings)
      if ('error' in scope) return { ok: false, error: scope.error }
      const loaded = await resolveDocument(scope, args.document)
      if ('error' in loaded) return { ok: false, error: loaded.error, candidates: [] }
      const { entry, index } = loaded
      const lookup = sheetIndex(index)

      let target: Sheet | undefined
      if (args.page !== undefined) target = lookup.get(`page:${args.page}`)
      else if (args.sheet !== undefined && args.cabinet !== undefined) target = lookup.get(`${args.cabinet}:${args.sheet}`)
      else if (args.sheet !== undefined) {
        const candidates = index.sheets.filter((row) => row.sheet === args.sheet)
        if (candidates.length === 1) target = candidates[0]
        else if (candidates.length > 1) {
          return {
            ok: false,
            error: 'sheet_ambiguous',
            candidates: candidates.map((row) => ({ cabinet: row.cabinet, page: row.page, title: row.title })),
          }
        }
      } else {
        return { ok: false, error: 'sheet_required', candidates: [] }
      }

      if (target === undefined) return { ok: false, error: 'sheet_not_found', candidates: [] }

      const elements = occurrencesOnPage(index, target.page).map((row) => ({
        name: row.name,
        kind: row.kind,
        x: row.occurrence.x,
        y: row.occurrence.y,
        w: row.occurrence.w,
        h: row.occurrence.h,
      }))
      const outgoing = xrefsOnPage(index, target.page).map((xref) => ({
        raw: xref.raw,
        target: xref.target,
        column: xref.column,
        side: xref.side,
        targetPage: xref.targetPage,
        targetCabinet: xref.targetCabinet,
        targetSheet: xref.targetPage === null ? null : (lookup.get(`page:${xref.targetPage}`)?.sheet ?? null),
      }))
      const incoming = index.xrefs.filter(
        (xref) => xref.targetPage === target?.page && xref.page !== target?.page,
      ).length

      return {
        ok: true,
        document: entry.file,
        cabinet: target.cabinet,
        // Never `undefined`: the harness validates the returned value as
        // lossless JSON, and a cover sheet legitimately has no number/title.
        sheet: target.sheet,
        page: target.page,
        title: target.title,
        template: target.template,
        loc: target.loc,
        frame: target.frame ?? null,
        elements,
        xrefs: outgoing,
        incoming,
      }
    },
  })

  const show = defineTool({
    name: 'drawing_show',
    description:
      'Show a sheet in the right-sidebar Drawing tab: it opens the tab, turns to the page and highlights the ' +
      'given element box. Use it once you know which page answers the question, so the user can verify it. ' +
      'x/y/w/h are display points: copy the box from a drawing_search hit or a drawing_sheet element instead ' +
      'of deriving coordinates from the PDF. Returns one line of confirmation, never an image.',
    parameters: {
      cabinet: { type: 'integer', description: 'Cabinet id (1-based).' },
      sheet: { type: 'integer', description: 'Sheet number as printed.' },
      page: { type: 'integer', description: 'Physical page, alternative to cabinet+sheet.' },
      document: { type: 'string', description: 'PDF file name (or unique prefix).' },
      x: { type: 'number', description: 'Highlight box left, in display points.' },
      y: { type: 'number', description: 'Highlight box top, in display points.' },
      w: { type: 'number', description: 'Highlight box width.' },
      h: { type: 'number', description: 'Highlight box height.' },
      caption: { type: 'string', description: 'Short label to show with the highlight.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          document: { type: 'string' },
          cabinet: { type: 'integer' },
          sheet: { type: 'json' },
          page: { type: 'integer' },
          title: { type: 'json' },
          highlight: { type: 'json' },
          image: { type: 'json' },
          viewPath: { type: 'string' },
          caption: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `drawing_show: ${value.error ?? 'failed'}` }]
        const head = `Shown: ${value.document} · cabinet ${value.cabinet} / sheet ${value.sheet ?? '—'} (p${value.page})${value.title === undefined || value.title === null ? '' : ` · ${value.title}`}`
        const box = value.highlight as { x?: number; y?: number; w?: number; h?: number } | null | undefined
        const mark =
          box === null || box === undefined
            ? 'no highlight box (page only)'
            : `highlight box ${box.x ?? 0},${box.y ?? 0},${box.w ?? 0},${box.h ?? 0} (display points)`
        return [{ type: 'text', text: `${head}\n${mark}${value.viewPath === undefined ? '' : `\nview: ${value.viewPath}`}` }]
      },
    },
    async execute(args, exec) {
      const scope = scopeOf(exec, settings)
      if ('error' in scope) return { ok: false, error: scope.error }
      const loaded = await resolveDocument(scope, args.document)
      if ('error' in loaded) return { ok: false, error: loaded.error }
      const { entry, index } = loaded
      const lookup = sheetIndex(index)

      let target: Sheet | undefined
      if (args.page !== undefined) target = lookup.get(`page:${args.page}`)
      else if (args.sheet !== undefined && args.cabinet !== undefined) target = lookup.get(`${args.cabinet}:${args.sheet}`)
      else if (args.sheet !== undefined) {
        const candidates = index.sheets.filter((row) => row.sheet === args.sheet)
        target = candidates.length === 1 ? candidates[0] : undefined
      }
      if (target === undefined) return { ok: false, error: 'sheet_not_found' }

      const highlight =
        args.x !== undefined && args.y !== undefined
          ? { x: args.x, y: args.y, w: args.w ?? 0, h: args.h ?? 0 }
          : null

      // Rasterise the sheet so the tab can show the page with the hit marked.
      // A render failure must never fail the lookup: the panel falls back to the
      // browser's own PDF viewer (no highlight) when `image` is null.
      let image: DrawingView['image'] = null
      try {
        const rendered = await renderPage(entry.dir, entry.path, target.page, 2)
        image = {
          path: rendered.path,
          width: rendered.width,
          height: rendered.height,
          displayWidth: rendered.displayWidth,
          displayHeight: rendered.displayHeight,
        }
      } catch (error) {
        log.warn?.(`drawing_show: rendering page ${target.page} failed: ${String(error)}`)
      }

      const viewPath = join(scope.cwd, '.dsh', 'drawing-view.json')
      const view: DrawingView = {
        document: entry.file,
        pdfPath: entry.path,
        cabinet: target.cabinet,
        sheet: target.sheet,
        page: target.page,
        title: target.title,
        caption: args.caption ?? null,
        highlight,
        image,
        ts: new Date().toISOString(),
      }
      await writeView(scope, view).catch((error: unknown) => {
        log.warn?.(`drawing_show: writing the view state failed: ${String(error)}`)
      })

      // The browser half folds this payload out of the session's tool results
      // and turns the tab to it; the model only gets the confirmation line. The
      // view path is printed because the client cannot always learn the session
      // cwd — it parses this line instead of guessing.
      return {
        ok: true,
        document: entry.file,
        cabinet: target.cabinet,
        sheet: target.sheet,
        page: target.page,
        title: target.title,
        highlight,
        caption: args.caption ?? null,
        image,
        viewPath,
      }
    },
  })

  return [status, open, search, sheet, show].map((definition) => register(definition))
}

/** Directory of one document's artifacts (exported for tools/tests). */
export function artifactsOf(scope: Scope, file: string): string {
  return documentDir(scope.drawingDir, join(scope.drawingDir, file))
}





