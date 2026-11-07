#!/usr/bin/env node
// Three-way merge for a DSH profile's cordis.patch.yml.
//
// The desktop installer must update the fixed profile's app-managed policy
// without discarding the user's overrides (requestTimeoutMs, modelVisibility,
// provider, ...). We cannot use a plain YAML library here: the installer may run
// before the app layer is available, and the patch is a small, controlled YAML
// array whose top-level entries are blocks. This module merges at that block
// level:
//
//   user override = old user patch entry that differs from the old baseline
//   merged        = new baseline, with user overrides substituted by id
//
// App-owned `- insert:` blocks are never taken from the old patch; the new
// baseline wins, and a changed old insert is reported as skipped.
//
// Usage:
//   node scripts/merge-profile.mjs --old-patch <file> --old-baseline <file>
//        --new-baseline <file> --out <file> [--report <json-file>]
//
// Exit codes: 0 merged, 2 usage/input error, 3 merge produced no entries.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Split a patch file into its top-level YAML blocks. */
export function parsePatch(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const preamble = []
  const blocks = []
  let current = null

  const push = () => {
    if (current === null) return
    // Trim only trailing blank lines; keep internal comments/indentation intact.
    while (current.lines.length > 0 && current.lines.at(-1).trim() === '') current.lines.pop()
    blocks.push(current)
    current = null
  }

  for (const line of lines) {
    if (/^- /.test(line)) {
      push()
      current = {
        kind: line.startsWith('- insert:') ? 'insert' : 'id',
        id: null,
        lines: [line],
      }
    } else if (current === null) {
      preamble.push(line)
    } else {
      current.lines.push(line)
    }
  }
  push()

  for (const block of blocks) {
    if (block.kind !== 'id') continue
    const match = /^- id:\s*(.+?)\s*$/.exec(block.lines[0])
    if (match === null) throw new Error(`top-level id block has no id: ${block.lines[0]}`)
    block.id = match[1].replace(/^['"]|['"]$/g, '')
  }
  return { preamble, blocks }
}

function renderPatch(parsed) {
  const head = parsed.preamble.join('\n').replace(/\s+$/u, '')
  const body = parsed.blocks.map((block) => block.lines.join('\n')).join('\n\n')
  return `${head}${head.length > 0 ? '\n\n' : ''}${body}\n`
}

function byId(blocks) {
  const map = new Map()
  for (const block of blocks) {
    if (block.kind === 'id') map.set(block.id, block)
  }
  return map
}

/**
 * Merge old user patch over a new baseline.
 *
 * @param {{ oldPatch: string, oldBaseline: string, newBaseline: string }} inputs
 * @returns {{ text: string, report: object }}
 */
export function mergePatches(inputs) {
  const oldPatch = parsePatch(inputs.oldPatch)
  const oldBaseline = parsePatch(inputs.oldBaseline)
  const newBaseline = parsePatch(inputs.newBaseline)

  const oldBaseById = byId(oldBaseline.blocks)
  const newBaseById = byId(newBaseline.blocks)
  const oldPatchById = byId(oldPatch.blocks)

  const overrides = new Map()
  const replaced = []
  const appended = []
  const restored = []
  const oldPatchInserts = oldPatch.blocks
    .filter((block) => block.kind === 'insert')
    .map((block) => block.lines.join('\n'))
  const oldBaselineInserts = oldBaseline.blocks
    .filter((block) => block.kind === 'insert')
    .map((block) => block.lines.join('\n'))
  // App policy lives in the new baseline. Only a *changed* old insert is worth
  // reporting; an identical one is just the normal case and should not look like
  // a merge problem in the installer report.
  const skippedInserts = oldPatchInserts.filter(
    (text, index) => text !== oldBaselineInserts[index],
  ).length

  for (const block of oldPatch.blocks) {
    if (block.kind === 'insert') continue
    const baseline = oldBaseById.get(block.id)
    const oldText = block.lines.join('\n')
    if (baseline === undefined) {
      overrides.set(block.id, block)
      if (newBaseById.has(block.id)) {
        replaced.push(block.id)
      } else {
        appended.push(block.id)
      }
      continue
    }
    if (oldText === baseline.lines.join('\n')) continue // unchanged; new baseline wins
    overrides.set(block.id, block)
    if (newBaseById.has(block.id)) {
      replaced.push(block.id)
    } else {
      appended.push(block.id)
      restored.push(block.id)
    }
  }

  const mergedBlocks = []
  for (const block of newBaseline.blocks) {
    if (block.kind === 'id' && overrides.has(block.id)) {
      mergedBlocks.push(overrides.get(block.id))
    } else {
      mergedBlocks.push(block)
    }
  }
  for (const id of appended) {
    mergedBlocks.push(overrides.get(id))
  }

  if (mergedBlocks.length === 0) {
    throw new Error('merge produced no top-level blocks')
  }

  const text = renderPatch({ preamble: newBaseline.preamble, blocks: mergedBlocks })
  return {
    text,
    report: {
      schemaVersion: 1,
      oldPatchEntries: oldPatch.blocks.length,
      oldBaselineEntries: oldBaseline.blocks.length,
      newBaselineEntries: newBaseline.blocks.length,
      mergedEntries: mergedBlocks.length,
      replaced,
      appended,
      restored,
      skippedInserts,
    },
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    args[key] = value
    i += 1
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['old-patch', 'old-baseline', 'new-baseline', 'out']) {
    if (!args[required]) throw new Error(`--${required} is required`)
  }
  for (const key of ['old-patch', 'old-baseline', 'new-baseline']) {
    if (!existsSync(resolve(args[key]))) throw new Error(`--${key} does not exist: ${args[key]}`)
  }
  const result = mergePatches({
    oldPatch: readFileSync(resolve(args['old-patch']), 'utf8'),
    oldBaseline: readFileSync(resolve(args['old-baseline']), 'utf8'),
    newBaseline: readFileSync(resolve(args['new-baseline']), 'utf8'),
  })
  writeFileSync(resolve(args.out), result.text)
  if (args.report) writeFileSync(resolve(args.report), `${JSON.stringify(result.report, null, 2)}\n`)
  process.stdout.write(
    `merged -> ${args.out}: replaced=[${result.report.replaced.join(', ')}] ` +
      `appended=[${result.report.appended.join(', ')}] skippedInserts=${result.report.skippedInserts}\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`merge-profile: ${error.message}\n`)
    process.exit(2)
  }
}
