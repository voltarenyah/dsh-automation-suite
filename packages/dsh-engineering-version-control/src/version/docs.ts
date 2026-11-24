/**
 * Indexing external design documents into the version store.
 *
 * A document is **not copied into the database**: the file stays the truth. The
 * store keeps its content hash (`doc:<sha256>`, so identical content is stored
 * once), a few structural spans (markdown headings with line ranges), a text
 * body for full-text search, and the graph edges that attach it to the objects
 * it declares in its front matter:
 *
 *     ---
 *     kind: design
 *     affects:
 *       - blocks|01_Cavity_A|100_Cycle_Selection_Cav_A
 *     problems: [cooling-table-blocked]
 *     ---
 *
 * Anything not declared is left unlinked: a wrong edge is worse than a missing
 * one, and the agent can link it later with `project_version_annotate`.
 *
 * @module dsh-engineering-context/version/docs
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import type { PluginConfig } from '../config.js'
import { versionDocsDirectory, type VersionStore } from './store.js'

/** What one index run did. */
export interface DocIndexReport {
  scanned: number
  indexed: number
  skipped: number
  linked: number
  fts: boolean
  warnings: string[]
}

/** One parsed document. */
export interface ParsedDocument {
  path: string
  relativePath: string
  docId: string
  contentHash: string
  bytes: number
  title: string
  kind: string | null
  affects: string[]
  problems: string[]
  spans: { anchor: string; heading: string; startLine: number; endLine: number }[]
  body: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Parse a minimal YAML front matter: scalars, `[a, b]` and `- item` lists. */
function parseFrontMatter(text: string): { fields: Record<string, string>; lists: Record<string, string[]>; bodyStart: number } {
  const fields: Record<string, string> = {}
  const lists: Record<string, string[]> = {}
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return { fields, lists, bodyStart: 0 }

  let index = 1
  let currentList: string | null = null
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') {
      index += 1
      break
    }
    const bullet = /^\s+-\s+(.+)$/u.exec(line)
    if (bullet !== null && currentList !== null) {
      const list = lists[currentList]
      if (list !== undefined) list.push((bullet[1] ?? '').trim())
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (pair === null) continue
    const key = pair[1] ?? ''
    if (key.length === 0) continue
    const value = (pair[2] ?? '').trim()
    if (value.length === 0) {
      lists[key] = []
      currentList = key
      continue
    }
    currentList = null
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value
      lists[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim().replace(/^["']|["']$/gu, ''))
        .filter((entry) => entry.length > 0)
    } else {
      fields[key] = value.replace(/^["']|["']$/gu, '')
    }
  }
  return { fields, lists, bodyStart: index }
}

/** Extract markdown headings with their line ranges. */
function extractSpans(body: string, startLine: number): ParsedDocument['spans'] {
  const lines = body.split(/\r?\n/u)
  const spans: ParsedDocument['spans'] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/u.exec(lines[index] ?? '')
    if (match === null) continue
    const heading = (match[2] ?? '').trim()
    let end = lines.length
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      if (/^(#{1,6})\s+/u.test(lines[probe] ?? '')) {
        end = probe
        break
      }
    }
    spans.push({ anchor: `#${heading}`, heading, startLine: startLine + index, endLine: startLine + end })
  }
  return spans
}

/** Parse one document from disk. */
export async function parseDocument(file: string, workspaceRoot: string): Promise<ParsedDocument | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const info = await stat(file)
  const front = parseFrontMatter(text)
  const body = text.split(/\r?\n/u).slice(front.bodyStart).join('\n')
  const contentHash = sha256(text)
  const firstHeading = /^#{1,6}\s+(.+)$/mu.exec(body)
  const title = front.fields['title'] ?? firstHeading?.[1]?.trim() ?? file.split(/[\\/]/u).pop() ?? file
  const affects = front.lists['affects'] ?? []
  const problems = front.lists['problems'] ?? []
  return {
    path: file,
    relativePath: relative(workspaceRoot, file).replace(/\\/gu, '/'),
    docId: `doc:${contentHash}`,
    contentHash,
    bytes: info.size,
    title,
    kind: front.fields['kind'] ?? null,
    affects,
    problems,
    spans: extractSpans(body, front.bodyStart + 1),
    body: body.slice(0, 512 * 1024),
  }
}

/** Recursively collect indexable files under one directory. */
async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: { name: string; isDirectory(): boolean }[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(path, out)
      continue
    }
    const extension = extname(entry.name).toLowerCase()
    if (extension === '.md' || extension === '.markdown' || extension === '.txt') out.push(path)
  }
}

/**
 * Index (or re-index) one directory of documents.
 *
 * @param input - the store, the workspace root and an optional directory.
 * @returns what was indexed.
 */
export async function indexDocuments(input: {
  store: VersionStore
  config: PluginConfig
  root: string
  dir?: string
}): Promise<DocIndexReport> {
  const { store, config, root } = input
  const report: DocIndexReport = { scanned: 0, indexed: 0, skipped: 0, linked: 0, fts: store.fts, warnings: [] }
  const directory = input.dir !== undefined && input.dir.length > 0 ? input.dir : versionDocsDirectory(config, root)
  if (!existsSync(directory)) return report

  const files: string[] = []
  await collectFiles(directory, files)

  for (const file of files) {
    report.scanned += 1
    const parsed = await parseDocument(file, root)
    if (parsed === null) {
      report.skipped += 1
      continue
    }
    const now = new Date().toISOString()
    store.transaction(() => {
      store.run(
        `INSERT INTO documents(doc_id, path, title, kind, mime, bytes, content_hash, git_commit, git_path, indexed_at)
         VALUES(?, ?, ?, ?, 'text/markdown', ?, ?, NULL, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET
           path = excluded.path, title = excluded.title, kind = excluded.kind, bytes = excluded.bytes,
           indexed_at = excluded.indexed_at, git_path = excluded.git_path`,
        parsed.docId,
        parsed.relativePath,
        parsed.title,
        parsed.kind,
        parsed.bytes,
        parsed.contentHash,
        parsed.relativePath,
        now,
      )
      store.run('DELETE FROM doc_spans WHERE doc_id = ?', parsed.docId)
      for (const span of parsed.spans) {
        const spanId = `span:${parsed.docId}:${span.anchor}`
        store.run(
          `INSERT INTO doc_spans(span_id, doc_id, anchor, heading, start_line, end_line, text_hash)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          spanId,
          parsed.docId,
          span.anchor,
          span.heading,
          span.startLine,
          span.endLine,
          sha256(`${span.heading}:${span.startLine}:${span.endLine}`),
        )
      }
      store.run(
        `INSERT INTO doc_text(doc_id, body) VALUES(?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET body = excluded.body`,
        parsed.docId,
        parsed.body,
      )
      if (store.fts) {
        store.run('DELETE FROM doc_fts WHERE doc_id = ?', parsed.docId)
        store.run('INSERT INTO doc_fts(doc_id, title, body) VALUES(?, ?, ?)', parsed.docId, parsed.title, parsed.body)
      }

      // Graph: Doc node + Span nodes + edges to the objects/problems it declares.
      const docNodeId = parsed.docId
      store.run(
        `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Doc', ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        docNodeId,
        parsed.title,
      )
      const setProp = (nodeId: string, name: string, value: string | null): void => {
        if (value === null) return
        store.run(
          `INSERT INTO graph_node_properties(node_id, name, value) VALUES(?, ?, ?)
           ON CONFLICT(node_id, name) DO UPDATE SET value = excluded.value`,
          nodeId,
          name,
          value,
        )
      }
      setProp(docNodeId, 'path', parsed.relativePath)
      setProp(docNodeId, 'title', parsed.title)
      setProp(docNodeId, 'kind', parsed.kind)
      setProp(docNodeId, 'bytes', String(parsed.bytes))

      for (const span of parsed.spans) {
        const spanId = `span:${parsed.docId}:${span.anchor}`
        store.run(
          `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Span', ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
          spanId,
          span.heading,
        )
        store.run(
          `INSERT INTO graph_edges(id, type, from_node_id, to_node_id) VALUES(?, 'HAS_SPAN', ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          `edge:HAS_SPAN:${docNodeId}:${spanId}`,
          docNodeId,
          spanId,
        )
      }

      for (const key of parsed.affects) {
        const objectId = `object:${key}`
        store.run(
          `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Object', ?)
           ON CONFLICT(id) DO NOTHING`,
          objectId,
          key,
        )
        store.run(
          `INSERT INTO graph_edges(id, type, from_node_id, to_node_id) VALUES(?, 'DOCUMENTS', ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          `edge:DOCUMENTS:${docNodeId}:${objectId}`,
          docNodeId,
          objectId,
        )
        report.linked += 1
      }
      for (const problem of parsed.problems) {
        const problemId = `problem:${problem}`
        store.run(
          `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Problem', ?)
           ON CONFLICT(id) DO NOTHING`,
          problemId,
          problem,
        )
        store.run(
          `INSERT INTO graph_edges(id, type, from_node_id, to_node_id) VALUES(?, 'DOCUMENTS', ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          `edge:DOCUMENTS:${docNodeId}:${problemId}`,
          docNodeId,
          problemId,
        )
        report.linked += 1
      }
    })
    report.indexed += 1
  }

  return report
}

/** One full-text hit. */
export interface DocHit {
  docId: string
  path: string
  title: string | null
  snippet: string
}

/**
 * Search indexed documents.
 *
 * FTS5 `trigram` needs at least three characters; shorter queries fall back to
 * `LIKE`, so a two-character Chinese term still works.
 *
 * @param store - the open store.
 * @param query - the text to find.
 * @param limit - maximum hits.
 * @returns the hits, newest index first.
 */
export function searchDocuments(store: VersionStore, query: string, limit = 20): DocHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  if (store.fts && trimmed.length >= 3) {
    try {
      return store
        .all<Record<string, unknown>>(
          `SELECT f.doc_id AS doc_id, d.path AS path, d.title AS title,
                  snippet(doc_fts, 2, '[', ']', '…', 12) AS snippet
           FROM doc_fts f JOIN documents d ON d.doc_id = f.doc_id
           WHERE doc_fts MATCH ? LIMIT ?`,
          trimmed,
          limit,
        )
        .map((row) => ({
          docId: String(row['doc_id'] ?? ''),
          path: String(row['path'] ?? ''),
          title: typeof row['title'] === 'string' ? row['title'] : null,
          snippet: String(row['snippet'] ?? ''),
        }))
    } catch {
      // A malformed MATCH expression falls through to LIKE.
    }
  }
  return store
    .all<Record<string, unknown>>(
      `SELECT d.doc_id AS doc_id, d.path AS path, d.title AS title, substr(t.body, 1, 160) AS snippet
       FROM documents d LEFT JOIN doc_text t ON t.doc_id = d.doc_id
       WHERE d.path LIKE ? OR d.title LIKE ? OR t.body LIKE ? LIMIT ?`,
      `%${trimmed}%`,
      `%${trimmed}%`,
      `%${trimmed}%`,
      limit,
    )
    .map((row) => ({
      docId: String(row['doc_id'] ?? ''),
      path: String(row['path'] ?? ''),
      title: typeof row['title'] === 'string' ? row['title'] : null,
      snippet: String(row['snippet'] ?? ''),
    }))
}
