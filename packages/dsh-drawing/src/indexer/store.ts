/**
 * Where a drawing's derived artifacts live, and how they are written.
 *
 * Layout (one directory per source PDF, as required):
 *
 *   <workspace>/drawing/<pdf basename>.pdf      the copy made at ingest
 *   <workspace>/drawing/<pdf basename>/         derived, rebuilt from scratch
 *       profile.json    the drawing's identity card (also the model's map)
 *       build.json      sha256 / parser version / timings / checks
 *       index/sheets.json  index/xrefs.json  index/names.json
 *
 * The directory name follows the **source file**, so a reader can pair a PDF
 * with its index by eye. A second file with the same basename but a different
 * hash gets a `__<sha8>` suffix instead of overwriting the first.
 *
 * @module dsh-drawing/indexer/store
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

/** Bumped whenever the index shape or the rules change; invalidates caches. */
export const PARSER_VERSION = 2

/** The artifact directory name for a PDF path. */
export function documentDirName(pdfPath: string): string {
  return basename(pdfPath, extname(pdfPath))
}

/** Where the derived index of one PDF lives. */
export function documentDir(drawingDir: string, pdfPath: string): string {
  return join(drawingDir, documentDirName(pdfPath))
}

/** SHA-256 of a file, lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

/** Write a file atomically (temp + rename) so a crashed build never half-writes. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/** Write JSON atomically; `pretty` for the files a human reads. */
export async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await writeAtomic(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value))
}

/** Read JSON, or undefined when the file is absent. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** The build stamp kept next to the index. */
export interface BuildStamp {
  document: string
  sha256: string
  parserVersion: number
  pages: number
  builtAt: string
  millis: number
  checks: Record<string, string | number | boolean>
}

/**
 * Copy the source PDF into the drawing directory.
 *
 * Returns the path to index. A file already inside the drawing directory is
 * used as-is (no copy); a name taken by different content gets a hash suffix.
 */
export async function ingest(drawingDir: string, sourcePath: string): Promise<string> {
  const absolute = resolve(sourcePath)
  const inside = relative(drawingDir, absolute)
  if (inside !== '' && !inside.startsWith('..') && !inside.startsWith('/') && existsSync(absolute)) {
    return absolute
  }

  await mkdir(drawingDir, { recursive: true })
  const target = join(drawingDir, basename(absolute))
  if (!existsSync(target)) {
    await copyFile(absolute, target)
    return target
  }

  const [sourceHash, targetHash] = await Promise.all([sha256File(absolute), sha256File(target)])
  if (sourceHash === targetHash) return target

  const shadow = join(
    drawingDir,
    `${documentDirName(target)}__${sourceHash.slice(0, 8)}${extname(target)}`,
  )
  if (!existsSync(shadow)) await copyFile(absolute, shadow)
  return shadow
}


