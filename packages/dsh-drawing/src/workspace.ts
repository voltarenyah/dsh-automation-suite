/**
 * Workspace scope: which session, which directory, which drawing.
 *
 * The session's working directory **is** the scope (the same rule the sibling
 * engineering plugins use); the plugin never keeps a registry of drawings —
 * the `drawing/` directory **is** the record. That keeps the state inspectable
 * by a human and disposable by deleting one folder.
 *
 * @module dsh-drawing/workspace
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { loadIndex, type Index, type Profile } from './indexer/build.js'
import { documentDir, readJson, writeJson } from './indexer/store.js'

/** Resolved configuration of the plugin. */
export type Settings = {
  /** Workspace-relative directory that holds drawings and their indexes. */
  dir: string
}

/** What a tool call is scoped to. */
export type Scope = {
  cwd: string
  drawingDir: string
}

/** One PDF found in the drawing directory. */
export type DocumentEntry = {
  /** The PDF file name, e.g. `PEI---SWT2_20260527.pdf`. */
  file: string
  /** Absolute path of the PDF. */
  path: string
  /** Absolute path of its derived directory (may not exist yet). */
  dir: string
  /** True when a finished index was found. */
  indexed: boolean
  pages?: number
  profile?: Profile
}

/** Resolve the tool call's workspace scope, or report why it is unavailable. */
export function scopeOf(exec: ToolRunContext, settings: Settings): Scope | { error: string } {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return { error: 'scope_unavailable' }
  return { cwd: resolve(cwd), drawingDir: resolve(cwd, settings.dir) }
}

/** List the drawings under the scope, newest first, with their index state. */
export async function listDocuments(scope: Scope): Promise<DocumentEntry[]> {
  let names: string[]
  try {
    names = await readdir(scope.drawingDir)
  } catch {
    return []
  }

  const entries: DocumentEntry[] = []
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith('.pdf')) continue
    const path = join(scope.drawingDir, name)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    const dir = documentDir(scope.drawingDir, path)
    const profile = await readJson<Profile>(join(dir, 'profile.json'))
    entries.push({
      file: name,
      path,
      dir,
      indexed: profile !== undefined && existsSync(join(dir, 'build.json')),
      pages: profile?.pages,
      profile,
    })
  }
  return entries
}

/** Load the index of one document by file name (or its unique prefix). */
export async function loadDocument(
  scope: Scope,
  file: string,
): Promise<{ entry: DocumentEntry; index: Index } | { error: string; matches?: string[] }> {
  const documents = await listDocuments(scope)
  const exact = documents.find((entry) => entry.file === file)
  if (exact !== undefined) {
    const index = await loadIndex(exact.dir)
    return index === undefined ? { error: 'not_indexed' } : { entry: exact, index }
  }
  const matches = documents.filter((entry) => entry.file.startsWith(file))
  const only = matches.length === 1 ? matches[0] : undefined
  if (only !== undefined) {
    const index = await loadIndex(only.dir)
    return index === undefined ? { error: 'not_indexed' } : { entry: only, index }
  }
  if (matches.length > 1) return { error: 'ambiguous_document', matches: matches.map((entry) => entry.file) }
  return { error: 'document_not_found' }
}

/** Default document when only one exists and the caller did not name one. */
export function pickDocument(documents: readonly DocumentEntry[]): DocumentEntry | undefined {
  return documents.length === 1 ? documents[0] : undefined
}

/** The manifest the browser half reads: one file, absolute paths, no listing. */
export type Manifest = {
  generatedAt: string
  drawingDir: string
  documents: Array<{
    file: string
    /** Absolute path of the PDF — the panel loads it for its own page viewer. */
    pdf: string
    dir: string
    pages: number | null
    indexed: boolean
    project: string | null
    cabinets: Array<{ id: number; name: string; sheets: number }>
    caveats: string[]
  }>
}

/**
 * Write `<drawingDir>/manifest.json`.
 *
 * The sidebar tab cannot list a directory (it only reads files by absolute
 * path), so the host keeps this one small file current on every status/open
 * call. It is derived state: delete it and the next call rebuilds it.
 */
export async function writeManifest(scope: Scope): Promise<Manifest> {
  const documents = await listDocuments(scope)
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    drawingDir: scope.drawingDir,
    documents: documents.map((entry) => ({
      file: entry.file,
      pdf: entry.path,
      dir: entry.dir,
      pages: entry.pages ?? null,
      indexed: entry.indexed,
      project: entry.profile?.project?.name ?? null,
      cabinets: (entry.profile?.cabinets ?? []).map((cabinet) => ({
        id: cabinet.id,
        name: cabinet.name,
        sheets: cabinet.sheets,
      })),
      caveats: entry.profile?.caveats ?? [],
    })),
  }
  await mkdir(scope.drawingDir, { recursive: true })
  await writeJson(join(scope.drawingDir, 'manifest.json'), manifest, true)
  // Fixed location the browser half can read without knowing the configured dir.
  await writeJson(join(scope.cwd, '.dsh', 'drawing-manifest.json'), manifest, true)
  return manifest
}





/** What the panel should show after `drawing_show`. */
export type DrawingView = {
  document: string
  /** Absolute path of the source PDF (the panel's own viewer uses it). */
  pdfPath: string
  cabinet: number
  sheet: number | null
  page: number
  title: string | null
  caption: string | null
  /** Highlight box in display points (842x595 for landscape sheets). */
  highlight: { x: number; y: number; w: number; h: number } | null
  /** Rendered page image, when the host could rasterise it. */
  image: { path: string; width: number; height: number; displayWidth: number; displayHeight: number } | null
  /** Monotonic stamp so a reader can tell a new request from the previous one. */
  ts: string
}

/**
 * Write the view state the Drawing tab follows.
 *
 * The sidebar cannot be commanded directly from the host process, so the agent's
 * `drawing_show` leaves this file behind and the client's always-mounted
 * controller notices the matching tool result and reads it. One small file is
 * also the human-readable trace of "what the agent last put on screen".
 */
export async function writeView(scope: Scope, view: DrawingView): Promise<void> {
  await writeJson(join(scope.cwd, '.dsh', 'drawing-view.json'), view, true)
}
