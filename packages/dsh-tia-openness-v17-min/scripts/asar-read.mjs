/**
 * Minimal read-only access to an Electron ASAR archive.
 *
 * Enough to pull the DeepSeek Harness runtime packages out of an installed
 * app's `resources/app.asar`, where they live as a normal hoisted
 * `node_modules` tree. Plain Node cannot import from inside an ASAR, so a
 * checkout that wants to run the plugin's tests against the *real* runtime has
 * to materialise those packages on disk first — see `dsh-runtime-cache.mjs`.
 *
 * Only the archive header is parsed eagerly (a few hundred KB for a ~120 MB
 * archive); file contents are read on demand.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** Byte offset of the header pickle: 4-byte item count + 4-byte header size. */
const PICKLE_PREFIX_BYTES = 8

/**
 * Parse an ASAR header into a flat path → location index.
 *
 * @param {string} archive - absolute path to the `.asar` file.
 * @returns {{ files: Map<string, {offset: number, size: number, unpacked: boolean}>, dataOffset: number }}
 * @throws {Error} when the archive cannot be read or its header is malformed.
 */
export function readAsarIndex(archive) {
  const handle = openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readSync(handle, prefix, 0, 16, 0)

    // Modern builds start the pickle with the item count; older ones put the
    // JSON length first. Locating the '{' byte covers both layouts.
    const firstUint32 = prefix.readUInt32LE(0)
    const headerSize = prefix.readUInt32LE(4)
    if (headerSize <= 0) throw new Error(`not an asar archive (header size ${headerSize}): ${archive}`)

    const header = Buffer.alloc(headerSize)
    readSync(handle, header, 0, headerSize, PICKLE_PREFIX_BYTES)

    const jsonStart = header.indexOf(0x7b)
    if (jsonStart < 0) throw new Error(`asar header holds no JSON object: ${archive}`)
    const jsonLength = firstUint32 === 4 ? header.readUInt32LE(jsonStart - 4) : header.readUInt32LE(0)

    const tree = JSON.parse(header.toString('utf8', jsonStart, jsonStart + jsonLength))

    const files = new Map()
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (entry.files !== undefined) walk(entry, path)
        else files.set(path, { offset: Number(entry.offset ?? 0), size: entry.size ?? 0, unpacked: entry.unpacked === true })
      }
    }
    walk(tree, '')

    return { files, dataOffset: PICKLE_PREFIX_BYTES + headerSize }
  } finally {
    closeSync(handle)
  }
}

/**
 * Read one file out of an indexed ASAR.
 *
 * @param {string} archive - absolute path to the `.asar` file.
 * @param {ReturnType<typeof readAsarIndex>} index - header index from {@link readAsarIndex}.
 * @param {string} path - archive-relative path using `/` separators.
 * @param {string} unpackedDir - the sibling `<archive>.unpacked` directory.
 * @returns {Buffer | null} the contents, or null when the path is not in the archive.
 */
export function readAsarFile(archive, index, path, unpackedDir) {
  const entry = index.files.get(path)
  if (entry === undefined) return null

  if (entry.unpacked) {
    const onDisk = join(unpackedDir, path)
    return existsSync(onDisk) ? readFileSync(onDisk) : null
  }

  const handle = openSync(archive, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(handle, buffer, 0, entry.size, index.dataOffset + entry.offset)
    return buffer
  } finally {
    closeSync(handle)
  }
}

/** @returns {string} the `<archive>.unpacked` sibling directory for an archive. */
export function unpackedDirFor(archive) {
  return `${archive}.unpacked`
}
