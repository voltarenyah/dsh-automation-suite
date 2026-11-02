/**
 * The pure core: parse the view file, filter it, format values.
 *
 * `lib/model.js` is the built module the browser bundle also imports, so these
 * tests pin the same code path the tab runs.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { VIEW_FILE, filterVersions, formatDate, parseView, shortSha, timelineFor } from '../lib/model.js'

const VIEW = {
  device: 'Sino_PEI',
  workspace: 'SWT2_PEI_1026_Night',
  generatedAt: '2026-11-02T12:00:00.000Z',
  counts: { versions: 2, events: 1, baseline: 1377 },
  versions: [
    {
      commit: '17f21d4a8b602ae7095d8200425823762786b368',
      parent: null,
      date: '2026-10-26T22:09:03+08:00',
      subject: 'chore: baseline',
      op: 'create',
      checksum: 'C0 01 C3 13 58 AC 0E 50',
      checksumPrev: null,
      acceptance: null,
      intent: null,
      events: [],
    },
    {
      commit: 'a5f84d5d6cf781c546fa9fda2a144113e26eb3eb',
      parent: '17f21d4a8b602ae7095d8200425823762786b368',
      date: '2026-10-26T22:34:27+08:00',
      subject: 'feat(cav-a): gate full-cycle request',
      op: 'sync',
      checksum: '71 2D DC D7 F9 DF 81 90',
      checksumPrev: 'C0 01 C3 13 58 AC 0E 50',
      acceptance: null,
      intent: 'because the cooling table was blocked',
      events: [
        {
          key: 'blocks|01_Cavity_A|100_Cycle_Selection_Cav_A',
          change: 'modified',
          faces: ['Code', 'Comments'],
          before: { Code: 'aaaaaaaaaaaaaaaaaaaa', Comments: 'bbbbbbbbbbbbbbbbbbbb' },
          after: { Code: 'cccccccccccccccccccc', Comments: 'dddddddddddddddddddd' },
          linesAdded: 461,
          linesRemoved: 243,
          reason: 'because the cooling table was blocked',
          problem: 'cooling-table-blocked',
        },
      ],
    },
  ],
  timeline: [
    { block: 'blocks|01_Cavity_A|100_Cycle_Selection_Cav_A', seq: 2, commit: 'e331d6e1', date: '2026-10-26T22:41:49+08:00', subject: 'docs', faces: ['Comments'], before: {}, after: {}, reason: null, problem: null },
    { block: 'blocks|01_Cavity_A|100_Cycle_Selection_Cav_A', seq: 1, commit: 'a5f84d5d', date: '2026-10-26T22:34:27+08:00', subject: 'feat', faces: ['Code'], before: {}, after: {}, reason: null, problem: null },
  ],
  problems: ['cooling-table-blocked'],
}

describe('parseView', () => {
  it('accepts a well-formed view and keeps the fields the panel prints', () => {
    const parsed = parseView(JSON.stringify(VIEW))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.view.device, 'Sino_PEI')
    assert.equal(parsed.view.versions.length, 2)
    assert.equal(parsed.view.versions[1].events[0].faces.length, 2)
    assert.equal(parsed.view.versions[1].events[0].before.Code, 'aaaaaaaaaaaaaaaaaaaa')
    assert.equal(parsed.view.counts.baseline, 1377)
    assert.equal(parsed.view.problems[0], 'cooling-table-blocked')
  })

  it('refuses text that is not JSON or has no versions array', () => {
    assert.deepEqual(parseView('not json'), { ok: false, code: 'view/invalid-json' })
    assert.deepEqual(parseView('[]'), { ok: false, code: 'view/not-an-object' })
    assert.deepEqual(parseView('{"device":"x"}'), { ok: false, code: 'view/no-versions' })
  })

  it('drops versions without a commit and events without a key', () => {
    const parsed = parseView(
      JSON.stringify({
        versions: [{ subject: 'no commit' }, { commit: 'abc', events: [{ reason: 'no key' }] }],
      }),
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.view.versions.length, 1)
    assert.equal(parsed.view.versions[0].events.length, 0)
  })
})

describe('filterVersions', () => {
  const parsed = parseView(JSON.stringify(VIEW))
  const view = parsed.view

  it('returns everything without filters', () => {
    assert.equal(filterVersions(view, {}).length, 2)
  })

  it('matches the subject, the intent and the event reason', () => {
    assert.equal(filterVersions(view, { query: 'baseline' }).length, 1)
    assert.equal(filterVersions(view, { query: 'cooling' }).length, 1)
    assert.equal(filterVersions(view, { query: 'FB1' }).length, 0)
  })

  it('filters by face and by problem', () => {
    assert.equal(filterVersions(view, { face: 'Code' }).length, 1)
    assert.equal(filterVersions(view, { face: 'Properties' }).length, 0)
    assert.equal(filterVersions(view, { problem: 'cooling-table-blocked' }).length, 1)
  })
})

describe('timelineFor', () => {
  it('returns one block in sequence order', () => {
    const parsed = parseView(JSON.stringify(VIEW))
    const rows = timelineFor(parsed.view, 'blocks|01_Cavity_A|100_Cycle_Selection_Cav_A')
    assert.deepEqual(rows.map((row) => row.seq), [1, 2])
  })
})

describe('formatting', () => {
  it('shows ten characters and an em dash for nothing', () => {
    assert.equal(shortSha('a5f84d5d6cf781c546fa9fda2a144113e26eb3eb'), 'a5f84d5d6c')
    assert.equal(shortSha(null), '—')
    assert.equal(shortSha(''), '—')
  })

  it('keeps an unparseable date as written', () => {
    assert.equal(formatDate('not-a-date', 'en'), 'not-a-date')
  })
})

it('names the view file the host half writes', () => {
  assert.equal(VIEW_FILE, '.dsh/versions-view.json')
})
