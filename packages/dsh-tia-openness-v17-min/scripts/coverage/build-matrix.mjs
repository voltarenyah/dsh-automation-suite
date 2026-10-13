#!/usr/bin/env node
/**
 * Builds `docs/coverage-matrix.html` — the foldable TIA Portal Openness V17
 * coverage matrix — and verifies it is still current.
 *
 * Inputs:
 *   docs/coverage-matrix.sources.json  machine snapshot of the API surface and
 *                                      the manual TOC (see extract-sources.mjs)
 *   scripts/coverage/matrix-data.mjs   the hand-maintained analysis
 *   controller/*.cs, src/*.ts          the live plugin sources
 *
 * The page therefore follows the code: re-running this script recomputes which
 * Openness types the controller references, the operation/tool inventory and
 * every coverage number. It also cross-checks the curated analysis against the
 * code and fails when the two disagree, so the page cannot silently rot.
 *
 * Usage:
 *   node scripts/coverage/build-matrix.mjs            # (re)generate the page
 *   node scripts/coverage/build-matrix.mjs --check    # fail if the page is stale
 *   node scripts/coverage/build-matrix.mjs --out <file>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AMBIGUOUS_NAMES, COMPILE, PRECONDITIONS, REFUSALS, SECTIONS, STATUS, TOOL_GAPS } from './matrix-data.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCES = join(REPO, 'docs', 'coverage-matrix.sources.json')
const OUT_DEFAULT = join(REPO, 'docs', 'coverage-matrix.html')
const PATH_SEP = ' > '

// ---------------------------------------------------------------------------
// code scan
// ---------------------------------------------------------------------------

/**
 * Collapses CRLF to LF.
 *
 * Every comparison in this script goes through it, because `.gitattributes`
 * pins `*.cs` to CRLF: the code a checkout holds is the same code, but not the
 * same bytes, depending on whether the working copy was ever re-checked-out.
 * A fingerprint or a staleness check that depended on that would fail on every
 * fresh clone.
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Replaces comments and string literals with spaces so that a word-boundary
 * search cannot match prose. Keeps offsets irrelevant (we only count).
 */
export function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
    } else if (c === '@' && next === '"') {
      i += 2
      while (i < n) {
        if (source[i] === '"' && source[i + 1] === '"') i += 2
        else if (source[i] === '"') { i++; break }
        else i++
      }
      out += ' '
    } else if (c === '"') {
      i++
      while (i < n) {
        if (source[i] === '\\') i += 2
        else if (source[i] === '"') { i++; break }
        else i++
      }
      out += ' '
    } else if (c === "'") {
      i++
      while (i < n) {
        if (source[i] === '\\') i += 2
        else if (source[i] === "'") { i++; break }
        else i++
      }
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Reads the repository's own sources: controller C# plus the TypeScript half. */
function readSources() {
  const controllerDir = join(REPO, 'controller')
  const csFiles = readdirSync(controllerDir)
    .filter((name) => name.endsWith('.cs'))
    .sort()
    .map((name) => join(controllerDir, name))
  const tsDir = join(REPO, 'src')
  const tsFiles = readdirSync(tsDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => join(tsDir, name))

  const csText = csFiles.map((file) => stripCommentsAndStrings(readFileSync(file, 'utf8'))).join('\n')
  const tsRaw = {}
  for (const file of tsFiles) tsRaw[file] = readFileSync(file, 'utf8')

  const fingerprint = createHash('sha256')
  for (const file of [...csFiles, ...tsFiles, join(REPO, 'scripts', 'coverage', 'matrix-data.mjs')]) {
    fingerprint.update(relative(REPO, file)).update('\0').update(normalizeEol(readFileSync(file, 'utf8'))).update('\0')
  }

  return { csFiles, tsFiles, csText, tsRaw, fingerprint: fingerprint.digest('hex').slice(0, 16) }
}

/**
 * Which Openness types does the controller reference, per namespace?
 *
 * Matching is scoped by the `using` directives of each C# file: a type only
 * counts when the file that mentions it imports the namespace declaring it.
 * That is both narrower than a global word search (a same-named field or an
 * unrelated `Software` identifier does not leak in) and wider than requiring
 * short names to be globally unique (`FB`, `FC`, `OB`, `PlcStruct` are used for
 * real and must count).
 */
function scanApiUsage(sources, api) {
  const referenced = new Map()
  const excluded = new Set()
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

  for (const file of sources.csFiles) {
    const raw = readFileSync(file, 'utf8')
    const text = stripCommentsAndStrings(raw)
    const usings = new Set([...raw.matchAll(/^using\s+(Siemens\.Engineering[A-Za-z0-9_.]*)\s*;/gm)].map((m) => m[1]))
    for (const ns of usings) {
      const names = api.namespaces[ns]
      if (names === undefined) continue
      for (const short of names) {
        if (!identifier.test(short)) continue
        if (!new RegExp(`\\b${short}\\b`).test(text)) continue
        if (Object.hasOwn(AMBIGUOUS_NAMES, short)) {
          excluded.add(short)
          continue
        }
        referenced.set(short, ns)
      }
    }
  }

  return { referenced, excluded: [...excluded].sort() }
}

function scanInventory(sources) {
  const protocolCs = readFileSync(join(REPO, 'controller', 'Protocol.cs'), 'utf8')
  const namesArray = /Names\s*=\s*\{([^}]*)\}/.exec(protocolCs)
  const operations = namesArray === null
    ? []
    : namesArray[1].split(',').map((value) => value.trim()).filter((value) => value.length > 0)

  const protocolTs = sources.tsRaw[join(REPO, 'src', 'protocol.ts')] ?? ''
  const tsOperations = [...(/OPERATIONS\s*=\s*\[([^\]]*)\]/.exec(protocolTs)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])

  const toolsTs = sources.tsRaw[join(REPO, 'src', 'tools.ts')] ?? ''
  const tools = [...toolsTs.matchAll(/^\s*name:\s*'([a-z0-9_]+)'/gm)].map((m) => m[1])

  return { operations, tsOperations, tools }
}

// ---------------------------------------------------------------------------
// matrix assembly
// ---------------------------------------------------------------------------

/** Walks the manual TOC and finds the node a section path points at. */
function locate(roots, path) {
  let level = roots
  let node = null
  for (const title of path) {
    node = level.find((candidate) => candidate.title === title) ?? null
    if (node === null) return null
    level = node.children
  }
  return node
}

/** The capability rows of a manual node: its leaf descendants, or itself. */
function itemsOf(node) {
  if (node.children.length === 0) return [node]
  const items = []
  const visit = (current) => {
    if (current.children.length === 0) items.push(current)
    else current.children.forEach(visit)
  }
  node.children.forEach(visit)
  return items
}

const SECTION_BY_PATH = new Map(SECTIONS.map((section) => [section.path.join(PATH_SEP), section]))

/**
 * Inherited context before any modelled section is reached (and for the
 * branches the matrix does not model). Everything is "not an API capability".
 */
const NEUTRAL_SECTION = {
  path: ['(unmodelled)'],
  api: [],
  compile: 'na',
  pre: [],
  reject: [],
  default: 'na',
  note: '',
  exposed: true,
  leaves: {},
}

/**
 * Counts the capability rows under a node and derives the node's own status.
 *
 * An explicit status (a section or a group override) wins; otherwise the status
 * follows its items: all done → 已适配, none done → 未适配, anything between →
 * 部分. `na` only survives when every item is non-API.
 */
function aggregate(row) {
  if (row.children.length === 0) {
    row.counts = {
      total: 1,
      done: row.status === 'done' ? 1 : 0,
      partial: row.status === 'partial' ? 1 : 0,
      none: row.status === 'none' ? 1 : 0,
      na: row.status === 'na' ? 1 : 0,
    }
    return row.counts
  }
  const counts = { total: 0, done: 0, partial: 0, none: 0, na: 0 }
  for (const child of row.children) {
    const childCounts = aggregate(child)
    for (const key of Object.keys(counts)) counts[key] += childCounts[key]
  }
  if (row.status === null) {
    const scored = counts.done + counts.partial
    row.status = counts.total === counts.na ? 'na' : scored === 0 ? 'none' : scored === counts.total ? 'done' : 'partial'
  }
  row.counts = counts
  return counts
}

function assigned(value, fallback) {
  return value === undefined ? fallback : value
}

/** Guards the curated data: an unknown code would otherwise render as `undefined`. */
function validateCodes() {
  const errors = []
  for (const section of SECTIONS) {
    const entries = [
      { where: section.path.join(' / '), pre: section.pre ?? [], reject: section.reject ?? [], status: section.default },
      ...Object.entries(section.leaves ?? {}).map(([title, leaf]) => ({
        where: `${section.path.join(' / ')} → ${title}`,
        pre: leaf.pre ?? [],
        reject: leaf.reject ?? [],
        status: leaf.status,
      })),
    ]
    for (const entry of entries) {
      for (const code of entry.pre) {
        if (!Object.hasOwn(PRECONDITIONS, code)) errors.push(`${entry.where}: 前置条件代码 "${code}" 不存在`)
      }
      for (const code of entry.reject) {
        if (!Object.hasOwn(REFUSALS, code)) errors.push(`${entry.where}: 限制代码 "${code}" 不存在`)
      }
      if (entry.status !== undefined && !Object.hasOwn(STATUS, entry.status)) {
        errors.push(`${entry.where}: 状态 "${entry.status}" 不存在`)
      }
    }
  }
  return errors
}

/** Builds the annotated row tree: root → manual branch → section → capability. */
function buildRows(sources, api, usage) {
  const errors = [...validateCodes()]
  const warnings = []
  const usedOverrides = new Set()

  // The manual TOC snapshot keeps its own root ("Openness: Automating creation
  // of projects"); the matrix starts one level below, at the eight branches.
  const top = api.tocRoots.flatMap((root) => root.children)

  /** Applies a curated override to the inherited context for one node/subtree. */
  const withOverride = (ctx, title) => {
    const override = ctx.section?.leaves?.[title]
    if (override === undefined) return { ctx, override: undefined }
    usedOverrides.add(`${ctx.section.path.join(PATH_SEP)}\u0000${title}`)
    return {
      override,
      ctx: {
        ...ctx,
        section: {
          ...ctx.section,
          default: assigned(override.status, ctx.section.default),
          compile: assigned(override.compile, ctx.section.compile),
          pre: assigned(override.pre, ctx.section.pre),
          reject: assigned(override.reject, ctx.section.reject),
          note: assigned(override.note, ctx.section.note),
          exposed: assigned(override.exposed, ctx.section.exposed ?? true),
        },
      },
    }
  }

  const leafRow = (node, ctx, isSection, override) => ({
    kind: ctx.section.default === 'na' ? 'leaf-na' : 'leaf',
    isSection,
    title: node.title,
    status: ctx.section.default,
    compile: ctx.section.compile,
    pre: ctx.section.pre,
    reject: ctx.section.reject,
    ownPre: override?.pre,
    ownReject: override?.reject,
    note: ctx.section.note ?? '',
    exposed: ctx.section.exposed ?? true,
    api: isSection ? ctx.section.api : [],
    section: ctx.section,
    children: [],
  })

  const walk = (node, path, ctx, depth) => {
    const section = SECTION_BY_PATH.get(path.join(PATH_SEP)) ?? null
    const base = section === null ? ctx : { ...ctx, section }
    const { ctx: nodeCtx, override } = withOverride(base, node.title)
    const isSection = section !== null

    if (node.children.length === 0) return leafRow(node, nodeCtx, isSection, override)

    return {
      kind: isSection ? 'section' : depth <= 2 ? 'branch' : 'group',
      isSection,
      title: node.title,
      status: null, // derived from the items below by aggregate()
      compile: nodeCtx.section.compile,
      pre: nodeCtx.section.pre,
      reject: nodeCtx.section.reject,
      note: override?.note ?? (isSection ? section.note : ''),
      exposed: true,
      api: isSection ? section.api : [],
      section: nodeCtx.section,
      node,
      children: node.children.map((child) => walk(child, [...path, child.title], nodeCtx, depth + 1)),
    }
  }

  const rows = top.map((branch) => walk(branch, [branch.title], { section: NEUTRAL_SECTION }, 2))
  for (const row of rows) aggregate(row)

  // Every section must resolve; a manual update has to break the build, not the page.
  const sectionTitles = new Set(SECTIONS.map((section) => section.path.join(PATH_SEP)))
  for (const section of SECTIONS) {
    if (locate(top, section.path) === null) {
      errors.push(`章节路径在手册目录里找不到：${section.path.join(' / ')}（matrix-data.mjs 的 path 需要更新）`)
    }
  }
  const reached = new Set()
  const collect = (row) => {
    if (row.section !== undefined && row.section !== null) reached.add(row.section.path.join(PATH_SEP))
    row.children.forEach(collect)
  }
  rows.forEach(collect)
  for (const title of sectionTitles) {
    if (!reached.has(title)) errors.push(`matrix-data.mjs 里的章节未被目录树命中：${title.replace(PATH_SEP, ' / ')}`)
  }

  const overrideWarnings = []
  for (const section of SECTIONS) {
    for (const title of Object.keys(section.leaves ?? {})) {
      if (!usedOverrides.has(`${section.path.join(PATH_SEP)}\u0000${title}`)) {
        overrideWarnings.push(`叶条目覆盖未命中：${section.path.join(' / ')} → "${title}"`)
      }
    }
  }
  warnings.push(...overrideWarnings)

  return { rows, errors, warnings }
}

/** Flattens the row tree for counting and rendering. */
function flatten(rows) {
  const flat = []
  const visit = (row, depth, parentId) => {
    const id = String(flat.length)
    flat.push({ ...row, id, depth, parentId })
    for (const child of row.children) visit(child, depth + 1, id)
  }
  for (const row of rows) visit(row, 1, '')
  return flat
}

/** Namespaces referenced by at least one type, per namespace. */
function namespaceUsage(api, usage) {
  const result = new Map()
  for (const ns of Object.keys(api.namespaces)) result.set(ns, { total: 0, referenced: 0 })
  for (const [ns, names] of Object.entries(api.namespaces)) {
    const unique = names.filter((short) => countNames(api, short) === 1)
    result.get(ns).total = unique.length
  }
  for (const [short, ns] of usage.referenced) {
    if (result.has(ns) && countNames(api, short) === 1) result.get(ns).referenced++
  }
  return result
}

let NAME_INDEX = null
function countNames(api, short) {
  if (NAME_INDEX === null) {
    NAME_INDEX = new Map()
    for (const names of Object.values(api.namespaces)) {
      for (const name of names) NAME_INDEX.set(name, (NAME_INDEX.get(name) ?? 0) + 1)
    }
  }
  return NAME_INDEX.get(short) ?? 0
}

function coverageFor(section, api, nsUsage) {
  if (section === null || section.api.length === 0) return null
  const totals = { total: 0, referenced: 0 }
  for (const ns of section.api) {
    const entry = nsUsage.get(ns)
    if (entry === undefined) continue
    totals.total += entry.total
    totals.referenced += entry.referenced
  }
  return totals
}

/**
 * Cross-checks the curated analysis against the code scan. These are the
 * findings that make the page fail its `--check` instead of rotting.
 */
function consistencyChecks(rows, api, usage, sources, inventory, nsUsage) {
  const errors = []
  const warnings = []

  // A namespace the code now uses, while every section mapping it says "未适配".
  const sectionsByNamespace = new Map()
  for (const section of SECTIONS) {
    for (const ns of section.api) {
      const bucket = sectionsByNamespace.get(ns) ?? []
      bucket.push(section)
      sectionsByNamespace.set(ns, bucket)
    }
  }
  const adapted = new Set()
  const visit = (row) => {
    if (row.children.length === 0 && (row.status === 'done' || row.status === 'partial') && row.section !== undefined && row.section !== null) {
      adapted.add(row.section.path.join(PATH_SEP))
    }
    row.children.forEach(visit)
  }
  rows.forEach(visit)

  const usedNamespaces = new Set([...usage.referenced.values()])
  for (const ns of usedNamespaces) {
    const owners = sectionsByNamespace.get(ns) ?? []
    if (owners.length === 0) {
      errors.push(`代码引用了命名空间 ${ns}，但没有任何已建模章节映射它 —— 请更新 matrix-data.mjs`)
      continue
    }
    const anyAdapted = owners.some((section) => adapted.has(section.path.join(PATH_SEP)))
    if (!anyAdapted) {
      errors.push(
        `代码已引用 ${ns} 下的类型（${nsUsage.get(ns)?.referenced ?? 0} 个），但映射它的章节全部标记为未适配：` +
          owners.map((section) => section.path.join(' / ')).join('、'),
      )
    }
  }

  // A section that claims adaptation while none of its namespaces is used.
  for (const section of SECTIONS) {
    if (!adapted.has(section.path.join(PATH_SEP))) continue
    if (section.api.length === 0) continue
    const used = section.api.some((ns) => (nsUsage.get(ns)?.referenced ?? 0) > 0)
    if (!used) {
      errors.push(`章节「${section.path.join(' / ')}」标记为已适配，但其命名空间没有任何类型被代码引用 —— 状态已过期`)
    }
  }

  for (const short of usage.excluded) {
    if (!new RegExp(`\\b${short}\\b`).test(sources.csText)) {
      errors.push(`matrix-data.mjs 的 AMBIGUOUS_NAMES 里 "${short}" 已不再出现在控制器代码中 —— 排除项已过期，可以删除`)
    }
  }
  const missingExclusions = Object.keys(AMBIGUOUS_NAMES).filter((short) => !usage.excluded.includes(short))
  for (const short of missingExclusions) {
    warnings.push(`排除项 "${short}" 当前没有命中任何 Openness 同名类型；若类型已删除可一并删除该排除项。`)
  }

  const toolsTs = sources.tsRaw[join(REPO, 'src', 'tools.ts')] ?? ''
  for (const gap of TOOL_GAPS) {
    if (toolsTs.includes(gap.probe)) {
      errors.push(
        `DSH 工具已经暴露了「${gap.parameter}」(${gap.probe}) —— matrix-data.mjs 的 TOOL_GAPS 提示与网页上的 "CLI" 标记已过期`,
      )
    }
  }

  const a = [...inventory.operations].sort().join(',')
  const b = [...inventory.tsOperations].sort().join(',')
  if (a !== b) {
    errors.push(`OperationCatalog（controller/Protocol.cs: ${a}）与 src/protocol.ts 的 OPERATIONS（${b}）不一致`)
  }

  if (api.typeCount === 0) errors.push('API 快照里没有类型 —— docs/coverage-matrix.sources.json 需要重新生成')
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** One-line summary of a note, for the visible cell (full text stays in the tooltip). */
function short(text, max = 72) {
  const first = text.split('\n')[0]
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

function chipList(codes, table) {
  if (codes.length === 0) return '<span class="dash">—</span>'
  return codes
    .map((code) => {
      const entry = table[code]
      return `<span class="chip tip" tabindex="0" data-tip="${esc(entry.text)}">${esc(code)} <span class="chip-label">${esc(entry.label)}</span></span>`
    })
    .join('')
}

/**
 * A capability row shows only the codes it adds itself; the ones it inherits
 * from its section are folded into one marker (hover lists them), so a section
 * with five restrictions does not repeat them on all 80 of its rows.
 */
function itemChipList(own, inherited, table) {
  if (own !== undefined && own.length > 0) return chipList(own, table)
  if (inherited.length === 0) return '<span class="dash">—</span>'
  const text = `继承本章节：${inherited.map((code) => `${code} ${table[code].label}`).join('、')}`
  return `<span class="chip inherit tip" tabindex="0" data-tip="${esc(text)}">↳ <span class="chip-label">继承</span></span>`
}

function statusBadge(status, counts) {
  const meta = STATUS[status]
  const label = meta === undefined ? status : meta.label
  const tip = counts === undefined || counts === null
    ? ''
    : `已适配 ${counts.done} · 部分 ${counts.partial} · 未适配 ${counts.none} · 不适用 ${counts.na}`
  return `<span class="badge s-${esc(status)} tip" tabindex="0" data-tip="${esc(tip)}">${esc(label)}</span>`
}

function bar(counts) {
  if (counts.total === 0) return ''
  const part = (value) => `${((value / counts.total) * 100).toFixed(1)}%`
  return (
    `<span class="bar" aria-hidden="true">` +
    `<i class="b-done" style="width:${part(counts.done)}"></i>` +
    `<i class="b-partial" style="width:${part(counts.partial)}"></i>` +
    `<i class="b-none" style="width:${part(counts.none)}"></i>` +
    `<i class="b-na" style="width:${part(counts.na)}"></i>` +
    `</span>`
  )
}

function renderRow(row, api, nsUsage) {
  const isItem = row.children.length === 0
  const classes = ['row', `lvl-${row.depth}`, row.kind]
  if (row.isSection === true) classes.push('section')
  if (row.depth >= 4) classes.push('collapsed-by-default')
  if (row.status !== null && row.status !== undefined) classes.push(`st-${row.status}`)

  const caret = isItem
    ? '<span class="caret-space"></span>'
    : `<button class="caret" type="button" aria-expanded="${row.depth < 2}" aria-label="展开/折叠">${row.depth < 2 ? '▾' : '▸'}</button>`

  const counts = row.counts ?? { total: 1, done: 0, partial: 0, none: 0, na: 0 }
  const nameCell =
    `<span class="title">${esc(row.title)}</span>` +
    (isItem ? '' : `<span class="sub">${counts.total} 条能力</span>`) +
    (isItem && row.exposed === false ? ` <span class="chip cli tip" tabindex="0" data-tip="控制器已实现，但 DSH 工具未暴露该参数：只能通过控制器 CLI（--operation … --param …）调用。">仅 CLI</span>` : '')

  const coverage = row.api.length > 0 ? coverageFor(row.section ?? null, api, nsUsage) : null
  const apiCell = row.api.length === 0
    ? '<span class="dash">—</span>'
    : row.api
        .map((ns) => `<code>${esc(ns.replace(/^Siemens\.Engineering\.?/, '') || 'core')}</code>`)
        .join(' ') +
      (coverage === null ? '' : ` <span class="num tip" tabindex="0" data-tip="映射的命名空间里，被控制器引用的唯一名类型数 / 该命名空间唯一名类型总数。">${coverage.referenced}/${coverage.total}</span>`)

  const compileCell = row.compile === undefined
    ? '<span class="dash">—</span>'
    : `<span class="compile c-${esc(row.compile)} tip" tabindex="0" data-tip="${esc(COMPILE[row.compile].text)}">${esc(COMPILE[row.compile].label)}</span>`

  const statusCell = row.status === null || row.status === undefined
    ? '<span class="dash">—</span>'
    : `${statusBadge(row.status, row.counts)} ${bar(counts)}`

  const note = row.note ?? ''
  const noteCell = note.length === 0
    ? '<span class="dash">—</span>'
    : `<span class="tip note" tabindex="0" data-tip="${esc(note)}">${esc(short(note))}</span>`

  return (
    `<tr class="${classes.join(' ')}" id="r${row.id}" data-id="${row.id}" data-parent="${esc(row.parentId)}" data-depth="${row.depth}" ` +
    `data-status="${esc(row.status ?? 'na')}" data-title="${esc(row.title.toLowerCase())}" data-cli="${row.exposed === false ? '1' : '0'}"` +
    `${row.depth >= 3 ? ' hidden' : ''}>` +
    `<td class="c-caret">${caret}</td>` +
    `<td class="c-name">${nameCell}</td>` +
    `<td class="c-num">${isItem ? '<span class="dash">—</span>' : `<span class="num">${counts.total}</span>`}</td>` +
    `<td class="c-api">${apiCell}</td>` +
    `<td class="c-compile">${compileCell}</td>` +
    `<td class="c-pre">${isItem ? itemChipList(row.ownPre, row.pre ?? [], PRECONDITIONS) : chipList(row.pre ?? [], PRECONDITIONS)}</td>` +
    `<td class="c-reject">${isItem ? itemChipList(row.ownReject, row.reject ?? [], REFUSALS) : chipList(row.reject ?? [], REFUSALS)}</td>` +
    `<td class="c-status">${statusCell}</td>` +
    `<td class="c-note">${noteCell}</td>` +
    `</tr>`
  )
}

/** The types the code scan found, grouped by the namespace they come from. */
function renderReferenced(usage) {
  const byNamespace = new Map()
  for (const [short, ns] of usage.referenced) {
    const bucket = byNamespace.get(ns) ?? []
    bucket.push(short)
    byNamespace.set(ns, bucket)
  }
  return [...byNamespace.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([ns, names]) => {
      const label = ns.replace(/^Siemens\.Engineering\.?/, '') || 'Siemens.Engineering'
      return (
        `<p style="margin:8px 0 0"><b>${esc(label)}</b> <span class="num">${names.length}</span><br>` +
        names.sort().map((name) => `<code>${esc(name)}</code>`).join(' ') +
        `</p>`
      )
    })
    .join('')
}

function renderLegend() {  const pre = Object.entries(PRECONDITIONS)
    .map(([code, entry]) => `<dt>${esc(code)} · ${esc(entry.label)}</dt><dd>${esc(entry.text)}</dd>`)
    .join('')
  const reject = Object.entries(REFUSALS)
    .map(([code, entry]) => `<dt>${esc(code)} · ${esc(entry.label)}</dt><dd>${esc(entry.text)}</dd>`)
    .join('')
  return (
    `<div class="legend">` +
    `<section><h3>前置条件</h3><dl>${pre}</dl></section>` +
    `<section><h3>手册明示的限制 / 直接拒绝</h3><dl>${reject}</dl></section>` +
    `</div>`
  )
}

function renderPage(model) {
  const { flat, api, manual, sources, usage, inventory, nsUsage, summary, warnings, errors } = model
  const rowsHtml = flat.map((row) => renderRow(row, api, nsUsage)).join('\n')

  const warningHtml =
    errors.length + warnings.length === 0
      ? '<p class="ok">✓ 一致性检查全部通过：手工分析、代码引用与快照三者一致。</p>'
      : `<ul class="findings">` +
        errors.map((text) => `<li class="e">✗ ${esc(text)}</li>`).join('') +
        warnings.map((text) => `<li class="w">! ${esc(text)}</li>`).join('') +
        `</ul>`

  const excluded = Object.entries(AMBIGUOUS_NAMES)
    .map(([short, reason]) => `<li><code>${esc(short)}</code> —— ${esc(reason)}</li>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TIA Portal Openness V17 能力覆盖矩阵 · TIAOpennessV17Min</title>
<meta name="dsh-matrix-fingerprint" content="${esc(sources.fingerprint)}">
<style>
:root{
  --bg:#f7f8fa; --panel:#fff; --ink:#1c2128; --muted:#5b6673; --line:#dde2e8; --line-strong:#c3ccd6;
  --done:#1a7f4b; --done-bg:#e6f4ec; --partial:#9a6400; --partial-bg:#fdf3e0; --none:#8b3a3a; --none-bg:#fbeaea;
  --na:#6b7480; --na-bg:#eef1f4; --accent:#0b5cad; --cli:#6b4fa8; --cli-bg:#f0ebfa;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#14181d; --panel:#1b2027; --ink:#e6ebf1; --muted:#9aa6b3; --line:#2b323b; --line-strong:#3b444f;
    --done:#5fd39a; --done-bg:#16301f; --partial:#e8bd6a; --partial-bg:#33290f; --none:#e58a8a; --none-bg:#331a1a;
    --na:#9aa6b3; --na-bg:#242a32; --accent:#6cb6ff; --cli:#b9a5ef; --cli-bg:#271f3a;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:24px;margin:0 0 6px}
h2{font-size:17px;margin:34px 0 10px}
h3{font-size:14px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
p.sub{color:var(--muted);margin:0 0 18px}
a{color:var(--accent)}
code{font-family:var(--mono);font-size:12px;background:var(--na-bg);padding:1px 5px;border-radius:4px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 22px;font-size:13px;color:var(--muted)}
.meta b{color:var(--ink);font-weight:600}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:var(--muted);letter-spacing:.03em}
.card .v{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin:4px 0 2px}
.card .d{font-size:12px;color:var(--muted)}
.toolbar{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}
input[type=search]{flex:0 1 260px;padding:7px 10px;border:1px solid var(--line-strong);border-radius:7px;background:var(--panel);color:var(--ink);font-size:13px}
button{font:inherit;font-size:13px;padding:6px 11px;border:1px solid var(--line-strong);border-radius:7px;background:var(--panel);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent)}
.filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.filters label{display:flex;gap:5px;align-items:center;cursor:pointer}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
thead th{position:sticky;top:var(--toolbar-h,57px);background:var(--panel);text-align:left;font-size:12px;letter-spacing:.03em;color:var(--muted);padding:9px 10px;border-bottom:1px solid var(--line-strong);white-space:nowrap;z-index:10}
tbody td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13.5px}
tr[hidden]{display:none}
.c-caret{width:26px;padding-right:0}
.caret{border:none;background:none;padding:0;width:20px;height:20px;line-height:1;color:var(--muted);font-size:12px}
.caret:hover{color:var(--accent)}
.caret-space{display:inline-block;width:20px}
.c-name{min-width:290px}
.c-num{width:66px;text-align:right;color:var(--muted)}
.c-api{max-width:230px}
.c-api code{margin-right:4px;display:inline-block;margin-bottom:3px}
.c-compile{width:52px;text-align:center}
.c-pre,.c-reject{width:150px}
.c-status{width:170px}
.c-note{max-width:320px;color:var(--muted)}
.row.lvl-1 .title{font-weight:700;font-size:15px}
.row.lvl-2 .title{font-weight:600}
.row.lvl-3 .title{font-weight:400}
.row.section{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 6%,transparent),transparent 60%)}
.row.leaf-na .title,.row.leaf-na .c-note{color:var(--muted)}
.title{display:inline}
.sub{color:var(--muted);font-size:12px;margin-left:6px}
.num{font-family:var(--mono);font-size:12px;color:var(--muted)}
.dash{color:var(--line-strong)}
.badge{display:inline-block;font-size:12px;padding:1px 7px;border-radius:20px;white-space:nowrap;font-weight:600}
.s-done{color:var(--done);background:var(--done-bg)}
.s-partial{color:var(--partial);background:var(--partial-bg)}
.s-none{color:var(--none);background:var(--none-bg)}
.s-na{color:var(--na);background:var(--na-bg)}
.bar{display:inline-flex;width:58px;height:7px;border-radius:4px;overflow:hidden;background:var(--na-bg);vertical-align:middle;margin-left:6px}
.bar i{display:block;height:100%}
.b-done{background:var(--done)}.b-partial{background:var(--partial)}.b-none{background:var(--none)}.b-na{background:var(--na);opacity:.45}
.compile{font-weight:700}
.c-yes{color:var(--done)}.c-no{color:var(--none)}.c-na{color:var(--line-strong)}
.chip{display:inline-block;font-size:11.5px;padding:1px 6px;border-radius:5px;background:var(--na-bg);color:var(--ink);margin:0 4px 4px 0;border:1px solid var(--line);white-space:nowrap}
.chip-label{color:var(--muted)}
.chip.cli{background:var(--cli-bg);color:var(--cli);border-color:transparent;font-weight:600}
.chip.inherit{background:transparent;border-style:dashed;color:var(--muted)}
.c-pre,.c-reject{width:150px}
.tip{position:relative;cursor:help}
.tip::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 6px);z-index:60;width:max-content;max-width:380px;white-space:pre-line;
  background:#101418;color:#f2f5f8;padding:9px 11px;border-radius:8px;font-size:12.5px;font-weight:400;line-height:1.5;
  box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;transition:opacity .12s}
.tip:hover::after,.tip:focus::after,.tip:focus-visible::after{opacity:1}
tr.section{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 6%,transparent),transparent 60%)}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px}
.legend dl{margin:0;font-size:13px}
.legend dt{font-weight:650;margin-top:8px}
.legend dd{margin:2px 0 0;color:var(--muted);white-space:pre-line}
.findings{margin:0;padding-left:18px;font-size:13.5px}
.findings .e{color:var(--none);font-weight:600}
.findings .w{color:var(--partial)}
.ok{color:var(--done);font-weight:600;margin:0}
footer{color:var(--muted);font-size:12.5px;margin-top:26px}
@media print{.toolbar{display:none}tr[hidden]{display:table-row}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>TIA Portal Openness V17 能力覆盖矩阵</h1>
  <p class="sub">
    本页由 <code>scripts/coverage/build-matrix.mjs</code> 生成：手册章节结构与叶子数来自官方 V17 手册快照，
    API 类型面来自本机 <code>Siemens.Engineering.xml</code> 快照，"已适配"结论来自人工分析并经代码引用自动核对。
    悬停任意标签看完整说明。
  </p>
  <div class="panel meta">
    <div><b>TIA Portal</b> V${esc(sources.tia.majorVersion)} · <span class="mono">${esc(sources.tia.opennessDir)}</span></div>
    <div><b>手册</b> ${esc(manual.entryCount)} 条目录条目 · <span class="mono">${esc(manual.source)}</span></div>
    <div><b>API 面</b> ${esc(api.typeCount)} 类型 / ${esc(api.memberCount)} 文档化成员 / ${esc(api.namespaceCount)} 命名空间</div>
    <div><b>代码引用</b> ${esc(usage.referenced.size)} 个 Openness 类型 / ${esc(new Set(usage.referenced.values()).size)} 个命名空间</div>
    <div><b>快照抽取于</b> ${esc(sources.extractedAt)}</div>
    <div><b>代码指纹</b> <span class="mono">${esc(sources.fingerprint)}</span></div>
    <div><b>手册 TOC 哈希</b> <span class="mono">${esc(manual.tocSha256.slice(0, 16))}</span></div>
    <div><b>API XML 哈希</b> <span class="mono">${esc(api.xmlSha256.slice(0, 16))}</span></div>
  </div>
</header>

<section class="cards">
  <div class="card"><div class="k">手册能力条目</div><div class="v">${esc(summary.items)}</div><div class="d">手册 TOC 的功能叶子总数</div></div>
  <div class="card"><div class="k">已适配</div><div class="v">${esc(summary.done)}</div><div class="d">占手册能力条目 ${summary.items === 0 ? '' : ((summary.done / summary.items) * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="k">部分适配</div><div class="v">${esc(summary.partial)}</div><div class="d">能力存在但覆盖不全</div></div>
  <div class="card"><div class="k">未适配</div><div class="v">${esc(summary.none)}</div><div class="d">API 可编译，本插件未接线</div></div>
  <div class="card"><div class="k">Openness 类型覆盖</div><div class="v">${esc(usage.referenced.size)}/${esc(api.typeCount)}</div><div class="d">${((usage.referenced.size / api.typeCount) * 100).toFixed(1)}% · 唯一名类型 ${summary.uniqueTypes}</div></div>
  <div class="card"><div class="k">操作 / 工具</div><div class="v">${esc(inventory.operations.length)}/${esc(inventory.tools.length)}</div><div class="d">白名单操作 / DSH 工具</div></div>
</section>

<div class="panel">
  <h3>一致性检查</h3>
  ${warningHtml}
</div>

<div class="toolbar">
  <input type="search" id="q" placeholder="搜索章节或能力名…" aria-label="搜索">
  <div class="filters">
    ${Object.entries(STATUS).map(([key, meta]) => `<label><input type="checkbox" class="f-status" value="${esc(key)}" checked>${esc(meta.label)}</label>`).join('')}
    <label><input type="checkbox" id="f-cli">只看仅 CLI 可达</label>
  </div>
  <button type="button" id="expand">全部展开</button>
  <button type="button" id="collapse">全部折叠</button>
  <span class="num" id="visible"></span>
</div>

<table id="matrix">
  <thead>
    <tr>
      <th class="c-caret"></th>
      <th>手册条目</th>
      <th class="c-num">条目</th>
      <th class="c-api">对应 API 命名空间</th>
      <th class="c-compile">可编译</th>
      <th class="c-pre">前置条件</th>
      <th class="c-reject">API 限制</th>
      <th class="c-status">状态</th>
      <th class="c-note">说明</th>
    </tr>
  </thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>

<h2>本插件的操作面（自动扫描）</h2>
<div class="panel">
  <p class="sub" style="margin:0 0 10px">
    白名单操作来自 <code>controller/Protocol.cs</code> 的 <code>OperationCatalog</code>，并与 <code>src/protocol.ts</code> 的
    <code>OPERATIONS</code> 逐一比对；工具名来自 <code>src/tools.ts</code>。
  </p>
  <dl class="legend" style="margin:0">
    <div><dt>操作（${esc(inventory.operations.length)}）</dt><dd>${inventory.operations.map((name) => `<code>${esc(name)}</code>`).join(' ')}</dd></div>
    <div><dt>DSH 工具（${esc(inventory.tools.length)}）</dt><dd>${inventory.tools.map((name) => `<code>${esc(name)}</code>`).join(' ')}</dd></div>
  </dl>
</div>

<h2>被引用的 Openness 类型（自动扫描）</h2>
<div class="panel">
  <p class="sub" style="margin:0 0 10px">
    在 <code>controller/*.cs</code> 里匹配：先剔除注释与字符串字面量，再按每个文件自己的
    <code>using Siemens.Engineering…</code> 作用域逐个类型名做整词匹配，共 ${esc(usage.referenced.size)} 个类型。
    这是"已适配"判断的代码侧依据：某个命名空间下出现新类型时，构建会把对应章节的状态标为过期。
  </p>
  ${renderReferenced(usage)}
</div>

<h2>已排除的同名标识符</h2>
<div class="panel">
  <p class="sub" style="margin:0 0 8px">
    下列名字在控制器里指的是别的东西，因此不计入 Openness 类型覆盖。
  </p>
  <ul class="findings" style="color:var(--muted)">${excluded}</ul>
</div>

<h2>图例</h2>
${renderLegend()}

<footer>
  <p>
    生成方式：<code>npm run matrix:build</code>（重新生成）· <code>npm run matrix:check</code>（校验是否过期，已并入
    <code>npm run check</code>）· <code>npm run matrix:extract</code>（TIA 版本或手册更新后重取快照）。
    手工判断集中在 <code>scripts/coverage/matrix-data.mjs</code>，不要直接编辑本 HTML。
  </p>
  <p>
    手册内容仅以目录标题与短引用形式引用，用于说明 Openness 的能力边界；手册原文的著作权归 Siemens AG，
    本页不随插件分发包分发手册内容。
  </p>
</footer>
</div>

<script>
(function(){
  var table = document.getElementById('matrix');
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  var byId = {};
  rows.forEach(function(r){ byId[r.dataset.id] = r; });
  function children(id){ return rows.filter(function(r){ return r.dataset.parent === id; }); }
  var expanded = {};
  // The manual's branches are open, everything below them starts collapsed, so
  // the first view is the section matrix rather than 400 capability rows.
  rows.forEach(function(r){ expanded[r.dataset.id] = r.classList.contains('branch'); });

  function setCaret(row, open){
    var b = row.querySelector('.caret');
    if(!b) return;
    b.textContent = open ? '▾' : '▸';
    b.setAttribute('aria-expanded', String(open));
  }
  function toggle(row){
    var open = !expanded[row.dataset.id];
    expanded[row.dataset.id] = open;
    setCaret(row, open);
    apply();
  }

  function matches(row){
    var statuses = Array.prototype.filter.call(document.querySelectorAll('.f-status'), function(c){ return c.checked; })
      .map(function(c){ return c.value; });
    var status = row.dataset.status;
    if(row.classList.contains('leaf') || row.classList.contains('leaf-na')){
      if(statuses.indexOf(status) === -1) return false;
    }
    if(document.getElementById('f-cli').checked && row.dataset.cli !== '1') return false;
    var q = document.getElementById('q').value.trim().toLowerCase();
    if(q.length > 0 && row.dataset.title.indexOf(q) === -1) return false;
    return true;
  }

  function apply(){
    var filtering = document.getElementById('q').value.trim().length > 0
      || document.getElementById('f-cli').checked
      || document.querySelectorAll('.f-status:not(:checked)').length > 0;
    var keep = {};
    function mark(row){
      var self = matches(row);
      var kids = children(row.dataset.id);
      var childKeep = kids.map(mark).some(Boolean);
      var value = self || childKeep;
      keep[row.dataset.id] = value;
      return value;
    }
    rows.filter(function(r){ return r.dataset.parent === ''; }).forEach(mark);

    var visible = 0;
    rows.forEach(function(row){
      var shown = keep[row.dataset.id] === true;
      if(shown){
        var ancestor = row.dataset.parent;
        while(ancestor !== '' && ancestor !== undefined){
          var parentRow = byId[ancestor];
          if(parentRow === undefined) break;
          if(filtering){ expanded[ancestor] = true; setCaret(parentRow, true); }
          if(!expanded[ancestor]) { shown = false; break; }
          ancestor = parentRow.dataset.parent;
        }
      }
      row.hidden = !shown;
      if(shown) visible++;
    });
    document.getElementById('visible').textContent = visible + ' / ' + rows.length + ' 行可见';
  }

  table.addEventListener('click', function(event){
    var button = event.target.closest('.caret');
    if(button === null) return;
    var row = button.closest('tr');
    toggle(row);
  });
  document.getElementById('expand').addEventListener('click', function(){
    rows.forEach(function(r){ if(children(r.dataset.id).length > 0){ expanded[r.dataset.id] = true; setCaret(r, true); } });
    apply();
  });
  document.getElementById('collapse').addEventListener('click', function(){
    rows.forEach(function(r){ if(children(r.dataset.id).length > 0){ expanded[r.dataset.id] = false; setCaret(r, false); } });
    apply();
  });
  ['input','change'].forEach(function(evt){
    document.getElementById('q').addEventListener(evt, apply);
    document.querySelectorAll('.f-status').forEach(function(c){ c.addEventListener(evt, apply); });
    document.getElementById('f-cli').addEventListener(evt, apply);
  });

  // The sticky table header has to start below the sticky toolbar, whose height
  // depends on how the filters wrap.
  function syncToolbarHeight(){
    var bar = document.querySelector('.toolbar');
    document.documentElement.style.setProperty('--toolbar-h', bar.offsetHeight + 'px');
  }
  window.addEventListener('resize', syncToolbarHeight);
  syncToolbarHeight();
  apply();
})();
</script>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const outIndex = argv.findIndex((arg) => arg.startsWith('--out'))
  const out = outIndex === -1 ? OUT_DEFAULT : resolve(argv[outIndex].includes('=') ? argv[outIndex].split('=')[1] : argv[outIndex + 1])

  if (!existsSync(SOURCES)) {
    throw new Error(`Missing ${relative(REPO, SOURCES)}. Run: npm run matrix:extract`)
  }
  const snapshot = JSON.parse(readFileSync(SOURCES, 'utf8'))
  const api = { ...snapshot.api, tocRoots: snapshot.manual.toc }
  const manual = snapshot.manual

  const sourcesFiles = readSources()
  const usage = scanApiUsage(sourcesFiles, api)
  const inventory = scanInventory(sourcesFiles)
  const nsUsage = namespaceUsage(api, usage)
  const built = buildRows(sourcesFiles, api, usage)
  const checks = consistencyChecks(built.rows, api, usage, sourcesFiles, inventory, nsUsage)
  const flat = flatten(built.rows)

  const summary = { items: 0, done: 0, partial: 0, none: 0, na: 0, uniqueTypes: 0 }
  for (const branch of built.rows) {
    const counts = branch.counts ?? { total: 0, done: 0, partial: 0, none: 0, na: 0 }
    summary.items += counts.total
    summary.done += counts.done
    summary.partial += counts.partial
    summary.none += counts.none
    summary.na += counts.na
  }
  for (const names of Object.values(api.namespaces)) summary.uniqueTypes += names.filter((short) => countNames(api, short) === 1).length

  const html = renderPage({
    flat,
    rows: built.rows,
    api,
    manual,
    sources: { ...snapshot, fingerprint: sourcesFiles.fingerprint },
    usage,
    inventory,
    nsUsage,
    summary,
    warnings: [...built.warnings, ...checks.warnings],
    errors: [...built.errors, ...checks.errors],
  })

  const findings = [...built.errors, ...checks.errors, ...built.warnings, ...checks.warnings]
  if (check) {
    // Line endings are normalized before comparing (see `normalizeEol`): the
    // generated file is LF (`.gitattributes` pins `*.html` to `eol=lf`), but a
    // checkout or an editor that rewrites it as CRLF must not be reported as
    // stale content.
    const current = existsSync(out) ? readFileSync(out, 'utf8') : null
    const stale = current === null || normalizeEol(current) !== normalizeEol(html)
    if (stale) {
      process.stderr.write(`✗ ${relative(REPO, out)} is stale. Run: npm run matrix:build\n`)
    }
    for (const finding of findings) process.stderr.write(`  ${checkSeverity(finding, built, checks)} ${finding}\n`)
    if (stale || built.errors.length + checks.errors.length > 0) process.exitCode = 1
    else process.stdout.write(`✓ ${relative(REPO, out)} is current (${summary.items} 能力条目, ${usage.referenced.size} 类型被引用)\n`)
    return
  }

  writeFileSync(out, html, 'utf8')
  process.stdout.write(
    `Wrote ${relative(REPO, out)}\n` +
      `  能力条目 ${summary.items}（已适配 ${summary.done} / 部分 ${summary.partial} / 未适配 ${summary.none} / 不适用 ${summary.na}）\n` +
      `  Openness 类型 ${usage.referenced.size}/${api.typeCount} 被引用，排除同名 ${usage.excluded.length} 个\n` +
      `  操作 ${inventory.operations.length}，工具 ${inventory.tools.length}\n` +
      findings.map((finding) => `  ! ${finding}\n`).join(''),
  )
  if (built.errors.length + checks.errors.length > 0) process.exitCode = 1
}

function checkSeverity(finding, built, checks) {
  return built.errors.includes(finding) || checks.errors.includes(finding) ? '✗' : '!'
}

main()
