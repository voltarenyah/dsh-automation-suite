/**
 * The bundled knowledge base.
 *
 * The plugin vendors the upstream Siemens Openness skills under `skills/` and
 * advertises exactly one model-invocable skill — the `tia-openness` router — so
 * the session catalog stays one line while the model can still page the 31
 * upstream files on demand. These tests pin the contract that makes that safe:
 * one candidate, a resource base that really contains the files the router
 * names, a body below the preset's pruning threshold, and a plugin that still
 * loads when the composition has no skill registry at all.
 *
 * Byte-level freshness of the vendored tree is owned by
 * `scripts/knowledge/build-skills.mjs --check` (`npm run skills:check`), not by
 * this file: have a look at `skills/README.md`.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTestContext, EXPECTED_TOOLS, loadPlugin, packageRoot, withPlugin } from './helpers/harness.mjs'

const SKILLS = join(packageRoot, 'skills')
const ROUTER = join(SKILLS, 'tia-openness', 'SKILL.md')
/** The standard preset prunes tool results above this many code points. */
const MAX_ROUTER_CHARS = 8192
/** The session catalog truncates each description to this many characters by default. */
const MAX_CATALOG_DESCRIPTION_CHARS = 500

const manifest = JSON.parse(readFileSync(join(SKILLS, 'UPSTREAM.json'), 'utf8'))
const vendored = Object.keys(manifest.skills)

test('apply registers the knowledge base on the skill registry, through ctx.inject', async (t) => {
  const { harness } = await withPlugin(t)

  assert.deepEqual(harness.injectedServices, [['skills']], 'the skill registry must be injected, not read directly')
  assert.equal(harness.skillProviders.length, 1, 'exactly one bundled skill provider is registered')
  assert.equal(harness.skillProviders[0].name, 'tia-openness-v17-min')

  // The knowledge base must never gate the tools: a profile without the skill
  // registry has to keep working, which is why `skills` is not in the
  // module-level inject (test 01 pins that).
  assert.deepEqual(harness.registered().sort(), [...EXPECTED_TOOLS].sort())
  assert.equal(
    harness.logs.some(([, , message]) => message.includes('tia-openness')),
    true,
    'the registration is reported to the operator',
  )
})

test('a composition without a skill registry still loads every tool', async (t) => {
  const plugin = await loadPlugin()
  const harness = createTestContext({ skills: false })
  t.after(async () => {
    await harness.unload()
  })

  plugin.apply(harness.ctx, {})

  assert.deepEqual(harness.injectedServices, [['skills']], 'the plugin asks for the registry and moves on')
  assert.equal(harness.skillProviders.length, 0)
  assert.deepEqual(harness.registered().sort(), [...EXPECTED_TOOLS].sort(), 'the tools are unaffected')
})

test('the provider advertises exactly one skill, sized for the session catalog', async (t) => {
  const { harness } = await withPlugin(t)
  const candidates = await harness.skillProviders[0].list()

  assert.equal(candidates.length, 1, '31 separate catalog entries would cost every session context')
  const [candidate] = candidates
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidate.name, 'tia-openness')
  assert.equal(candidate.provider, 'tia-openness-v17-min')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, 600, 'packaged providers use BUNDLED_SKILL_RANK')
  assert.equal(candidate.path, ROUTER, 'the catalog path lets the UI open the SKILL.md')
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.equal(candidate.resourceBase.path, SKILLS)
  assert.ok(candidate.description.length > 0 && candidate.description.length <= MAX_CATALOG_DESCRIPTION_CHARS)
})

test('get() returns the router body and an existing file behind every reference', async (t) => {
  const { harness } = await withPlugin(t)
  const provider = harness.skillProviders[0]
  const [candidate] = await provider.list()
  const skill = await provider.get(candidate)

  assert.equal(skill.name, candidate.name, 'the registry drops a skill whose get() renames it')
  assert.equal(skill.content.startsWith('---'), false, 'the served body carries no frontmatter')
  assert.ok(skill.content.includes('blocks/SKILL.md'), 'the body is the routing index')

  const raw = readFileSync(ROUTER, 'utf8')
  assert.ok(raw.length <= MAX_ROUTER_CHARS, `the router is ${raw.length} chars; above ${MAX_ROUTER_CHARS} the pruner trims it`)

  const referenced = [...new Set([...raw.matchAll(/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g)].map((match) => match[1]))]
  assert.ok(referenced.length >= 20, 'the index covers the vendored set')
  for (const name of referenced) {
    assert.ok(vendored.includes(name), `the router references ${name}/SKILL.md, which is not vendored`)
    assert.ok(existsSync(join(SKILLS, name, 'SKILL.md')), `${name}/SKILL.md is missing`)
  }
})

test('the vendored tree matches the manifest it ships with', () => {
  assert.equal(manifest.commit, 'b5c7041648dc10f9225ef082306ade6c335b8771', 'the upstream revision is pinned')
  assert.equal(manifest.license.spdx, 'MIT')
  assert.ok(existsSync(join(SKILLS, manifest.license.vendoredAs)), 'MIT requires shipping the license text')

  for (const name of vendored) {
    const path = join(SKILLS, name, 'SKILL.md')
    assert.ok(existsSync(path), `${name}/SKILL.md is missing`)
    const bytes = readFileSync(path)
    assert.equal(bytes.length, manifest.skills[name].bytes, `${name}/SKILL.md was edited (size)`)
    const raw = bytes.toString('utf8')
    assert.match(raw, new RegExp(`^name: ${name}$`, 'm'), `${name}/SKILL.md declares another name`)
    assert.match(raw, /^description: .+$/m, `${name}/SKILL.md has no description`)
  }

  const onDisk = readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(onDisk, [...vendored, ...manifest.localSkills].sort(), 'no unplanned skill directories')
})

test('every tool description points the model at the skill', async (t) => {
  const { harness } = await withPlugin(t)

  for (const definition of harness.definitions) {
    assert.ok(
      definition.description.includes('`tia-openness` skill'),
      `${definition.name} must point at the knowledge base where the model actually reads it`,
    )
  }
})
