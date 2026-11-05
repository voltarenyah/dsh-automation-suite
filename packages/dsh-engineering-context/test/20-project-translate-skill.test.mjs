/**
 * The translation skill provider.
 *
 * A real skill registry needs `@deepseek-ai/dsh-skill`, which this package does
 * not link; the provider's contract is small enough to assert with a scoped
 * stand-in: it registers once, advertises one candidate, and `get()` returns the
 * packaged body.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { registerSkillProvider, SKILL_NAME, SKILL_PROVIDER } = await import(
  `../lib/skills.js?t=${Date.now()}${Math.random()}`
)

test('registers one model-invocable skill and loads its packaged body', async () => {
  let factory
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['skills'])
      callback({
        skills: {
          registerProvider(create) {
            factory = create
          },
        },
      })
    },
  }
  const logs = []
  const log = { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: () => {}, error: () => {} }
  registerSkillProvider(ctx, log)
  assert.equal(typeof factory, 'function')

  const provider = factory({ signal: new AbortController().signal })
  const candidates = await provider.list()
  assert.equal(provider.name, SKILL_PROVIDER)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, SKILL_NAME)
  assert.equal(candidates[0].invocation.modelInvocable, true)

  const skill = await provider.get(candidates[0])
  assert.equal(skill.name, SKILL_NAME)
  assert.match(skill.content, /project_translate/u)
  assert.match(skill.content, /git commit/u)
})
