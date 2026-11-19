/**
 * Read the small parts of a TIA archive that matter before TIA is touched.
 *
 * A `.zap17` is a ZIP (TIA's `Compressed` / `DiscardRestorableDataAndCompressed`
 * modes produce a zip-compatible archive). That lets the import verify the
 * marker and the project's version/name **before** closing the open project or
 * moving any directory — a wrong version or a foreign archive is rejected while
 * the workspace is still untouched.
 *
 * Only the marker and the root `.ap17` are decompressed. `fflate` reads the
 * central directory and skips every other entry, so a 100 MB archive does not
 * have to be expanded into memory in full.
 *
 * @module dsh-engineering-context/handoff/zip
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { XMLParser } from 'fast-xml-parser'
import { unzipSync } from 'fflate'

import { EngineeringContextError } from '../errors.js'
import { record, text } from './marker.js'
import { HANDOFF_MARKER_FILE, USERFILES_DIR } from './types.js'

/** The bytes and selected entries of one archive. */
export interface ArchiveRead {
  bytes: Buffer
  sha256: string
  /** Every entry name the archive lists, normalized to forward slashes. */
  entries: string[]
  /** The marker text, when the archive carries one. */
  marker: { entry: string; text: string } | null
  /** The root `.ap17` project file, when the archive carries one. */
  project: { entry: string; text: string } | null
}

/** Normalize a ZIP entry name for comparisons. */
export function normalizeEntryName(name: string): string {
  return name.replace(/\\/gu, '/').replace(/^\.\//u, '')
}

function baseName(name: string): string {
  return normalizeEntryName(name).split('/').pop() ?? ''
}

/** True for `UserFiles/_dsh-handoff.json` (and the root fallback older builds may write). */
export function isMarkerEntry(name: string): boolean {
  const normalized = normalizeEntryName(name).toLowerCase()
  return normalized === `${USERFILES_DIR.toLowerCase()}/${HANDOFF_MARKER_FILE.toLowerCase()}` || normalized === HANDOFF_MARKER_FILE.toLowerCase()
}

/** True for the project file TIA puts at the archive root. */
export function isProjectEntry(name: string): boolean {
  const normalized = normalizeEntryName(name).toLowerCase()
  return normalized.endsWith('.ap17') && !normalized.includes('/')
}

/** SHA-256 of bytes, lowercase hex. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read an archive from disk.
 *
 * @param file - absolute `.zap17` path.
 * @returns the archive's selected entries and hash.
 * @throws {EngineeringContextError} `handoff_archive_not_found` / `handoff_archive_invalid`.
 */
export async function readArchive(file: string): Promise<ArchiveRead> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EngineeringContextError('handoff_archive_not_found', `No handoff archive exists at ${file}.`, { file })
    }
    throw new EngineeringContextError('handoff_archive_invalid', `The handoff archive ${file} could not be read.`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    })
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(bytes), {
      filter: (entry) => isMarkerEntry(entry.name) || isProjectEntry(entry.name),
    })
  } catch (error) {
    throw new EngineeringContextError(
      'handoff_archive_invalid',
      `${file} is not a readable ZIP archive, or it uses an archive mode this build cannot inspect. ` +
        'Use TIA Portal V17 with mode "compressed".',
      { file, cause: error instanceof Error ? error.message : String(error) },
    )
  }

  const entries = Object.keys(files).map(normalizeEntryName)
  const markerEntries = Object.entries(files).filter(([name]) => isMarkerEntry(name))
  const projectEntries = Object.entries(files).filter(([name]) => isProjectEntry(name))
  if (markerEntries.length > 1) {
    throw new EngineeringContextError('handoff_archive_invalid', `${file} contains more than one handoff marker.`, {
      file,
      entries: markerEntries.map(([name]) => normalizeEntryName(name)),
    })
  }
  if (projectEntries.length > 1) {
    throw new EngineeringContextError('handoff_archive_invalid', `${file} contains more than one root .ap17 project file.`, {
      file,
      entries: projectEntries.map(([name]) => normalizeEntryName(name)),
    })
  }

  const markerEntry = markerEntries[0]
  const projectEntry = projectEntries[0]
  return {
    bytes,
    sha256: sha256Bytes(bytes),
    entries,
    marker:
      markerEntry === undefined
        ? null
        : { entry: normalizeEntryName(markerEntry[0]), text: Buffer.from(markerEntry[1]).toString('utf8') },
    project:
      projectEntry === undefined
        ? null
        : { entry: normalizeEntryName(projectEntry[0]), text: Buffer.from(projectEntry[1]).toString('utf8') },
  }
}

/** The project identity read from the `.ap17` XML at the archive root. */
export interface Ap17Identity {
  name: string
  tiaVersion: string
  majorVersion: number
}

/**
 * Parse the root `.ap17` XML.
 *
 * The root element carries both facts the preflight needs: `Name` and
 * `ProjectCompatibilityVersion`. Nothing else in the project is parsed.
 *
 * @param textValue - the `.ap17` file contents.
 * @param origin - the archive/entry name, for errors.
 */
export function parseAp17Identity(textValue: string, origin: string): Ap17Identity {
  const cleaned = textValue.replace(/^\uFEFF/u, '')
  let document: unknown
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: true,
    }).parse(cleaned)
  } catch (error) {
    throw new EngineeringContextError('handoff_archive_invalid', `${origin} is not valid XML.`, {
      origin,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const root = record(document)
  const data = record(root?.['Data'])
  const name = text(data?.['@_Name'])
  const tiaVersion = text(data?.['@_ProjectCompatibilityVersion'])
  if (name === null || tiaVersion === null) {
    throw new EngineeringContextError(
      'handoff_archive_invalid',
      `${origin} is not a TIA project file (missing Data/@Name or Data/@ProjectCompatibilityVersion).`,
      { origin },
    )
  }
  const match = /^(\d+)/u.exec(tiaVersion)
  const majorVersion = match === null ? 0 : Number(match[1])
  if (!Number.isFinite(majorVersion) || majorVersion <= 0) {
    throw new EngineeringContextError('handoff_archive_invalid', `${origin} reports an unusable TIA version ${tiaVersion}.`, {
      origin,
      tiaVersion,
    })
  }
  return { name, tiaVersion, majorVersion }
}

/** The base file name of a path, for display. */
export function fileNameOf(file: string): string {
  return file.replace(/\\/gu, '/').split('/').pop() ?? file
}

/** Exposed for tests: the entry basename helper. */
export { baseName }
