/**
 * The knowledge base against the **real** skill registry.
 *
 * `06-skills.test.mjs` drives the provider through the stand-in in
 * `helpers/harness.mjs`, which cannot say whether the harness accepts what the
 * provider returns: candidate validation, duplicate resolution and the rendered
 * `<skill_content>` block all belong to `@deepseek-ai/dsh-skill`. This file
 * mounts that package's real `SkillRegistry` on a bare cordis context, runs the
 * plugin's own `apply`, and asserts what the model would then see. It is the
 * test that fails when DSH changes the provider contract — which is why
 * `scripts/dsh-runtime-cache.mjs` extracts `@deepseek-ai/dsh-skill` next to the
 * packages the plugin itself imports.
 *
 * The bare context has no tool registry, so these tests provide a no-op `tools`
 * service; that is exactly the seam `apply` requires, and nothing else.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, renderSkillContent } from '@deepseek-ai/dsh-skill'

import { loadPlugin, packageRoot } from './helpers/harness.mjs'

const SKILLS = join(packageRoot, 'skills')
const ROUTER = join(SKILLS, 'tia-openness', 'SKILL.md')

/** A root context carrying the real skill registry and a no-op tool registry. */
async function withRegistry(t) {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  const fiber = await ctx.plugin(SkillRegistry)
  t.after(async () => {
    await fiber.dispose()
  })
  return ctx
}

async function loadSkillsModule() {
  // A cache-busting query keeps repeated loads independent inside one test file.
  return await import(`../lib/skills.js?t=${Date.now()}${Math.random()}`)
}

test('the real registry accepts the candidate the provider returns', async (t) => {
  const ctx = await withRegistry(t)
  const { createSkillProvider } = await loadSkillsModule()

  ctx.skills.registerProvider(() => createSkillProvider())

  const catalog = await ctx.skills.list()
  assert.equal(catalog.length, 1, 'the plugin contributes exactly one catalog entry')
  const [summary] = catalog
  assert.equal(summary.name, 'tia-openness')
  assert.equal(summary.provider, 'tia-openness-v17-min')
  assert.equal(summary.source, 'bundled')
  assert.equal(summary.path, ROUTER, 'the UI can preview the file from the catalog')
  assert.deepEqual(summary.resourceBase, { kind: 'directory', path: SKILLS })
  assert.ok(summary.description.length > 0)

  // Two providers with one name are a hard error in a layer, so a composition
  // can never quietly end up with two `tia-openness` entries.
  assert.throws(() => ctx.skills.registerProvider(() => createSkillProvider()), /already registered/)
})

test('a skill loaded through the registry renders with its base directory', async (t) => {
  const ctx = await withRegistry(t)
  const { createSkillProvider } = await loadSkillsModule()
  ctx.skills.registerProvider(() => createSkillProvider())

  const loaded = await ctx.skills.get('tia-openness')
  assert.notEqual(loaded, undefined, 'the catalog name must be loadable')
  assert.equal(loaded.name, 'tia-openness')
  assert.equal(loaded.content.startsWith('---'), false, 'frontmatter is not part of the instructions')
  assert.ok(loaded.content.includes('blocks/SKILL.md'))

  const rendered = renderSkillContent(loaded)
  assert.match(rendered, /^<skill_content name="tia-openness">/)
  assert.match(rendered, /<skill_instructions>[\s\S]*<\/skill_instructions>\n<\/skill_content>$/)
  assert.ok(
    rendered.includes(`Base directory for this skill: ${SKILLS}`),
    'the model needs the absolute base directory to read the vendored files',
  )

  assert.equal(await ctx.skills.get('does-not-exist'), undefined, 'unknown names resolve to nothing')
})

test('apply() registers through the real registry, and unloading removes it', async (t) => {
  const ctx = await withRegistry(t)
  const plugin = await loadPlugin()

  // Mount it the way the loader does, so the plugin's own child plugins (the
  // injected skill registration) belong to a fiber that can be disposed, and so
  // its effects — including the controller subprocess — are torn down with it.
  const fiber = ctx.plugin({
    name: 'probe',
    inject: ['tools'],
    apply: (scoped) => plugin.apply(scoped, {}),
  })
  await fiber
  assert.equal((await ctx.skills.list()).length, 1)
  assert.equal((await ctx.skills.get('tia-openness'))?.name, 'tia-openness')

  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [], 'an unloaded plugin must leave no catalog entry behind')
})
