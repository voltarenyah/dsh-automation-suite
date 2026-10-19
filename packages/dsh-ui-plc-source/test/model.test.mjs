/**
 * Unit tests for the pure core. They drive the **built** `lib/model.js`, the same
 * module the bundle inlines, so a mistake in the source cannot pass by being
 * compiled differently.
 *
 * The fixture is a trimmed copy of a real manifest (one FB, one FC, one
 * InstanceDB, one UDT, one tag table, plus one refused object): the shapes and
 * value spellings come from the TIA controller's actual output, not from the
 * type declarations.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALL,
  MANIFEST_FILE,
  SOURCE_DIRECTORY,
  UNKNOWN_TYPE,
  compareNatural,
  deviceOptions,
  errorText,
  fileName,
  filterRows,
  joinPath,
  kindOf,
  parseManifest,
  relativeUnder,
  resourceAddress,
  sizeLabel,
  sortRows,
  typeOptions,
  typeRank,
} from '../lib/model.js'

const MANIFEST = {
  schemaVersion: 1,
  device: 'Sino_PEI',
  blocks: [
    {
      name: 'SCP_IN',
      group: '999_Bibliotheque/Fonctions méthode/1001_SCP_IN/',
      file: 'C:\\ws\\source\\Sino_PEI\\blocks\\999_Bibliotheque\\Fonctions méthode\\1001_SCP_IN\\SCP_IN.xml',
      bytes: 59585,
      category: 'blocks',
      simaticType: 'FB',
      declaredName: 'SCP_IN',
      declaredNumber: '1001',
      programmingLanguage: 'SCL',
      verified: true,
    },
    {
      name: '00_Main',
      file: 'C:\\ws\\source\\Sino_PEI\\blocks\\00_Common_Part\\00_Main.xml',
      bytes: 2048,
      category: 'blocks',
      simaticType: 'OB',
      declaredName: '00_Main',
      declaredNumber: 1,
      verified: false,
    },
    {
      name: 'Deux axes',
      file: 'C:\\ws\\source\\Sino_PEI\\types\\Deux axes.xml',
      category: 'types',
      simaticType: 'PlcStruct',
      declaredName: 'Deux axes',
    },
    {
      name: 'Table de variables standard',
      file: 'C:\\ws\\source\\Sino_PEI\\tag_tables\\Table de variables standard.xml',
      category: 'tag_tables',
      simaticType: 'PlcTagTable',
    },
  ],
  failures: [{ category: 'blocks', name: 'FOB_SAFETY' }],
}

/** @returns {string} the fixture serialized the way the controller writes it. */
const manifestText = () => JSON.stringify(MANIFEST)

describe('parseManifest', () => {
  it('flattens every category and keeps the fields the list renders', () => {
    const parsed = parseManifest(manifestText(), 'Sino_PEI')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 4)
    assert.equal(parsed.failures, 1)

    const [fb, ob, udt, table] = parsed.rows
    assert.equal(fb.name, 'SCP_IN')
    assert.equal(fb.device, 'Sino_PEI')
    assert.equal(fb.kind, 'block')
    assert.equal(fb.simaticType, 'FB')
    assert.equal(fb.number, '1001')
    assert.equal(fb.language, 'SCL')
    assert.equal(fb.bytes, 59585)
    assert.equal(fb.verified, true)
    assert.match(fb.file, /SCP_IN\.xml$/)

    // A numeric declaredNumber still becomes text, and a missing language simply stays absent.
    assert.equal(ob.number, '1')
    assert.equal(ob.language, undefined)
    assert.equal(ob.verified, false)
    assert.equal(ob.bytes, 2048)

    assert.equal(udt.kind, 'type')
    assert.equal(udt.simaticType, 'PlcStruct')
    assert.equal(table.kind, 'tagTable')
    assert.equal(table.bytes, undefined)
  })

  it('does not carry the folder hierarchy into the rows', () => {
    const parsed = parseManifest(manifestText(), 'Sino_PEI')
    assert.equal(parsed.ok, true)
    for (const row of parsed.rows) assert.equal('group' in row, false)
  })

  it('rejects documents that are not a manifest instead of throwing', () => {
    for (const text of ['', 'not json', '[]', '{}', '{"blocks":{}}', 'null']) {
      const parsed = parseManifest(text, 'd')
      assert.equal(parsed.ok, false, `expected a failure for ${JSON.stringify(text)}`)
      assert.equal(parsed.code, 'manifest/invalid')
    }
  })

  it('skips entries that carry no name and falls back to the file name', () => {
    const parsed = parseManifest(
      JSON.stringify({
        blocks: [
          { file: 'C:\\ws\\source\\D\\blocks\\Only_File_Name.xml', simaticType: 'FC' },
          { simaticType: 'FC' },
          'not an object',
        ],
      }),
      'D',
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 1)
    assert.equal(parsed.rows[0].name, 'Only_File_Name.xml')
    assert.equal(parsed.rows[0].simaticType, 'FC')
  })

  it('falls back to failureCount when the failures array is missing', () => {
    const parsed = parseManifest(JSON.stringify({ blocks: [], failureCount: 3 }), 'D')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.failures, 3)
  })
})

describe('kindOf / typeRank', () => {
  it('maps the manifest categories and keeps unknown ones as files', () => {
    assert.equal(kindOf('blocks'), 'block')
    assert.equal(kindOf('types'), 'type')
    assert.equal(kindOf('tag_tables'), 'tagTable')
    assert.equal(kindOf('something-else'), 'file')
    assert.equal(kindOf(undefined), 'file')
  })

  it('orders the known types and sorts unknown ones last', () => {
    assert.ok(typeRank('OB') < typeRank('FB'))
    assert.ok(typeRank('FB') < typeRank('FC'))
    assert.ok(typeRank('PlcStruct') < typeRank('PlcTagTable'))
    assert.equal(typeRank(UNKNOWN_TYPE), typeRank('FB') + 7)
    assert.equal(typeRank('OB'), 0)
  })
})

describe('compareNatural / sortRows', () => {
  it('compares digit runs by value, then by length', () => {
    assert.ok(compareNatural('2_x', '10_x') < 0)
    assert.ok(compareNatural('10_x', '2_x') > 0)
    assert.equal(compareNatural('Same', 'same'), 0)
    assert.ok(compareNatural('abc', 'abcd') < 0)
  })

  it('orders by type first, then by name', () => {
    const parsed = parseManifest(manifestText(), 'Sino_PEI')
    const rows = sortRows(parsed.rows)
    assert.deepEqual(
      rows.map((row) => row.simaticType),
      ['OB', 'FB', 'PlcStruct', 'PlcTagTable'],
    )
  })

  it('does not mutate its input', () => {
    const parsed = parseManifest(manifestText(), 'Sino_PEI')
    const before = parsed.rows.map((row) => row.name)
    sortRows(parsed.rows)
    assert.deepEqual(
      parsed.rows.map((row) => row.name),
      before,
    )
  })
})

describe('options and filtering', () => {
  const rows = parseManifest(manifestText(), 'Sino_PEI').rows

  it('counts devices and types', () => {
    assert.deepEqual(deviceOptions(rows), [{ value: 'Sino_PEI', count: 4 }])
    assert.deepEqual(typeOptions(rows), [
      { value: 'OB', count: 1 },
      { value: 'FB', count: 1 },
      { value: 'PlcStruct', count: 1 },
      { value: 'PlcTagTable', count: 1 },
    ])
  })

  it('filters by device, by type, and by both', () => {
    assert.equal(filterRows(rows, ALL, ALL).length, 4)
    assert.equal(filterRows(rows, 'Sino_PEI', ALL).length, 4)
    assert.equal(filterRows(rows, 'Other', ALL).length, 0)
    assert.equal(filterRows(rows, ALL, 'FB').length, 1)
    assert.equal(filterRows(rows, ALL, 'FB')[0].name, 'SCP_IN')
    assert.equal(filterRows(rows, 'Sino_PEI', 'PlcStruct').length, 1)
    assert.equal(filterRows(rows, 'Other', 'FB').length, 0)
  })

  it('keeps the filter options independent of the current selection', () => {
    // The panel derives both option lists from ALL rows, so narrowing one
    // filter never removes the other filter's choices.
    assert.equal(typeOptions(rows).length, 4)
    assert.equal(deviceOptions(rows).length, 1)
  })
})

describe('paths', () => {
  it('joins with the separator the parent already uses', () => {
    assert.equal(joinPath('C:\\ws\\source', 'Sino_PEI'), 'C:\\ws\\source\\Sino_PEI')
    assert.equal(joinPath('/home/u/source', 'PLC_1'), '/home/u/source/PLC_1')
    assert.equal(joinPath('C:\\ws\\source\\', 'PLC_1'), 'C:\\ws\\source\\PLC_1')
    assert.equal(joinPath('', 'name'), 'name')
  })

  it('reads the last path segment', () => {
    assert.equal(fileName('C:\\ws\\source\\D\\a.xml'), 'a.xml')
    assert.equal(fileName('/home/u/a.xml'), 'a.xml')
    assert.equal(fileName('no-separator'), 'no-separator')
  })

  it('relativizes against the workspace root, case-insensitively on Windows', () => {
    const root = 'C:\\Users\\Ansel\\ws'
    assert.equal(relativeUnder(root, 'C:\\Users\\Ansel\\ws\\source\\D\\a.xml'), 'source/D/a.xml')
    assert.equal(relativeUnder(root, 'c:\\users\\ansel\\ws\\source\\D\\a.xml'), 'source/D/a.xml')
    assert.equal(relativeUnder(root, '/home/other/a.xml'), null)
    assert.equal(relativeUnder(root, 'C:\\Users\\Ansel\\wsx\\a.xml'), null)
    assert.equal(relativeUnder(root, root), '')
  })

  it('builds an encoded resource address', () => {
    assert.equal(
      resourceAddress('session-1', 'source/D/blocks/Fonctions méthode/X.xml'),
      'dsh-resource://file/session/session-1/source/D/blocks/Fonctions%20m%C3%A9thode/X.xml',
    )
    assert.equal(
      resourceAddress('s', 'source/D/a#b.xml'),
      'dsh-resource://file/session/s/source/D/a%23b.xml',
    )
    assert.equal(resourceAddress('s', 'source/D/a.xml'), 'dsh-resource://file/session/s/source/D/a.xml')
    assert.equal(resourceAddress('s', ''), 'dsh-resource://file/session/s/')
  })
})

describe('copy', () => {
  it('explains the codes the host actually returns, and never throws on unknown ones', () => {
    assert.match(errorText('workspace-file/not-found'), /create_engineering_project/)
    assert.match(errorText('workspace-file/outside-workspace'), /工作区之外/)
    assert.match(errorText('workspace-file/too-large'), /上限/)
    assert.match(errorText('manifest/invalid'), /无法解析/)
    assert.match(errorText('gateway/cancelled'), /取消/)
    assert.match(errorText('gateway/lookup-not-found'), /宿主管不到/)
    assert.match(errorText('gateway/broken'), /gateway\/broken/)
    assert.match(errorText('some/other'), /some\/other/)
  })

  it('formats sizes and tolerates a missing one', () => {
    assert.equal(sizeLabel(undefined), '')
    assert.equal(sizeLabel(-1), '')
    assert.equal(sizeLabel(0), '0 B')
    assert.equal(sizeLabel(1023), '1023 B')
    assert.equal(sizeLabel(1024), '1 KB')
    assert.equal(sizeLabel(59585), '58.2 KB')
    assert.equal(sizeLabel(1024 * 1024), '1 MB')
  })

  it('exports the constants the panel relies on', () => {
    assert.equal(SOURCE_DIRECTORY, 'source')
    assert.equal(MANIFEST_FILE, '_tia-openness-manifest.json')
    assert.equal(ALL, 'all')
  })
})
