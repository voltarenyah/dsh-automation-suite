import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { mergePatches, parsePatch } from './merge-profile.mjs'

const OLD_BASELINE = `# old baseline
- id: system-prompt
  config:
    personaPrefix: base
- id: subagent
  config:
    maxDepth: 1
    maxActiveSubagents: 2
- insert:
    - id: preset-leader
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: leader
`

const OLD_PATCH = `# old baseline
- id: system-prompt
  config:
    personaPrefix: user
- id: subagent
  config:
    maxDepth: 1
    maxActiveSubagents: 2
- id: user-setting
  config:
    requestTimeoutMs: 900000
- insert:
    - id: preset-leader
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: user-edited
`

const NEW_BASELINE = `# new baseline
- id: system-prompt
  config:
    personaPrefix: new-base
- id: subagent
  config:
    maxDepth: 2
    maxActiveSubagents: 3
- id: new-setting
  config:
    value: new
- insert:
    - id: preset-leader
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: leader-v2
`

test('parsePatch finds top-level id blocks and leaves insert blocks opaque', () => {
  const parsed = parsePatch(OLD_BASELINE)
  assert.equal(parsed.preamble.join('\n').trim(), '# old baseline')
  assert.deepEqual(
    parsed.blocks.map((block) => (block.kind === 'id' ? block.id : 'insert')),
    ['system-prompt', 'subagent', 'insert'],
  )
})

test('merge keeps user overrides, takes new baseline defaults, appends new ids, skips old inserts', () => {
  const { text, report } = mergePatches({
    oldPatch: OLD_PATCH,
    oldBaseline: OLD_BASELINE,
    newBaseline: NEW_BASELINE,
  })

  assert.match(text, /personaPrefix: user/u)
  assert.doesNotMatch(text, /personaPrefix: new-base/u)
  assert.match(text, /maxActiveSubagents: 3/u)
  assert.doesNotMatch(text, /maxActiveSubagents: 2/u)
  assert.match(text, /id: new-setting/u)
  assert.match(text, /id: user-setting/u)
  assert.match(text, /id: leader-v2/u)
  assert.doesNotMatch(text, /id: user-edited/u)
  assert.deepEqual(report.replaced.sort(), ['system-prompt'])
  assert.deepEqual(report.appended, ['user-setting'])
  assert.equal(report.skippedInserts, 1)
})

test('an unchanged old entry does not override a changed new baseline', () => {
  const { text } = mergePatches({
    oldPatch: `# old\n- id: subagent\n  config:\n    maxDepth: 1\n`,
    oldBaseline: `# old\n- id: subagent\n  config:\n    maxDepth: 1\n`,
    newBaseline: `# new\n- id: subagent\n  config:\n    maxDepth: 5\n`,
  })
  assert.match(text, /maxDepth: 5/u)
  assert.doesNotMatch(text, /maxDepth: 1/u)
})

test('a user id removed from the new baseline is restored and reported', () => {
  const { text, report } = mergePatches({
    oldPatch: `# old\n- id: removed\n  config:\n    value: user\n`,
    oldBaseline: `# old\n- id: removed\n  config:\n    value: base\n`,
    newBaseline: `# new\n- id: other\n  config:\n    value: new\n`,
  })
  assert.match(text, /id: removed/u)
  assert.deepEqual(report.appended, ['removed'])
  assert.deepEqual(report.restored, ['removed'])
})

test('the real suite patch parses and a self-merge is stable', () => {
  const real = readFileSync(
    fileURLToPath(new URL('../profile/dsh-automation-suite/cordis.patch.yml', import.meta.url)),
    'utf8',
  )
  const parsed = parsePatch(real)
  assert.ok(parsed.blocks.length >= 8)
  const { text, report } = mergePatches({ oldPatch: real, oldBaseline: real, newBaseline: real })
  assert.deepEqual(report.replaced, [])
  assert.deepEqual(report.appended, [])
  assert.match(text, /preset-leader/u)
  assert.match(text, /opencode-go/u)
})

test('CLI writes the merged patch and a JSON report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-profile-'))
  const oldPatch = join(dir, 'old.patch.yml')
  const oldBaseline = join(dir, 'old.base.yml')
  const newBaseline = join(dir, 'new.base.yml')
  const out = join(dir, 'merged.yml')
  const reportPath = join(dir, 'report.json')
  writeFileSync(oldPatch, OLD_PATCH)
  writeFileSync(oldBaseline, OLD_BASELINE)
  writeFileSync(newBaseline, NEW_BASELINE)

  execFileSync(process.execPath, [
    fileURLToPath(new URL('./merge-profile.mjs', import.meta.url)),
    '--old-patch', oldPatch,
    '--old-baseline', oldBaseline,
    '--new-baseline', newBaseline,
    '--out', out,
    '--report', reportPath,
  ], { stdio: 'pipe' })

  assert.match(readFileSync(out, 'utf8'), /id: user-setting/u)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.schemaVersion, 1)
  assert.deepEqual(report.replaced.sort(), ['system-prompt'])
})
