/**
 * `project_translate` — the workflow-level translation tool.
 *
 * It does not talk to TIA Portal itself. `projectTextAccess` (interface plugin)
 * exports/imports the official project-texts XLSX; this tool filters it, writes
 * jobs for the model, merges translations back, imports, and verifies the result.
 *
 * v1 scope:
 *   - plan: export one or more source languages, filter, dedupe, write artifacts;
 *   - apply: merge a translations JSONL into a copy, archive, import, re-export,
 *     compare coverage and block fingerprints;
 *   - status: plan-like snapshot without importing.
 *
 * The import is not transactional; the caller must archive (this tool does it by
 * default) and inspect the report before saving.
 *
 * @module dsh-engineering-context/tools/project-translate
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  engineeringAccess,
  projectTextAccess,
  type ProjectTextAccessLike,
} from '../access.js'
import { EngineeringContextError } from '../errors.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import { mergeTextWorkbook, readTextWorkbook, type ProjectTextRow } from '../project-text/xlsx.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

export const PROJECT_TRANSLATE_TOOL = 'project_translate'

const SCOPE_VALUES = ['plc-comments', 'plc-all', 'hmi-user-texts', 'all-user-texts'] as const
const POLICY_VALUES = ['only_empty', 'overwrite', 'fill_empty_keep_existing'] as const

const PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['plan', 'apply', 'status'],
    description: "'plan' exports and filters; 'apply' imports a merged workbook; 'status' is a read-only plan snapshot.",
  },
  target_language: {
    type: 'string',
    description: 'Target culture, e.g. zh-CN. Must be active in the project; the tool never activates it silently.',
  },
  source_languages: {
    type: 'array',
    items: { type: 'string' },
    description:
      'One source culture = one export, no merge. Multiple = optional merge by Internal ID, first non-empty wins. Defaults to the project reference language.',
  },
  scope: {
    type: 'string',
    enum: [...SCOPE_VALUES],
    description: 'Preset selection. Default plc-comments. Refine with categories/path_prefix/block_names/text_types.',
  },
  categories: {
    type: 'array',
    items: { type: 'string' },
    description: 'Exact Category values to keep; overrides the scope preset when given.',
  },
  path_prefix: {
    type: 'string',
    description: 'Keep only ViewPath rows with this prefix (device/PLC/group).',
  },
  block_names: {
    type: 'array',
    items: { type: 'string' },
    description: 'Keep only rows whose ViewPath contains one of these block names as a segment.',
  },
  text_types: {
    type: 'array',
    items: {
      type: 'string',
      enum: [
        'block_title',
        'block_comment',
        'network_title',
        'network_comment',
        'udt_title',
        'udt_comment',
        'tag_comment',
        'hardware_comment',
        'hmi',
        'alarm',
        'text_list',
        'other',
      ],
    },
    description: 'Optional text-type filter.',
  },
  target_policy: {
    type: 'string',
    enum: [...POLICY_VALUES],
    description: "Default only_empty. Overwrite re-translates existing target texts; fill_empty_keep_existing preserves them.",
  },
  target_activation: {
    type: 'string',
    enum: ['ask', 'never'],
    description: "Default ask. The tool never activates; when the target is inactive it returns needs_permission (code target_language_inactive).",
  },
  min_length: {
    type: 'integer',
    description: 'Skip source texts shorter than this after trim. Default 1.',
  },
  skip_patterns: {
    type: 'array',
    items: { type: 'string' },
    description: 'Regexes whose match skips a row (separators, pure numbers, placeholders).',
  },
  max_rows: {
    type: 'integer',
    description: 'Pilot cap on selected rows. Default: no cap.',
  },
  plan_file: {
    type: 'string',
    description: 'apply only: absolute path of plan.json produced by action=plan.',
  },
  translations_file: {
    type: 'string',
    description: 'apply only: JSONL lines {"text_id":"...","target":"..."} (or {"row":N,"target":"..."}).',
  },
  archive: {
    type: 'boolean',
    description: 'apply only: archive the project before import. Default true.',
  },
  save: {
    type: 'boolean',
    description: 'apply only: save the project after verification. Default false.',
  },
} as const

interface TextTypeRow extends ProjectTextRow {
  textType: string
  blockName: string
}

interface SelectedRow extends TextTypeRow {
  textId: string
  chosenSource: string
  sourceLanguage: string
}

interface PlanDocument {
  schemaVersion: 1
  createdAt: string
  targetLanguage: string
  sourceLanguages: string[]
  baseSourceLanguage: string
  targetPolicy: string
  scope: string
  baseFile: string
  artifactDir: string
  selected: SelectedRow[]
  counts: Record<string, number>
  fBlockCount: number
  baselineFingerprints: Record<string, Record<string, string>>
  planHash: string
}

interface TranslationLine {
  text_id?: string
  row?: number
  target?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function languageCultures(value: unknown): string[] {
  return asList(value)
    .map((entry) => asText(asRecord(entry)?.['culture']))
    .filter((culture): culture is string => culture !== undefined)
}

function blockNameOf(viewPath: string): string {
  const parts = viewPath.split('\\').filter((part) => part.length > 0)
  const programIndex = parts.indexOf('Program blocks')
  if (programIndex >= 0) {
    const tail = parts.slice(programIndex + 1)
    const networkIndex = tail.findIndex((part) => /^Network \d+$/i.test(part))
    if (networkIndex > 0) return tail[networkIndex - 1] ?? ''
    const marker = tail.findIndex((part) => part === 'Block title' || part === 'Block comment')
    if (marker > 0) return tail[marker - 1] ?? ''
    // Interface/operand comment: the segment before the final member name.
    return tail.length >= 2 ? (tail[tail.length - 2] ?? '') : ''
  }
  const typeIndex = parts.indexOf('PLC data types')
  if (typeIndex >= 0) {
    const tail = parts.slice(typeIndex + 1)
    return tail.length >= 2 ? (tail[tail.length - 2] ?? '') : ''
  }
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : ''
}

function textTypeOf(category: string, viewPath: string): string {
  if (viewPath.endsWith('\\Block title')) return 'block_title'
  if (viewPath.endsWith('\\Block comment')) return 'block_comment'
  if (/\\Network \d+\\Title$/i.test(viewPath)) return 'network_title'
  if (/\\Network \d+\\Comment$/i.test(viewPath)) return 'network_comment'
  if (viewPath.endsWith('\\Title of the PLC data type')) return 'udt_title'
  if (viewPath.endsWith('\\Comment on PLC data type')) return 'udt_comment'
  if (category === '<TagCommentCategoryData>') return 'tag_comment'
  if (category === '<HwcnCommentTextCategoryData>') return 'hardware_comment'
  if (category.includes('Alarm')) return 'alarm'
  if (category.includes('TextList')) return 'text_list'
  if (category.includes('HMI')) return 'hmi'
  return 'other'
}

function categoryMatches(category: string, scope: string): boolean {
  if (scope === 'all-user-texts') return true
  if (scope === 'hmi-user-texts') {
    return category.includes('HMI') || category.includes('Alarm') || category.includes('TextList')
  }
  if (scope === 'plc-all') {
    return category.includes('BlockComment') || category.includes('TagComment') ||
      category.includes('Hwcn') || category.includes('ProDiag') || category.includes('Miscellaneous') ||
      category.includes('TextList') || category.includes('Alarm')
  }
  // plc-comments (default)
  return category.includes('BlockComment') || category.includes('TagComment') || category.includes('Hwcn')
}

function fBlockNames(raw: unknown): Set<string> {
  const data = asRecord(asRecord(raw)?.['data'])
  const blocks = asRecord(data?.['blocks'])
  const items = asList(blocks?.['items'])
  const names = new Set<string>()
  for (const item of items) {
    const row = asRecord(item)
    const name = asText(row?.['name'])
    if (name === undefined) continue
    const attributes = asList(row?.['attributes'])
    for (const attribute of attributes) {
      const attr = asRecord(attribute)
      if (asText(attr?.['name'])?.toLowerCase() !== 'programminglanguage') continue
      const value = asText(attr?.['value']) ?? ''
      if (value.startsWith('F_')) names.add(name)
    }
  }
  return names
}

function baselineFingerprints(raw: unknown): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  const objects = asList(asRecord(raw)?.['objects'])
  for (const object of objects) {
    const row = asRecord(object)
    const name = asText(row?.['name'])
    if (name === undefined) continue
    const facets: Record<string, string> = {}
    for (const fingerprint of asList(row?.['fingerprints'])) {
      const facet = asRecord(fingerprint)
      const id = asText(facet?.['id'])
      const value = asText(facet?.['value'])
      if (id !== undefined && value !== undefined) facets[id] = value
    }
    if (Object.keys(facets).length > 0) result[name] = facets
  }
  return result
}

function hashSelected(selected: readonly SelectedRow[]): string {
  return createHash('sha1').update(JSON.stringify(selected)).digest('hex')
}

function line(value: unknown): string {
  return JSON.stringify(value) + '\n'
}

async function services(dependencies: ToolDependencies) {
  const projectTexts = projectTextAccess(dependencies.ctx)
  if (projectTexts === undefined) {
    throw new EngineeringContextError(
      'project_text_access_unavailable',
      'This composition has no projectTextAccess service, so project texts cannot be exported/imported. Install the V17 interface plugin with the translation seam.',
    )
  }
  return projectTexts
}

export function projectTranslateTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: PROJECT_TRANSLATE_TOOL,
    description:
      'Translate TIA project texts through the official project-texts XLSX. plan exports one or more source languages, filters rows, and writes jobs.jsonl; the model translates them; apply merges translations into a copy, archives, imports, and re-exports to verify coverage. The import is not transactional: archive is on by default and code/interface fingerprint regressions are reported. F blocks are excluded by programmingLanguage=F_*. No TIA tool is called from this plugin; projectTextAccess is the seam.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const projectTexts = await services(dependencies)
        const languages = await projectTexts.readLanguages()
        const languageData = asRecord(asRecord(languages)?.['data'])
        if (asRecord(languages)?.['ok'] !== true || languageData === null) {
          throw new EngineeringContextError(
            'tia_project_not_open',
            'The project languages could not be read. Open the project in TIA Portal first.',
          )
        }
        const active = languageCultures(languageData['activeLanguages'])
        const reference = asText(languageData['referenceLanguage']) ?? null
        const target = args.target_language ?? asText(languageData['editingLanguage'])
        if (target === undefined) {
          throw new EngineeringContextError('invalid_argument', 'target_language is required.')
        }
        if (!active.includes(target)) {
          return failedOutcome(
            PROJECT_TRANSLATE_TOOL,
            scope.view,
            new EngineeringContextError(
              'target_language_inactive',
              `The target language ${target} is not active. Ask the user for permission, then activate it with project_languages (this tool never changes the project's language configuration silently).`,
              { targetLanguage: target, activeLanguages: active, action: 'activate_target_language' },
            ),
          )
        }
        if (args.action === 'apply') {
          return await applyPlan(dependencies, projectTexts, scope, args, target)
        }
        return await plan(dependencies, projectTexts, scope, args, target, reference)
      } catch (error) {
        return failedOutcome(PROJECT_TRANSLATE_TOOL, scope?.view ?? null, error)
      }
    },
  })
}

async function plan(
  dependencies: ToolDependencies,
  projectTexts: ProjectTextAccessLike,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  target: string,
  reference: string | null,
): Promise<ReturnType<typeof okOutcome>> {
  const sources = asList(args.source_languages)
    .map((entry) => asText(entry))
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
  const sourceLanguages = sources.length > 0 ? sources : reference === null ? [] : [reference]
  if (sourceLanguages.length === 0) {
    throw new EngineeringContextError('invalid_argument', 'No source language: the project has no reference language.')
  }
  const policy = asText(args.target_policy) ?? 'only_empty'
  const scopeName = asText(args.scope) ?? 'plc-comments'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const projectName = scope.workspace.title ?? basename(scope.workspace.path)
  const artifactDir = join(scope.workspace.path, 'translations', projectName, stamp)
  await mkdir(artifactDir, { recursive: true })

  const blockRaw = await projectTexts.listBlocks({ maxItems: 10000 })
  const fBlocks = fBlockNames(blockRaw)

  const perSource: Array<{ language: string; rows: Map<string, TextTypeRow>; file: string }> = []
  for (const sourceLanguage of sourceLanguages) {
    const file = join(artifactDir, `source-${sourceLanguage}.xlsx`)
    const exported = await projectTexts.exportTexts(file, sourceLanguage, target)
    if (asRecord(exported)?.['ok'] !== true) {
      throw new EngineeringContextError(
        'project_text_export_failed',
        `Exporting project texts for ${sourceLanguage} failed.`,
        asRecord(asRecord(exported)?.['error']) ?? undefined,
      )
    }
    const parsed = await readTextWorkbook(file, sourceLanguage, target)
    const rows = new Map<string, TextTypeRow>()
    for (const row of parsed.rows) {
      rows.set(row.internalId, { ...row, textType: textTypeOf(row.category, row.viewPath), blockName: blockNameOf(row.viewPath) })
    }
    perSource.push({ language: sourceLanguage, rows, file })
  }

  const base = perSource[0]
  if (base === undefined) throw new EngineeringContextError('project_text_export_failed', 'No source export was produced.')
  const filters = {
    categories: asList(args.categories).map((entry) => asText(entry)).filter(Boolean) as string[],
    pathPrefix: asText(args.path_prefix) ?? '',
    blockNames: asList(args.block_names).map((entry) => asText(entry)).filter(Boolean) as string[],
    textTypes: asList(args.text_types).map((entry) => asText(entry)).filter(Boolean) as string[],
    minLength: typeof args.min_length === 'number' ? args.min_length : 1,
    skipPatterns: asList(args.skip_patterns).map((entry) => asText(entry)).filter(Boolean) as string[],
    maxRows: typeof args.max_rows === 'number' ? args.max_rows : Number.POSITIVE_INFINITY,
  }
  const skipRegexes = filters.skipPatterns.map((pattern) => new RegExp(pattern))

  const selected: SelectedRow[] = []
  const excluded = new Map<string, number>()
  for (const row of base.rows.values()) {
    if (row.textType !== 'other' && row.viewPath.startsWith('PLC data types')) {
      // keep UDT rows; the branch is documented, not a filter
    }
    if (fBlocks.has(row.blockName)) {
      excluded.set('f_block', (excluded.get('f_block') ?? 0) + 1)
      continue
    }
    if (filters.categories.length > 0 && !filters.categories.includes(row.category)) {
      excluded.set('category', (excluded.get('category') ?? 0) + 1)
      continue
    }
    if (filters.categories.length === 0 && !categoryMatches(row.category, scopeName)) {
      excluded.set('scope', (excluded.get('scope') ?? 0) + 1)
      continue
    }
    if (filters.pathPrefix.length > 0 && !row.viewPath.startsWith(filters.pathPrefix)) {
      excluded.set('path_prefix', (excluded.get('path_prefix') ?? 0) + 1)
      continue
    }
    if (filters.textTypes.length > 0 && !filters.textTypes.includes(row.textType)) {
      excluded.set('text_type', (excluded.get('text_type') ?? 0) + 1)
      continue
    }
    if (filters.blockNames.length > 0 && !filters.blockNames.includes(row.blockName)) {
      excluded.set('block_name', (excluded.get('block_name') ?? 0) + 1)
      continue
    }
    let chosenSource = ''
    let sourceLanguage = base.language
    for (const candidate of perSource) {
      const candidateRow = candidate.rows.get(row.internalId)
      if (candidateRow !== undefined && candidateRow.source.trim().length > 0) {
        chosenSource = candidateRow.source
        sourceLanguage = candidate.language
        break
      }
    }
    if (chosenSource.trim().length < filters.minLength) {
      excluded.set('source_empty', (excluded.get('source_empty') ?? 0) + 1)
      continue
    }
    if (skipRegexes.some((regex) => regex.test(chosenSource))) {
      excluded.set('skip_pattern', (excluded.get('skip_pattern') ?? 0) + 1)
      continue
    }
    const targetText = row.target.trim()
    if (policy === 'only_empty' && targetText.length > 0) {
      excluded.set('target_exists', (excluded.get('target_exists') ?? 0) + 1)
      continue
    }
    if (policy === 'fill_empty_keep_existing' && targetText.length > 0) {
      excluded.set('target_exists', (excluded.get('target_exists') ?? 0) + 1)
      continue
    }
    if (selected.length >= filters.maxRows) {
      excluded.set('max_rows', (excluded.get('max_rows') ?? 0) + 1)
      continue
    }
    selected.push({
      ...row,
      chosenSource,
      sourceLanguage,
      textId: createHash('sha1').update(`${chosenSource}\u0000${row.category}\u0000${row.textType}`).digest('hex'),
    })
  }

  const unique = new Map<string, { text_id: string; source: string; count: number; textType: string; categories: string[]; contexts: string[] }>()
  for (const row of selected) {
    const entry = unique.get(row.textId)
    if (entry === undefined) {
      unique.set(row.textId, {
        text_id: row.textId,
        source: row.chosenSource,
        count: 1,
        textType: row.textType,
        categories: [row.category],
        contexts: [row.viewPath],
      })
    } else {
      entry.count += 1
      if (!entry.categories.includes(row.category)) entry.categories.push(row.category)
      if (entry.contexts.length < 5) entry.contexts.push(row.viewPath)
    }
  }

  const access = engineeringAccess(dependencies.ctx)
  let baseline: Record<string, Record<string, string>> = {}
  if (access?.listObjects !== undefined) {
    try {
      const raw = await access.listObjects({ includeFingerprints: true, maxItems: 5000 })
      baseline = baselineFingerprints(raw)
    } catch {
      // fingerprints are evidence, not a prerequisite for planning
    }
  }

  const planDocument: PlanDocument = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    targetLanguage: target,
    sourceLanguages,
    baseSourceLanguage: base.language,
    targetPolicy: policy,
    scope: scopeName,
    baseFile: base.file,
    artifactDir,
    selected,
    counts: {
      rows: base.rows.size,
      selected: selected.length,
      unique: unique.size,
      excluded: [...excluded.values()].reduce((sum, value) => sum + value, 0),
      fBlocks: fBlocks.size,
    },
    fBlockCount: fBlocks.size,
    baselineFingerprints: baseline,
    planHash: hashSelected(selected),
  }

  await writeFile(join(artifactDir, 'plan.json'), JSON.stringify(planDocument, null, 2))
  await writeFile(join(artifactDir, 'selected.jsonl'), selected.map((row) => line({
    text_id: row.textId,
    row: row.rowNumber,
    internal_id: row.internalId,
    category: row.category,
    view_path: row.viewPath,
    text_type: row.textType,
    source: row.chosenSource,
    source_language: row.sourceLanguage,
    target: row.target,
  })).join(''))
  await writeFile(join(artifactDir, 'excluded.jsonl'), [...excluded].map(([reason, count]) => line({ reason, count })).join(''))
  await writeFile(join(artifactDir, 'jobs.jsonl'), selected.map((row) => line({
    text_id: row.textId,
    source: row.chosenSource,
    text_type: row.textType,
    category: row.category,
    view_path: row.viewPath,
    target_language: target,
  })).join(''))
  await writeFile(join(artifactDir, 'unique.jsonl'), [...unique.values()].map((entry) => line(entry)).join(''))

  const details = [
    `Rows: ${base.rows.size}; selected: ${selected.length}; unique: ${unique.size}; excluded: ${planDocument.counts.excluded}`,
    `Sources: ${sourceLanguages.join(', ')}; target: ${target}; policy: ${policy}`,
    `F blocks excluded by programmingLanguage: ${fBlocks.size}`,
    `Artifacts: ${artifactDir}`,
  ]
  for (const [reason, count] of [...excluded].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    details.push(`  ${reason}: ${count}`)
  }
  const preview = cappedList(selected, (row) => `${row.textType}: ${row.chosenSource.slice(0, 80)}`, 8)
  details.push(...preview)

  return okOutcome(
    PROJECT_TRANSLATE_TOOL,
    scope.view,
    `Planned ${selected.length} text rows (${unique.size} unique) ${sourceLanguages.join('+')} → ${target}.`,
    {
      action: 'plan',
      targetLanguage: target,
      sourceLanguages,
      baseSourceLanguage: base.language,
      targetPolicy: policy,
      scope: scopeName,
      counts: planDocument.counts,
      artifacts: {
        dir: artifactDir,
        plan: join(artifactDir, 'plan.json'),
        selected: join(artifactDir, 'selected.jsonl'),
        excluded: join(artifactDir, 'excluded.jsonl'),
        jobs: join(artifactDir, 'jobs.jsonl'),
        unique: join(artifactDir, 'unique.jsonl'),
      },
      planHash: planDocument.planHash,
      preview,
    },
    { details, dryRun: true, warnings: fBlocks.size === 0 ? ['No F block was detected by programmingLanguage=F_*; verify the project has none.'] : [] },
  )
}

async function applyPlan(
  dependencies: ToolDependencies,
  projectTexts: ProjectTextAccessLike,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  target: string,
): Promise<ReturnType<typeof okOutcome> | ReturnType<typeof failedOutcome>> {
  const planFile = asText(args.plan_file)
  const translationsFile = asText(args.translations_file)
  if (planFile === undefined || translationsFile === undefined) {
    throw new EngineeringContextError('invalid_argument', 'action=apply needs plan_file and translations_file.')
  }
  const planDocument = JSON.parse(await readFile(planFile, 'utf8')) as PlanDocument
  if (planDocument.targetLanguage !== target) {
    throw new EngineeringContextError('invalid_argument', `Plan target ${planDocument.targetLanguage} does not match ${target}.`)
  }
  if (hashSelected(planDocument.selected) !== planDocument.planHash) {
    throw new EngineeringContextError('plan_changed', 'The plan selection no longer matches its hash; regenerate the plan.')
  }
  const translations = new Map<number, string>()
  const byTextId = new Map<string, string>()
  for (const raw of (await readFile(translationsFile, 'utf8')).split(/\r?\n/)) {
    if (raw.trim().length === 0) continue
    const entry = JSON.parse(raw) as TranslationLine
    if (typeof entry.target !== 'string') continue
    if (typeof entry.text_id === 'string') byTextId.set(entry.text_id, entry.target)
    if (typeof entry.row === 'number') translations.set(entry.row, entry.target)
  }
  for (const row of planDocument.selected) {
    const value = byTextId.get(row.textId)
    if (value !== undefined) translations.set(row.rowNumber, value)
  }
  if (planDocument.selected.length === 0) {
    throw new EngineeringContextError('invalid_argument', 'The plan selected no rows; nothing to import.')
  }
  if (translations.size === 0) {
    throw new EngineeringContextError('invalid_argument', 'No translation matched a selected text_id/row; refusing to import an unchanged file.')
  }
  const missing = planDocument.selected.filter((row) => !translations.has(row.rowNumber))
  if (missing.length > 0) {
    throw new EngineeringContextError(
      'invalid_argument',
      `${missing.length} selected row(s) have no translation; refusing a partial import.`,
      { missing: missing.slice(0, 10).map((row) => ({ row: row.rowNumber, text_id: row.textId })) },
    )
  }
  const emptyTargets = [...translations].filter(([, value]) => value.trim().length === 0)
  if (emptyTargets.length > 0) {
    throw new EngineeringContextError(
      'invalid_argument',
      `${emptyTargets.length} translation(s) are empty. TIA treats an empty target cell as "clear" (T5), so this would delete existing text.`,
      { rows: emptyTargets.slice(0, 10).map(([row]) => row) },
    )
  }
  const translatedFile = join(planDocument.artifactDir, 'translated.xlsx')
  const merged = await mergeTextWorkbook(
    planDocument.baseFile,
    translatedFile,
    planDocument.baseSourceLanguage,
    planDocument.targetLanguage,
    translations,
  )

  let archivePath: string | null = null
  if (args.archive !== false) {
    const archived = await projectTexts.archiveProject({
      targetDir: planDocument.artifactDir,
      targetName: `before-import-${Date.now()}.zap17`,
    })
    if (asRecord(archived)?.['ok'] !== true) {
      return failedOutcome(
        PROJECT_TRANSLATE_TOOL,
        scope.view,
        new EngineeringContextError('archive_failed', 'Archiving before import failed; refusing to import.'),
      )
    }
    archivePath = asText(asRecord(asRecord(archived)?.['data'])?.['archivePath']) ?? null
  }

  const imported = await projectTexts.importTexts(translatedFile, false)
  const importedData = asRecord(asRecord(imported)?.['data'])
  const state = asText(importedData?.['state']) ?? 'unknown'
  if (asRecord(imported)?.['ok'] !== true || state === 'Error') {
    return failedOutcome(
      PROJECT_TRANSLATE_TOOL,
      scope.view,
      new EngineeringContextError(
        'project_text_import_failed',
        `Import state is ${state}. The project may be partially modified; restore the archive before retrying.`,
        { state, resultPath: asText(importedData?.['resultPath']) ?? null, archivePath },
      ),
    )
  }

  // Verify by re-exporting and recounting; then compare block fingerprints.
  const verifyFile = join(planDocument.artifactDir, 'verify.xlsx')
  const verified = await projectTexts.exportTexts(verifyFile, planDocument.baseSourceLanguage, target)
  let coverage = 0
  if (asRecord(verified)?.['ok'] === true) {
    const parsed = await readTextWorkbook(verifyFile, planDocument.baseSourceLanguage, target)
    const targetById = new Map(parsed.rows.map((row) => [row.internalId, row.target]))
    coverage = planDocument.selected.filter((row) => (targetById.get(row.internalId) ?? '').trim().length > 0).length
  }

  const access = engineeringAccess(dependencies.ctx)
  const after = access?.listObjects === undefined
    ? {}
    : baselineFingerprints(await access.listObjects({ includeFingerprints: true, maxItems: 5000 }))
  const changed: Record<string, string[]> = { Comments: [], Code: [], Interface: [], Properties: [] }
  for (const row of planDocument.selected) {
    const before = planDocument.baselineFingerprints[row.blockName]
    const now = after[row.blockName]
    if (before === undefined || now === undefined) continue
    for (const facet of Object.keys({ ...before, ...now })) {
      if (before[facet] === now[facet]) continue
      const bucket = facet in changed ? facet : 'Properties'
      const list = changed[bucket] ?? (changed[bucket] = [])
      if (!list.includes(row.blockName)) list.push(row.blockName)
    }
  }

  const codeChanged = (changed['Code']?.length ?? 0) > 0 || (changed['Interface']?.length ?? 0) > 0
  if (args.save === true && !codeChanged) {
    await projectTexts.saveProject()
  }
  const summary = `Imported ${state}; target coverage ${coverage}/${planDocument.selected.length}.` +
    (codeChanged ? ' Code/Interface fingerprints changed: restore the archive and investigate.' : '')
  return okOutcome(
    PROJECT_TRANSLATE_TOOL,
    scope.view,
    summary,
    {
      action: 'apply',
      state,
      resultPath: asText(importedData?.['resultPath']) ?? null,
      archivePath,
      translatedFile,
      merged,
      coverage: { translated: coverage, selected: planDocument.selected.length },
      fingerprints: changed,
      codeChanged,
    },
    {
      details: [
        `Import state: ${state}`,
        `Coverage: ${coverage}/${planDocument.selected.length}`,
        `Comments changed: ${changed['Comments']?.length ?? 0}; Code changed: ${changed['Code']?.length ?? 0}; Interface changed: ${changed['Interface']?.length ?? 0}`,
        `Archive: ${archivePath ?? 'none'}`,
        `Translated workbook: ${translatedFile}`,
      ],
      warnings: codeChanged
        ? ['Code or Interface fingerprint changed after a text-only import. Restore the archive and investigate before saving.']
        : (changed['Properties']?.length ?? 0) > 0
          ? [`Properties changed for ${changed['Properties']?.length ?? 0} block(s); check whether this is only ModifiedDate.`]
          : [],
      dryRun: false,
    },
  )
}
