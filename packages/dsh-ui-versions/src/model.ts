/**
 * Pure core of the Versions tab: parse the view file, filter it, format the
 * small values the panel prints. No React, no I/O — the panel and the tests
 * both drive this module.
 *
 * The view file is written by `@voltarenyah/dsh-engineering-context` and is
 * deliberately flat JSON: the browser cannot open the SQLite store, and a
 * pre-built view keeps the tab a single `readBytes` call.
 *
 * @module dsh-ui-versions/model
 */

/** Workspace-relative path of the view file. */
export const VIEW_FILE = '.dsh/versions-view.json'

/** One changed object inside a version. */
export interface VersionEvent {
  key: string
  change: 'added' | 'modified' | 'removed' | string
  faces: string[]
  before: Record<string, string> | null
  after: Record<string, string> | null
  linesAdded: number | null
  linesRemoved: number | null
  reason: string | null
  problem: string | null
}

/** One commit. */
export interface VersionRow {
  commit: string
  parent: string | null
  date: string
  subject: string
  op: string | null
  checksum: string | null
  checksumPrev: string | null
  acceptance: string | null
  intent: string | null
  events: VersionEvent[]
}

/** One row of a block's timeline. */
export interface TimelineRow {
  block: string
  seq: number
  commit: string
  date: string
  subject: string
  faces: string[]
  before: Record<string, string> | null
  after: Record<string, string> | null
  reason: string | null
  problem: string | null
}

/** The whole view. */
export interface VersionView {
  device: string
  workspace: string
  generatedAt: string
  counts: { versions: number; events: number; baseline: number }
  versions: VersionRow[]
  timeline: TimelineRow[]
  problems: string[]
}

/** Parse result: the view, or a code the panel turns into a dictionary key. */
export type ParseResult = { ok: true; view: VersionView } | { ok: false; code: string }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function faces(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

function fingerprints(value: unknown): Record<string, string> | null {
  const raw = record(value)
  if (raw === null) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/**
 * Parse the view file.
 *
 * A view with no `versions` array is refused: the panel must not render an
 * empty history over a file that was never written.
 *
 * @param raw - the file text.
 * @returns the view or a failure code.
 */
export function parseView(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'view/invalid-json' }
  }
  const root = record(parsed)
  if (root === null) return { ok: false, code: 'view/not-an-object' }
  const rawVersions = root['versions']
  if (!Array.isArray(rawVersions)) return { ok: false, code: 'view/no-versions' }

  const versions: VersionRow[] = []
  for (const value of rawVersions) {
    const item = record(value)
    if (item === null) continue
    const commit = text(item['commit'])
    if (commit === null) continue
    const events: VersionEvent[] = []
    for (const entry of Array.isArray(item['events']) ? item['events'] : []) {
      const event = record(entry)
      if (event === null) continue
      const key = text(event['key'])
      if (key === null) continue
      events.push({
        key,
        change: text(event['change']) ?? 'modified',
        faces: faces(event['faces']),
        before: fingerprints(event['before']),
        after: fingerprints(event['after']),
        linesAdded: numberOrNull(event['linesAdded']),
        linesRemoved: numberOrNull(event['linesRemoved']),
        reason: text(event['reason']),
        problem: text(event['problem']),
      })
    }
    versions.push({
      commit,
      parent: text(item['parent']),
      date: text(item['date']) ?? '',
      subject: text(item['subject']) ?? '',
      op: text(item['op']),
      checksum: text(item['checksum']),
      checksumPrev: text(item['checksumPrev']),
      acceptance: text(item['acceptance']),
      intent: text(item['intent']),
      events,
    })
  }

  const timeline: TimelineRow[] = []
  for (const value of Array.isArray(root['timeline']) ? root['timeline'] : []) {
    const item = record(value)
    if (item === null) continue
    const block = text(item['block'])
    const commit = text(item['commit'])
    if (block === null || commit === null) continue
    timeline.push({
      block,
      seq: typeof item['seq'] === 'number' ? item['seq'] : 0,
      commit,
      date: text(item['date']) ?? '',
      subject: text(item['subject']) ?? '',
      faces: faces(item['faces']),
      before: fingerprints(item['before']),
      after: fingerprints(item['after']),
      reason: text(item['reason']),
      problem: text(item['problem']),
    })
  }

  const counts = record(root['counts']) ?? {}
  const problems = Array.isArray(root['problems']) ? root['problems'].map((entry) => String(entry)) : []

  return {
    ok: true,
    view: {
      device: text(root['device']) ?? '—',
      workspace: text(root['workspace']) ?? '—',
      generatedAt: text(root['generatedAt']) ?? '',
      counts: {
        versions: typeof counts['versions'] === 'number' ? counts['versions'] : versions.length,
        events: typeof counts['events'] === 'number' ? counts['events'] : 0,
        baseline: typeof counts['baseline'] === 'number' ? counts['baseline'] : 0,
      },
      versions,
      timeline,
      problems,
    },
  }
}

/** Filters the toolbar offers. */
export interface Filters {
  query?: string
  face?: string
  problem?: string
}

/**
 * Filter versions by free text, face and problem.
 *
 * @param view - the parsed view.
 * @param filters - the toolbar state.
 * @returns the matching versions, in the file's order.
 */
export function filterVersions(view: VersionView, filters: Filters): VersionRow[] {
  const query = (filters.query ?? '').trim().toLowerCase()
  return view.versions.filter((version) => {
    if (filters.face !== undefined && filters.face.length > 0) {
      if (!version.events.some((event) => event.faces.includes(filters.face as string))) return false
    }
    if (filters.problem !== undefined && filters.problem.length > 0) {
      if (!version.events.some((event) => event.problem === filters.problem)) return false
    }
    if (query.length === 0) return true
    const haystack = [
      version.commit,
      version.subject,
      version.intent ?? '',
      ...version.events.map((event) => `${event.key} ${event.reason ?? ''}`),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })
}

/** One block's timeline, in sequence order. */
export function timelineFor(view: VersionView, block: string): TimelineRow[] {
  return view.timeline.filter((row) => row.block === block).sort((left, right) => left.seq - right.seq)
}

/** The first 10 characters of a sha or fingerprint (the panel's display rule). */
export function shortSha(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.slice(0, 10)
}

/** A date rendered for the active language, or the raw string when unparseable. */
export function formatDate(iso: string, lang: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(lang === 'en' ? 'en-GB' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
