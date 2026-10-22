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
  MENTION_HEADER,
  SOURCE_DIRECTORY,
  UNKNOWN_TYPE,
  compareNatural,
  deviceOptions,
  errorCopy,
  fileName,
  filterRows,
  joinPath,
  kindOf,
  matchesQuery,
  mentionContext,
  mentionNames,
  mentionOf,
  nextMention,
  parseManifest,
  referenceLine,
  relativeUnder,
  resourceAddress,
  rowKey,
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
  failures: [
    {
      category: 'blocks',
      name: 'FOB_SAFETY',
      group: '000_SAFETY_TASK/',
      file: 'C:\\ws\\source\\Sino_PEI\\blocks\\000_SAFETY_TASK\\FOB_SAFETY.xml',
      code: 'export_failed',
      message: "The export of block 'FOB_SAFETY' is not permitted.",
    },
  ],
}

/** @returns {string} the fixture serialized the way the controller writes it. */
const manifestText = () => JSON.stringify(MANIFEST)

describe('parseManifest', () => {
  it('flattens every category and keeps the fields the list renders', () => {
    const parsed = parseManifest(manifestText(), 'Sino_PEI')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 5)
    assert.equal(parsed.failures, 1)

    const [fb, ob, udt, table, refused] = parsed.rows
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

    // A refused object is a row too: it has no usable file, but it does carry the
    // reason, so the list can show which objects the export skipped.
    assert.equal(refused.name, 'FOB_SAFETY')
    assert.equal(refused.refused, true)
    assert.equal(refused.kind, 'block')
    assert.equal(refused.simaticType, UNKNOWN_TYPE)
    assert.equal(refused.verified, false)
    assert.equal(refused.bytes, undefined)
    assert.equal(refused.reason, "The export of block 'FOB_SAFETY' is not permitted.")
    assert.match(refused.file, /FOB_SAFETY\.xml$/)
  })

  it('falls back to the failure code when no message is recorded', () => {
    const parsed = parseManifest(
      JSON.stringify({ blocks: [], failures: [{ category: 'blocks', name: 'X', code: 'export_failed' }] }),
      'D',
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 1)
    assert.equal(parsed.rows[0].reason, 'export_failed')
  })

  it('ignores unusable failure entries instead of dropping the whole manifest', () => {
    const parsed = parseManifest(
      JSON.stringify({ blocks: [], failures: [{ code: 'x' }, 'nope', null, { name: 'Named' }] }),
      'D',
    )
    assert.equal(parsed.ok, true)
    assert.deepEqual(
      parsed.rows.map((row) => row.name),
      ['Named'],
    )
    assert.equal(parsed.failures, 4)
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
      ['OB', 'FB', 'PlcStruct', 'PlcTagTable', UNKNOWN_TYPE],
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
    assert.deepEqual(deviceOptions(rows), [{ value: 'Sino_PEI', count: 5 }])
    assert.deepEqual(typeOptions(rows), [
      { value: 'OB', count: 1 },
      { value: 'FB', count: 1 },
      { value: 'PlcStruct', count: 1 },
      { value: 'PlcTagTable', count: 1 },
      { value: UNKNOWN_TYPE, count: 1 },
    ])
  })

  it('filters by device, by type, and by both', () => {
    assert.equal(filterRows(rows, ALL, ALL).length, 5)
    assert.equal(filterRows(rows, 'Sino_PEI', ALL).length, 5)
    assert.equal(filterRows(rows, 'Other', ALL).length, 0)
    assert.equal(filterRows(rows, ALL, 'FB').length, 1)
    assert.equal(filterRows(rows, ALL, 'FB')[0].name, 'SCP_IN')
    assert.equal(filterRows(rows, 'Sino_PEI', 'PlcStruct').length, 1)
    assert.equal(filterRows(rows, 'Other', 'FB').length, 0)
  })

  it('filters by name and by number, case-insensitively', () => {
    assert.equal(filterRows(rows, ALL, ALL, '').length, 5)
    assert.equal(filterRows(rows, ALL, ALL, '   ').length, 5)
    assert.deepEqual(
      filterRows(rows, ALL, ALL, 'scp').map((row) => row.name),
      ['SCP_IN'],
    )
    assert.deepEqual(
      filterRows(rows, ALL, ALL, '1001').map((row) => row.name),
      ['SCP_IN'],
    )
    assert.deepEqual(
      filterRows(rows, ALL, ALL, 'FOB').map((row) => row.name),
      ['FOB_SAFETY'],
    )
    assert.equal(filterRows(rows, ALL, ALL, 'nothing-matches').length, 0)
    // The query composes with the other two filters instead of replacing them.
    assert.equal(filterRows(rows, 'Sino_PEI', 'FB', 'scp').length, 1)
    assert.equal(filterRows(rows, 'Sino_PEI', 'OB', 'scp').length, 0)
  })

  it('matches name and number independently of the rest of the row', () => {
    assert.equal(matchesQuery({ name: 'SCP_IN', number: '1001' }, 'p_i'), true)
    assert.equal(matchesQuery({ name: 'SCP_IN', number: '1001' }, '100'), true)
    assert.equal(matchesQuery({ name: 'SCP_IN' }, '1001'), false)
    assert.equal(matchesQuery({ name: 'SCP_IN', number: '1001' }, ''), true)
  })

  it('identifies a row by device, type, name, number and whether it was refused', () => {
    const exported = { device: 'D', simaticType: 'FB', name: 'X', number: '1' }
    assert.equal(rowKey(exported), 'D\u0000FB\u0000X\u00001\u0000exported')
    assert.notEqual(rowKey(exported), rowKey({ ...exported, refused: true }))
    assert.notEqual(rowKey(exported), rowKey({ ...exported, number: '2' }))
    assert.notEqual(rowKey(exported), rowKey({ ...exported, device: 'E' }))
    assert.equal(rowKey({ device: 'D', simaticType: 'FB', name: 'X' }), 'D\u0000FB\u0000X\u0000\u0000exported')
  })

  it('keeps the filter options independent of the current selection', () => {
    // The panel derives both option lists from ALL rows, so narrowing one
    // filter never removes the other filter's choices.
    assert.equal(typeOptions(rows).length, 5)
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
  it('maps the codes the host actually returns to their dictionary keys', () => {
    // The copy itself lives in the locale dictionaries, so a language switch
    // re-renders it; the model only decides which key explains a code.
    assert.deepEqual(errorCopy('workspace-file/not-found'), {
      key: 'error.notFound',
      code: 'workspace-file/not-found',
    })
    assert.equal(errorCopy('workspace-file/outside-workspace').key, 'error.outsideWorkspace')
    assert.equal(errorCopy('workspace-file/not-directory').key, 'error.notDirectory')
    assert.equal(errorCopy('workspace-file/not-regular-file').key, 'error.notRegularFile')
    assert.equal(errorCopy('workspace-file/too-large').key, 'error.tooLarge')
    assert.equal(errorCopy('workspace-file/not-text').key, 'error.notText')
    assert.equal(errorCopy('workspace-file/watch-unsupported').key, 'error.watchUnsupported')
    assert.equal(errorCopy('manifest/invalid').key, 'error.manifestInvalid')
    assert.equal(errorCopy('gateway/cancelled').key, 'error.cancelled')
    assert.equal(errorCopy('gateway/lookup-not-found').key, 'error.lookupNotFound')
    // Any other transport failure, and anything unrecognized, still resolves.
    assert.equal(errorCopy('gateway/broken').key, 'error.gateway')
    assert.equal(errorCopy('gateway/broken').code, 'gateway/broken')
    assert.equal(errorCopy('some/other').key, 'error.other')
    assert.equal(errorCopy('').key, 'error.other')
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
    assert.equal(MANIFEST_FILE, '_manifest.json')
    assert.equal(ALL, 'all')
  })
})

describe('mentions', () => {
  const rows = parseManifest(manifestText(), 'Sino_PEI').rows
  const [fb, , , , refused] = rows

  it('spells a citation the way the composer shows it', () => {
    assert.equal(mentionOf(fb), "@'SCP_IN'")
    // Names with whitespace are fine inside the quotes; the grammar only needs
    // the token to start a word.
    assert.equal(mentionOf({ ...fb, name: 'Deux axes' }), "@'Deux axes'")
  })

  it('refuses a name it cannot spell rather than inserting a broken token', () => {
    assert.equal(mentionOf({ ...fb, name: "O'Brien" }), null)
    assert.equal(mentionOf({ ...fb, name: '   ' }), null)
    assert.equal(mentionOf({ ...fb, name: 'two\nlines' }), "@'two lines'")
  })

  it('reads citations back in order, once each', () => {
    assert.deepEqual(mentionNames("@'SCP_IN' then @'00_Main' and @'SCP_IN' again"), ['SCP_IN', '00_Main'])
    assert.deepEqual(mentionNames("@'Deux axes'"), ['Deux axes'])
    // Not word-initial, other quote styles, and empty text are all ordinary prose.
    assert.deepEqual(mentionNames("mail a@'SCP_IN'"), [])
    assert.deepEqual(mentionNames('@"SCP_IN"'), [])
    assert.deepEqual(mentionNames(''), [])
  })

  it('answers the transcript rule with one span per token', () => {
    // The conversation's user-text evaluator walks the text through this call, so
    // its offsets have to be exact and its walk has to terminate.
    assert.deepEqual(nextMention("hi @'SCP_IN' and @'00_Main'", 0), { start: 3, end: 12, name: 'SCP_IN' })
    assert.deepEqual(nextMention("hi @'SCP_IN' and @'00_Main'", 12), { start: 17, end: 27, name: '00_Main' })
    assert.equal(nextMention("hi @'SCP_IN'", 12), undefined)
    // An empty pair of quotes is skipped instead of being claimed as a chip.
    assert.equal(nextMention("@''", 0), undefined)
    assert.equal(nextMention("@'a'", 1), undefined)
  })

  it('writes one machine-readable line per object', () => {
    assert.equal(
      referenceLine(fb, 'source/Sino_PEI/blocks/1001_SCP_IN/SCP_IN.xml'),
      '[plc-block] name="SCP_IN" device="Sino_PEI" type="FB" number="1001" language="SCL" file="source/Sino_PEI/blocks/1001_SCP_IN/SCP_IN.xml"',
    )
  })

  it('marks a refused object instead of inventing a file for it', () => {
    const line = referenceLine(refused, null)
    assert.match(line, /export="refused"/)
    assert.match(line, /reason="The export of block 'FOB_SAFETY' is not permitted\."/)
    assert.equal(line.includes('file='), false)
  })

  it('builds the context block, and says so when a name resolves to nothing', () => {
    const context = mentionContext(['SCP_IN', 'NO_SUCH_BLOCK'], rows, 'C:\\ws')
    assert.ok(context !== null)
    const lines = context.split('\n')
    // The header is two lines; the objects follow it one per line.
    assert.equal(lines[0], '## PLC blocks cited in this message')
    assert.match(lines[1], /^The user's message mentions the exported PLC objects/)
    assert.match(lines[2], /name="SCP_IN"/)
    assert.match(lines[2], /file="source\/Sino_PEI\/blocks\/999_Bibliotheque\/Fonctions méthode\/1001_SCP_IN\/SCP_IN\.xml"/)
    assert.match(lines[3], /name="NO_SUCH_BLOCK" found="false"/)
    assert.equal(lines.length, 4)
    assert.equal(mentionContext([], rows, 'C:\\ws'), null)
    assert.equal(context.startsWith(MENTION_HEADER), true)
  })

  it('matches a cited name case-insensitively when the exact spelling misses', () => {
    const context = mentionContext(['scp_in'], rows, 'C:\\ws')
    assert.match(context, /name="SCP_IN"/)
  })
})
