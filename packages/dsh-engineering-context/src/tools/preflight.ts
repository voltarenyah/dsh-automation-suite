/**
 * `import_preflight` — say what TIA will refuse before an import transaction starts.
 *
 * The tool is read-only on both sides: it parses the XML files with the built-in
 * parser and reads the target project's languages and object names through the
 * interface plugin's service. It never calls `ImportBlocks` and never writes.
 *
 * Design constraints that come from the host:
 *
 *   - **The target is the workspace's own open project.** An import always goes
 *     into the project TIA currently holds, so the preflight checks that project.
 *     A stopped controller or a closed project degrades to the XML-only checks
 *     (language and name checks are skipped with a warning), never to a failure.
 *   - **A refused dependency is not a verdict.** The preflight only says "this
 *     file references X and X is neither in the batch nor in the target"; a
 *     system library or DriveLib type that TIA resolves itself is reported as a
 *     warning, not as a blocker.
 *
 * @module dsh-engineering-context/tools/preflight
 */

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  engineeringAccess,
  normalizeObjectListing,
  normalizeProjectLanguages,
  normalizeSession,
  type EngineeringAccessLike,
} from '../access.js'
import { EngineeringContextError } from '../errors.js'
import { buildPreflight, expandImportPaths, parseXmlFile, type PreflightIssue, type PreflightObject, type PreflightTarget } from '../preflight.js'
import { resolveScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { MAX_LISTED, cappedList, defineOutcomeTool, failedOutcome, okOutcome, type EngineeringOutcome } from './outcome.js'

/** The tool name, shared by the registrar and the tests. */
export const IMPORT_PREFLIGHT_TOOL = 'import_preflight'

const PARAMETERS = {
  import_paths: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description:
      'Files or directories you intend to pass to import_blocks, absolute or relative to the session workspace. Directories ' +
      'are scanned recursively for *.xml. The preflight reads them only; nothing is imported.',
  },
  reference: {
    type: 'string',
    description:
      'Optional provenance label for the batch, for example "SWT2@4af0a95". It is echoed in the result; pass the same value ' +
      'to import_blocks(reference=...) and project_commit(reference=...) so the origin of the objects survives in history.',
  },
} as const

type PreflightArgs = InferArgs<typeof PARAMETERS>

/** One issue rendered for the model. */
function issueLine(issue: PreflightIssue): string {
  return `${issue.code}${issue.object === null ? '' : ` [${issue.object}]`}: ${issue.message} — ${issue.fix}`
}

/** Render a bounded issue list. */
function issues(section: string, entries: readonly PreflightIssue[]): string[] {
  if (entries.length === 0) return []
  return [`${section} (${entries.length}):`, ...cappedList(entries, (issue) => `  - ${issueLine(issue)}`, MAX_LISTED)]
}

/**
 * Read the target project's facts through the interface plugin.
 *
 * @param service - the service, or undefined when the composition has none.
 * @param signal - the call's cancellation.
 * @returns the target facts (possibly partial) and warnings; never throws for a
 *   transport problem, because a preflight without TIA is still useful.
 */
async function readTarget(
  service: EngineeringAccessLike | undefined,
  signal: AbortSignal | undefined,
): Promise<{ target: PreflightTarget | null; warnings: string[] }> {
  const warnings: string[] = []
  if (service === undefined) {
    warnings.push('This composition has no engineeringAccess service, so the target language and name checks were skipped.')
    return { target: null, warnings }
  }
  if (typeof service.listObjects !== 'function' || typeof service.readProjectLanguages !== 'function') {
    warnings.push(
      'The installed TIA interface plugin has no listObjects/readProjectLanguages on its service, so target language and name ' +
        'checks were skipped. Update dsh-tia-openness-v17-min to a build that provides both.',
    )
    return { target: null, warnings }
  }

  let session
  try {
    session = normalizeSession(await service.readTiaSession({ signal }))
  } catch (error) {
    warnings.push(
      `The TIA session could not be read (${error instanceof Error ? error.message : String(error)}), so target checks were skipped.`,
    )
    return { target: null, warnings }
  }
  if (!session.running) {
    warnings.push('No TIA Openness controller is running, so target language and name checks were skipped.')
    return { target: null, warnings }
  }
  if (!session.projectOpen) {
    warnings.push('TIA has no project open, so target language and name checks were skipped. Open the target project and re-run.')
    return { target: null, warnings }
  }

  let activeLanguages: string[] | null = null
  try {
    const languages = normalizeProjectLanguages(await service.readProjectLanguages({ signal }))
    if (languages === null) warnings.push('The target project languages could not be read; the culture check was skipped.')
    else activeLanguages = languages.active
  } catch (error) {
    warnings.push(
      `Reading the target languages failed (${error instanceof Error ? error.message : String(error)}); the culture check was skipped.`,
    )
  }

  let existing: Set<string> | null = null
  let listingTruncated = false
  try {
    const listing = normalizeObjectListing(
      await service.listObjects({
        categories: ['blocks', 'types', 'tag_tables'],
        maxItems: 5000,
        signal,
      }),
    )
    if (!listing.ok) {
      warnings.push(
        `The target object listing failed${listing.error === null ? '' : ` (${listing.error.code}: ${listing.error.message})`}, ` +
          'so the "already exists" check was skipped.',
      )
    } else {
      existing = new Set(listing.objects.map((entry) => `${entry.category}:${entry.name.toLowerCase()}`))
      listingTruncated = listing.truncated
    }
  } catch (error) {
    warnings.push(
      `Listing the target project's objects failed (${error instanceof Error ? error.message : String(error)}); the name check was skipped.`,
    )
  }

  return {
    target: { projectName: session.projectName, activeLanguages, existing, listingTruncated },
    warnings,
  }
}

/**
 * Build the definition of `import_preflight`.
 *
 * @param dependencies - the plugin context and configuration.
 * @returns a registry-ready definition.
 */
export function importPreflightTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: IMPORT_PREFLIGHT_TOOL,
    description:
      'Check a batch of Simatic ML XML files against the CURRENTLY OPEN TIA project before importing, and report which files ' +
      'will make the import transaction fail: multilingual text in a culture the project does not have activated, objects that ' +
      'already exist under the same name, duplicate names inside the batch, and dependencies the batch or the project does not ' +
      'contain (imported in the wrong order, or missing entirely). Read-only on both sides: it never imports and never writes. ' +
      'It does NOT check block numbers (TIA assigns them on import) nor calls inside networks (ask the knowledge graph). ' +
      'Without an open project it still checks the XML alone and says which checks were skipped. Run it, then call ' +
      'import_blocks with the paths in suggestedOrder and the same reference value.',
    parameters: PARAMETERS,
    async execute(args: PreflightArgs, exec): Promise<EngineeringOutcome> {
      try {
      const paths = (args.import_paths ?? []).map((entry) => String(entry)).filter((entry) => entry.trim().length > 0)
      if (paths.length === 0) {
        throw new EngineeringContextError('invalid_argument', 'import_paths is required and must name at least one file or directory.', {
          parameter: 'import_paths',
        })
      }
      const scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
      const cwd = scope.workspace.path
      const expanded = await expandImportPaths(paths, cwd)
      const objects: PreflightObject[] = []
      for (const file of expanded.files) objects.push(await parseXmlFile(file))

      const { target, warnings: targetWarnings } = await readTarget(engineeringAccess(dependencies.ctx), exec.signal)
      const report = buildPreflight(objects, target)
      const warnings = [...expanded.warnings, ...targetWarnings, ...report.warnings.map((issue) => issueLine(issue))]
      const blocking = report.blocking.map((issue) => issueLine(issue))

      const reference = typeof args.reference === 'string' ? args.reference.trim() : ''
      const targetLine =
        target === null
          ? 'Target: unknown (no open project or no TIA service) — only the XML checks ran.'
          : `Target: ${target.projectName ?? '(unnamed project)'} — active languages: ` +
            `${target.activeLanguages === null ? 'unknown' : target.activeLanguages.join(', ') || 'none'}; ` +
            `${target.existing === null ? 'existing objects not checked' : `${target.existing.size} existing object(s) known`}`

      const details: string[] = [
        targetLine,
        `Batch: ${report.stats.files} file(s) — ${report.stats.parsed} parsed, ${report.stats.unparsed} unparsable; ` +
          `${report.stats.blocks} block(s), ${report.stats.types} type(s), ${report.stats.tagTables} tag table(s).`,
        ...issues('BLOCKING', report.blocking),
        ...issues('Warnings', report.warnings),
      ]
      if (report.suggestedOrder.length > 0) {
        details.push('Suggested import order (types first, instance DBs after their FBs):')
        details.push(...cappedList(report.suggestedOrder, (path) => `  ${path}`, 10))
      }
      if (reference.length > 0) {
        details.push(`Reference: ${reference} — pass the same value to import_blocks(reference=...) and project_commit(reference=...).`)
      }

      const summary =
        report.blocking.length > 0
          ? `DO NOT IMPORT YET: ${report.blocking.length} blocking issue(s) across ${report.stats.files} file(s); ${report.warnings.length} warning(s).`
          : `${report.stats.files} file(s) checked: no blocking issue${report.warnings.length === 0 ? '' : `; ${report.warnings.length} warning(s)`}.`

      return okOutcome(
        IMPORT_PREFLIGHT_TOOL,
        scope.view,
        summary,
        {
          reference: reference.length === 0 ? null : reference,
          target:
            target === null
              ? null
              : {
                  projectName: target.projectName,
                  activeLanguages: target.activeLanguages,
                  existingObjects: target.existing === null ? null : target.existing.size,
                  listingTruncated: target.listingTruncated,
                },
          stats: report.stats,
          blocking: report.blocking,
          warnings: report.warnings,
          objects: report.objects.map((entry) => ({
            path: entry.path,
            kind: entry.kind,
            xmlRoot: entry.xmlRoot,
            name: entry.name,
            number: entry.number,
            cultures: entry.cultures,
            dependencies: entry.dependencies,
            instanceOf: entry.instanceOf,
            instanceDb: entry.instanceDb,
            error: entry.error,
          })),
          suggestedOrder: report.suggestedOrder,
        },
        { details, warnings, dryRun: true },
      )
      } catch (error) {
        return failedOutcome(IMPORT_PREFLIGHT_TOOL, null, error)
      }
    },
  })
}
