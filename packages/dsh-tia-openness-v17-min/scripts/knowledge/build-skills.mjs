#!/usr/bin/env node
/**
 * Vendors the upstream Siemens TIA Portal Openness skills into `skills/`, and
 * verifies that the vendored copy is still exactly upstream.
 *
 * Inputs (network only in the build direction):
 *   https://codeload.github.com/<repo>/tar.gz/<commit>   the pinned upstream tree
 *   skills/UPSTREAM.json                                 the generated record
 *   skills/tia-openness/SKILL.md                         this repository's router
 *
 * The knowledge base is what the plugin's bundled skill provider serves
 * (see `src/skills.ts`), so it must be reproducible: the commit is pinned here,
 * every vendored file is recorded with its SHA-256, and `--check` re-verifies
 * the bytes, the frontmatter, the layout, the upstream dependency graph and the
 * router's own freshness gate (every `<name>/SKILL.md` it references must
 * exist). A partially vendored or silently edited tree therefore cannot pass
 * `npm run check`.
 *
 * Only `tia-openness/SKILL.md` is ours; every other file is upstream verbatim
 * (MIT, Copyright (c) 2026 Siemens AG — see `skills/LICENSE.siemens.txt`).
 *
 * Usage:
 *   node scripts/knowledge/build-skills.mjs           # fetch and rewrite skills/
 *   node scripts/knowledge/build-skills.mjs --check   # offline: fail when stale
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SKILLS = join(REPO, 'skills')

/**
 * The pinned upstream revision. Bumping it is the only supported way to update
 * the knowledge base: change `commit`, run `npm run skills:build`, review the
 * diff of `UPSTREAM.json` and of `tia-openness/SKILL.md`.
 */
const UPSTREAM = {
  repo: 'siemens/tia-portal-ai-extensions',
  commit: 'b5c7041648dc10f9225ef082306ade6c335b8771',
  skillsDir: 'openness_development/skills',
  licensePath: 'LICENSE',
}

const MANIFEST = 'UPSTREAM.json'
const LICENSE_FILE = 'LICENSE.siemens.txt'
/** Skill directories owned by this repository; never touched by the sync. */
const LOCAL_SKILLS = ['tia-openness']
/** The one skill the plugin registers with the model (see src/skills.ts). */
const ROUTER_SKILL = 'tia-openness'
/**
 * The standard preset's tool-result pruner trims above this many code points
 * (`thresholdChars`), so a shipped skill body must stay below it to survive
 * condensation intact. The router is the only body the model sees by default.
 */
const MAX_ROUTER_CHARS = 8192
/**
 * `dsh-tool-skill`'s `catalogDescriptionMaxLength` default: the router's
 * description is what every session pays for in the durable catalog, so it must
 * fit in one capped entry.
 */
const MAX_CATALOG_DESCRIPTION_CHARS = 500
/** Upstream skills intentionally not vendored, with the reason recorded. */
const EXCLUDED = {
  'tia-addin-scaffold':
    'Openness AddIn / packaged-EXE scaffolding (assets/templates, references/). This plugin drives blocks through one ' +
    'fixed controller and never hosts an AddIn, so the skill and its ~30 KB of templates are dead weight.',
}

// ---------------------------------------------------------------------------
// tar reading
// ---------------------------------------------------------------------------

/** Reads a NUL-terminated (or field-bounded) string out of a tar header field. */
function cString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return buffer.toString('utf8', offset, stop).trim()
}

/** Parses the `len key=value\n` records of a pax extended header. */
function paxRecords(body) {
  const records = new Map()
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(body.toString('utf8', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > body.length) break
    const record = body.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

/**
 * Minimal tar reader: enough for `git archive` output (ustar with a global pax
 * header, pax `path` overrides, and optional GNU long names). Directories,
 * global headers and other metadata entries are skipped.
 *
 * @param {Buffer} archive - the *decompressed* tar stream.
 * @returns {Map<string, Buffer>} archive path → file contents.
 */
function parseTar(archive) {
  const files = new Map()
  let offset = 0
  let pending = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = cString(header, 0, 100)
    const sizeField = cString(header, 124, 12)
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156] ?? 48)
    const prefix = cString(header, 345, 155)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'x' || type === 'g') {
      const records = paxRecords(body)
      if (type === 'x' && records.has('path')) pending = records.get('path')
      continue
    }
    if (type === 'L') {
      pending = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type !== '0' && type !== '\0') continue

    files.set(pending ?? (prefix === '' ? name : `${prefix}/${name}`), Buffer.from(body))
    pending = null
  }
  return files
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Parses the top-level `key: value` pairs of a skill's YAML frontmatter. */
function frontmatter(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error(`${path}: SKILL.md has no YAML frontmatter`)
  const fields = new Map()
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (field !== null) fields.set(field[1], field[2].trim())
  }
  return fields
}

/** Validates one skill file and returns its frontmatter fields. */
function inspectSkill(path, raw, expectedName) {
  const fields = frontmatter(raw, path)
  const name = fields.get('name') ?? ''
  if (name !== expectedName) {
    throw new Error(`${path}: frontmatter name is "${name}", expected "${expectedName}"`)
  }
  const description = fields.get('description') ?? ''
  if (description.length === 0) throw new Error(`${path}: frontmatter has no description`)
  return fields
}

function readManifest() {
  const path = join(SKILLS, MANIFEST)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/** Every `skills/<dir>/SKILL.md` currently on disk, as a name → directory map. */
function diskSkillDirs() {
  const found = new Map()
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(SKILLS, entry.name, 'SKILL.md'))) found.set(entry.name, join(SKILLS, entry.name))
  }
  return found
}

/** The `<name>/SKILL.md` references a skill body makes, for the freshness gate. */
function referencedSkills(body) {
  return [...new Set([...body.matchAll(/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g)].map((match) => match[1]))]
}

// ---------------------------------------------------------------------------
// build (network)
// ---------------------------------------------------------------------------

/** Downloads and unpacks the pinned upstream tree. */
async function fetchUpstream() {
  const url = `https://codeload.github.com/${UPSTREAM.repo}/tar.gz/${UPSTREAM.commit}`
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-tia-openness-v17-min knowledge sync' } })
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  const archive = parseTar(gunzipSync(Buffer.from(await response.arrayBuffer())))

  const root = [...archive.keys()][0]?.split('/')[0]
  if (root === undefined) throw new Error('the upstream tarball is empty')

  const prefix = `${root}/${UPSTREAM.skillsDir}/`
  const skills = new Map()
  for (const [path, body] of archive) {
    const match = new RegExp(`^${prefix}([a-z0-9-]+)/SKILL\\.md$`).exec(path)
    if (match === null || Object.hasOwn(EXCLUDED, match[1])) continue
    skills.set(match[1], body)
  }
  const license = archive.get(`${root}/${UPSTREAM.licensePath}`)
  if (license === undefined) throw new Error(`the upstream tarball has no ${UPSTREAM.licensePath}`)
  if (skills.size === 0) throw new Error(`the upstream tarball has no skills below ${UPSTREAM.skillsDir}`)
  return { skills, license }
}

async function build() {
  const { skills, license } = await fetchUpstream()
  const previous = readManifest()
  const names = [...skills.keys()].sort()

  const manifestSkills = {}
  for (const name of names) {
    const body = skills.get(name)
    const path = join(SKILLS, name, 'SKILL.md')
    mkdirSync(join(SKILLS, name), { recursive: true })
    writeFileSync(path, body)

    const fields = inspectSkill(relative(REPO, path), body.toString('utf8'), name)
    manifestSkills[name] = {
      file: `${name}/SKILL.md`,
      sha256: sha256(body),
      bytes: body.length,
      description: fields.get('description') ?? '',
    }
  }

  writeFileSync(join(SKILLS, LICENSE_FILE), license)
  const manifest = {
    $comment:
      'Generated by scripts/knowledge/build-skills.mjs — do not edit. The vendored skills are upstream verbatim; ' +
      `only ${ROUTER_SKILL}/SKILL.md is maintained by this repository.`,
    repo: `https://github.com/${UPSTREAM.repo}`,
    commit: UPSTREAM.commit,
    skillsDir: UPSTREAM.skillsDir,
    license: {
      spdx: 'MIT',
      copyright: '2026 Siemens AG',
      source: UPSTREAM.licensePath,
      vendoredAs: LICENSE_FILE,
      sha256: sha256(license),
      bytes: license.length,
    },
    localSkills: LOCAL_SKILLS,
    excluded: EXCLUDED,
    skills: manifestSkills,
  }
  writeFileSync(join(SKILLS, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)

  // Prune skill directories that upstream no longer has (or that a new
  // exclusion dropped), then report the delta against the previous manifest.
  const planned = new Set([...names, ...LOCAL_SKILLS])
  const discarded = []
  for (const [name, directory] of diskSkillDirs()) {
    if (planned.has(name)) continue
    rmSync(directory, { recursive: true, force: true })
    discarded.push(name)
  }

  const changes = []
  for (const name of names) {
    const previousRecord = previous?.skills?.[name]
    if (previousRecord === undefined) changes.push(`+ ${name}`)
    else if (previousRecord.sha256 !== manifestSkills[name].sha256) changes.push(`~ ${name}`)
  }
  for (const name of new Set([...discarded, ...Object.keys(previous?.skills ?? {})])) {
    if (manifestSkills[name] === undefined) changes.push(`- ${name}`)
  }

  process.stdout.write(
    `Wrote ${relative(REPO, join(SKILLS, MANIFEST))} and ${names.length} upstream skills at ${UPSTREAM.commit.slice(0, 7)}\n` +
      `  license ${LICENSE_FILE} (MIT, 2026 Siemens AG)\n` +
      `  excluded ${Object.keys(EXCLUDED).join(', ') || '(none)'}; local ${LOCAL_SKILLS.join(', ')}\n` +
      (changes.length === 0 ? '  no change\n' : changes.map((change) => `  ! ${change}\n`).join('')),
  )
}

// ---------------------------------------------------------------------------
// check (offline)
// ---------------------------------------------------------------------------

function check() {
  const problems = []
  const manifest = readManifest()
  if (manifest === null) {
    process.stderr.write(`✗ skills/${MANIFEST} is missing. Run: npm run skills:build\n`)
    process.exitCode = 1
    return
  }

  const fail = (message) => problems.push(message)
  if (manifest.repo !== `https://github.com/${UPSTREAM.repo}` || manifest.commit !== UPSTREAM.commit) {
    fail(
      `skills/${MANIFEST} records ${manifest.repo}@${manifest.commit}, but this script pins ${UPSTREAM.repo}@${UPSTREAM.commit} — ` +
        'run npm run skills:build',
    )
  }

  const vendored = Object.entries(manifest.skills ?? {})
  for (const [name, record] of vendored) {
    const path = join(SKILLS, name, 'SKILL.md')
    if (!existsSync(path)) {
      fail(`${record.file} is missing`)
      continue
    }
    const body = readFileSync(path)
    if (sha256(body) !== record.sha256) fail(`${record.file} does not match its recorded sha256 — the vendored copy was edited`)
    if (body.length !== record.bytes) fail(`${record.file} is ${body.length} bytes, recorded ${record.bytes}`)
    try {
      inspectSkill(record.file, body.toString('utf8'), name)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  const licensePath = join(SKILLS, LICENSE_FILE)
  if (!existsSync(licensePath)) fail(`${LICENSE_FILE} is missing`)
  else if (sha256(readFileSync(licensePath)) !== manifest.license?.sha256) fail(`${LICENSE_FILE} does not match its recorded sha256`)

  const planned = new Set([...vendored.map(([name]) => name), ...(manifest.localSkills ?? [])])
  for (const [name, directory] of diskSkillDirs()) {
    if (planned.has(name)) continue
    fail(`${relative(REPO, directory)} is not in ${MANIFEST} — either it is a leftover or the manifest is stale`)
  }

  // The upstream dependency graph must survive the vendoring: a skill that
  // references a sibling we chose not to vendor is a broken knowledge base.
  const known = new Set(vendored.map(([name]) => name))
  for (const [name, record] of vendored) {
    const fields = frontmatter(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8'), record.file)
    for (const dependency of (fields.get('siemens-depends-on') ?? '').replaceAll('"', '').split(',')) {
      const trimmed = dependency.trim()
      if (trimmed.length > 0 && !known.has(trimmed)) fail(`${record.file} depends on "${trimmed}", which is not vendored`)
    }
  }

  const routerPath = join(SKILLS, ROUTER_SKILL, 'SKILL.md')
  if (!existsSync(routerPath)) {
    fail(`${ROUTER_SKILL}/SKILL.md is missing`)
  } else {
    const raw = readFileSync(routerPath, 'utf8')
    let description = ''
    try {
      description = inspectSkill(`${ROUTER_SKILL}/SKILL.md`, raw, ROUTER_SKILL).get('description') ?? ''
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    if (raw.length > MAX_ROUTER_CHARS) {
      fail(`${ROUTER_SKILL}/SKILL.md is ${raw.length} characters; the preset prunes skill results above ${MAX_ROUTER_CHARS}`)
    }
    if (description.length > MAX_CATALOG_DESCRIPTION_CHARS) {
      fail(
        `${ROUTER_SKILL}/SKILL.md has a ${description.length}-character description; the session catalog renders at most ` +
          `${MAX_CATALOG_DESCRIPTION_CHARS}`,
      )
    }
    for (const reference of referencedSkills(raw)) {
      if (!known.has(reference)) fail(`${ROUTER_SKILL}/SKILL.md references ${reference}/SKILL.md, which does not exist`)
    }
    if (!/^name: tia-openness\r?\n/m.test(raw)) fail(`${ROUTER_SKILL}/SKILL.md frontmatter no longer declares the documented name`)
  }

  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`)
  if (problems.length > 0) {
    process.stderr.write(`✗ skills/ is stale or inconsistent (${problems.length} problem(s)). Run: npm run skills:build\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `✓ skills/ is current: ${vendored.length} upstream skills at ${UPSTREAM.commit.slice(0, 7)}, ` +
      `${ROUTER_SKILL}/SKILL.md ${readFileSync(routerPath, 'utf8').length} chars, sha256 verified\n`,
  )
}

async function main() {
  if (process.argv.includes('--check')) check()
  else await build()
}

await main()
