/**
 * Bundled skill provider for the project-text translation workflow.
 *
 * Registered through `ctx.inject(['skills'], …)` so a composition without
 * `@deepseek-ai/dsh-skill` still loads the tools. The skill is one model-facing
 * document (`skills/project-text-translation/SKILL.md`) that explains the
 * plan → translate → apply → verify → git recommendation sequence; it is not a
 * second implementation of the workflow.
 *
 * @module dsh-engineering-context/skills
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context, Logger } from '@deepseek-ai/cordis'

export const SKILL_PROVIDER = 'engineering-context'
export const SKILL_NAME = 'project-text-translation'
export const SKILLS_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'skills')
export const SKILL_PATH = join(SKILLS_DIR, SKILL_NAME, 'SKILL.md')
const RANK = 600

interface ParsedSkill {
  name: string
  description: string
  content: string
}

function parseSkill(raw: string, path: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error(`${SKILL_PROVIDER}: ${path} has no frontmatter`)
  const fields = new Map<string, string>()
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (field?.[1] !== undefined && field[2] !== undefined) fields.set(field[1], field[2].trim())
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name.length === 0 || description.length === 0) {
    throw new Error(`${SKILL_PROVIDER}: ${path} needs name and description`)
  }
  return { name, description, content: raw.slice(match[0].length).trim() }
}

function createProvider(): DshSkillProvider {
  const router = parseSkill(readFileSync(SKILL_PATH, 'utf8'), SKILL_PATH)
  const invocation: DshSkillInvocation = { modelInvocable: true, userInvocable: true }
  const resourceBase: DshSkillResourceBase = { kind: 'directory', path: SKILLS_DIR }
  const candidate: DshSkillCandidate = {
    name: SKILL_NAME,
    description: router.description,
    invocation,
    provider: SKILL_PROVIDER,
    source: 'bundled',
    rank: RANK,
    resourceBase,
    path: SKILL_PATH,
    locator: SKILL_PATH,
  }
  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, options): Promise<DshSkillDefinition> {
      const raw = await readFile(SKILL_PATH, { encoding: 'utf8', signal: options?.signal })
      const skill = parseSkill(raw, SKILL_PATH)
      return {
        name: SKILL_NAME,
        description: skill.description,
        invocation,
        provider: SKILL_PROVIDER,
        source: 'bundled',
        resourceBase,
        path: SKILL_PATH,
        content: skill.content,
      }
    },
  }
}

/**
 * Register the translation skill when the composition has a skill registry.
 *
 * @param ctx - the plugin context.
 * @param log - the plugin logger.
 */
export function registerSkillProvider(ctx: Context, log: Logger): void {
  if (typeof (ctx as { inject?: unknown }).inject !== 'function') {
    log.debug(`No ctx.inject in this composition; the "${SKILL_NAME}" skill is not registered.`)
    return
  }
  ctx.inject(['skills'], (scoped) => {
    scoped.skills?.registerProvider(() => createProvider())
    log.info(`Registered the bundled skill "${SKILL_NAME}" from ${SKILLS_DIR}.`)
  })
}
