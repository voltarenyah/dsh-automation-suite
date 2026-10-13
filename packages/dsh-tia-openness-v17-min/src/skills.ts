/**
 * Bundled skill provider: serves the vendored Openness knowledge base as one
 * model-invocable routing skill.
 *
 * `skills/` ships inside this package (see `skills/README.md`): 31 upstream
 * Siemens skills, byte-for-byte verbatim, plus the `tia-openness` router that
 * indexes them. Advertising exactly *one* skill is deliberate. The session
 * catalog is a durable message the model re-reads on every request, and its
 * per-entry description is capped at 500 characters, so registering all 31 would
 * spend context in every session — including the ones that never touch TIA
 * Portal. The router costs one line and still hands the model an absolute base
 * directory, from which it pages the upstream files on demand with `read`.
 *
 * The provider is registered through `ctx.inject(['skills'], …)` and never
 * through this plugin's top-level `inject`: a profile that does not mount
 * `@deepseek-ai/dsh-skill` must still load the six TIA tools, and a top-level
 * requirement would leave the whole plugin waiting for a service that never
 * appears.
 *
 * @module dsh-tia-openness-v17-min/skills
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { LogSink } from './controller.js'

/** Provider name registered on `ctx.skills`; every candidate must report the same one. */
export const SKILL_PROVIDER = 'tia-openness-v17-min'

/** The only skill this plugin advertises to the model. */
export const ROUTER_SKILL = 'tia-openness'

/** Standard precedence rank for packaged providers (`BUNDLED_SKILL_RANK`). */
export const BUNDLED_SKILL_RANK = 600

/** `skills/` beside the built `lib/`: the base directory every reference resolves against. */
export const SKILLS_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'skills')

/** The router's instruction file; also exposed as the catalog `path` for previews. */
export const ROUTER_PATH = join(SKILLS_DIR, ROUTER_SKILL, 'SKILL.md')

/** One parsed skill file. */
export interface ParsedSkill {
  /** Frontmatter `name`. */
  readonly name: string
  /** Frontmatter `description`; this is what the session catalog shows. */
  readonly description: string
  /** The body without its frontmatter, exactly as the model should read it. */
  readonly content: string
}

/**
 * Parses the frontmatter subset these skill files use.
 *
 * Top-level `key: value` pairs only — the nested `metadata:` block of the
 * upstream files is intentionally ignored, because nothing here consumes it.
 * Deliberately dependency-free: this plugin ships no YAML parser, and the
 * build-time freshness gate (`scripts/knowledge/build-skills.mjs`) validates
 * the same fields from the same shape.
 *
 * @param raw - the whole file.
 * @param path - the file path, for error messages.
 * @returns the name, description and body.
 * @throws when the file has no frontmatter or misses name/description.
 */
export function parseSkill(raw: string, path: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error(`${SKILL_PROVIDER}: ${path} has no YAML frontmatter`)

  const fields = new Map<string, string>()
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    const key = field?.[1]
    const value = field?.[2]
    if (key !== undefined && value !== undefined) fields.set(key, value.trim())
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name.length === 0) throw new Error(`${SKILL_PROVIDER}: ${path} has no frontmatter name`)
  if (description.length === 0) throw new Error(`${SKILL_PROVIDER}: ${path} has no frontmatter description`)
  return { name, description, content: raw.slice(match[0].length).trim() }
}

/**
 * Builds the immutable provider over the packaged `skills/` directory.
 *
 * `list()` reads the router once so the catalog has a description immediately;
 * `get()` re-reads the file, so editing `skills/tia-openness/SKILL.md` shows up
 * on the next load without restarting the host.
 *
 * @returns the provider object handed to `ctx.skills.registerProvider`.
 */
export function createSkillProvider(): DshSkillProvider {
  const router = parseSkill(readFileSync(ROUTER_PATH, 'utf8'), ROUTER_PATH)
  const invocation = { modelInvocable: true, userInvocable: true }
  const resourceBase: DshSkillResourceBase = { kind: 'directory', path: SKILLS_DIR }
  const candidate: DshSkillCandidate = {
    name: ROUTER_SKILL,
    description: router.description,
    invocation,
    provider: SKILL_PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase,
    path: ROUTER_PATH,
    locator: ROUTER_PATH,
  }

  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, options): Promise<DshSkillDefinition> {
      const body = await readFile(ROUTER_PATH, { encoding: 'utf8', signal: options?.signal })
      const skill = parseSkill(body, ROUTER_PATH)
      return {
        name: ROUTER_SKILL,
        description: skill.description,
        invocation,
        provider: SKILL_PROVIDER,
        source: 'bundled',
        resourceBase,
        path: ROUTER_PATH,
        content: skill.content,
      }
    },
  }
}

/**
 * Registers the knowledge base with the skill registry of this composition.
 *
 * Called from `apply`. When the composition has no skill registry the injected
 * callback never runs and the plugin is unaffected, which is the whole point of
 * the scoped injection; the six tools keep working either way.
 *
 * @param ctx - the plugin context.
 * @param log - the plugin logger, used to report the registration.
 */
export function registerSkillProvider(ctx: Context, log: LogSink): void {
  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => createSkillProvider())
    log.info(
      `The bundled skill "${ROUTER_SKILL}" is registered from ${SKILLS_DIR}: 31 vendored Siemens Openness skills, ` +
        `loaded on demand (${SKILL_PROVIDER}).`,
    )
  })
}
