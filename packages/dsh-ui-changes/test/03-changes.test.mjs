/**
 * The pure git parsing: porcelain `-z`, numstat `-z`, badge codes, merging.
 *
 * Every literal below is shape-real output (captured from git 2.4x on Windows
 * against throwaway repositories, renames and binaries included), reduced to
 * the entries the test cares about.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildFiles,
  codeOf,
  countLines,
  normalizePath,
  parseNumstat,
  parsePorcelain,
  totalsOf,
} from '../lib/changes.js'

describe('parsePorcelain', () => {
  it('reads plain entries and NUL separation', () => {
    const entries = parsePorcelain(' M a.txt\u0000?? b.txt\u0000')
    assert.deepEqual(entries, [
      { x: ' ', y: 'M', path: 'a.txt', renamedFrom: null },
      { x: '?', y: '?', path: 'b.txt', renamedFrom: null },
    ])
  })

  it('takes the old path from the token after a rename', () => {
    const entries = parsePorcelain('R  new name.txt\u0000old name.txt\u0000')
    assert.deepEqual(entries, [{ x: 'R', y: ' ', path: 'new name.txt', renamedFrom: 'old name.txt' }])
  })

  it('keeps paths with spaces intact', () => {
    const entries = parsePorcelain(' D untracked file.txt\u0000')
    assert.equal(entries[0].path, 'untracked file.txt')
  })

  it('ignores a trailing empty token', () => {
    assert.equal(parsePorcelain('M  a\u0000\u0000').length, 1)
  })
})

describe('parseNumstat', () => {
  it('reads additions and deletions', () => {
    const counts = parseNumstat('2\t0\tnew name.txt\u00000\t1\told name.txt\u0000')
    assert.deepEqual(counts.get('new name.txt'), { adds: 2, dels: 0, binary: false })
    assert.deepEqual(counts.get('old name.txt'), { adds: 0, dels: 1, binary: false })
  })

  it('keys a rename by its new path (empty path field, two tokens)', () => {
    const counts = parseNumstat('0\t0\t\u0000old name.txt\u0000new name.txt\u0000')
    assert.equal(counts.has('new name.txt'), true)
    assert.equal(counts.has('old name.txt'), false)
  })

  it('flags binary sides and keeps their counts null', () => {
    const counts = parseNumstat('-\t-\tbin.dat\u0000')
    assert.deepEqual(counts.get('bin.dat'), { adds: null, dels: null, binary: true })
  })

  it('normalises backslashes so one file cannot become two rows', () => {
    const counts = parseNumstat('1\t1\tsrc\\a.ts\u0000')
    assert.equal(counts.has('src/a.ts'), true)
  })
})

describe('codeOf', () => {
  it('maps the pairs the panel colours', () => {
    assert.equal(codeOf(' ', 'M'), 'M')
    assert.equal(codeOf('M', ' '), 'M')
    assert.equal(codeOf('M', 'M'), 'M')
    assert.equal(codeOf('A', ' '), 'A')
    assert.equal(codeOf(' ', 'D'), 'D')
    assert.equal(codeOf('R', ' '), 'R')
    assert.equal(codeOf('C', ' '), 'C')
    assert.equal(codeOf('?', '?'), '?')
    assert.equal(codeOf('T', ' '), 'M')
  })

  it('folds every conflict shape into one badge', () => {
    for (const pair of [['U', 'U'], ['A', 'A'], ['D', 'D'], ['U', 'D'], ['A', 'U']]) {
      assert.equal(codeOf(pair[0], pair[1]), '!', pair.join(''))
    }
  })
})

describe('buildFiles and totals', () => {
  const entries = parsePorcelain(
    ' M a.txt\u0000R  renamed.txt\u0000rename old.txt\u0000?? fresh.txt\u0000D  gone.txt\u0000',
  )
  const counts = parseNumstat('3\t1\ta.txt\u00000\t0\t\u0000rename old.txt\u0000renamed.txt\u00000\t4\tgone.txt\u0000')
  const untracked = new Map([['fresh.txt', 2]])

  it('merges counts by path and counts untracked lines', () => {
    const files = buildFiles(entries, counts, untracked)
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    assert.equal(byPath['a.txt'].adds, 3)
    assert.equal(byPath['a.txt'].dels, 1)
    assert.equal(byPath['fresh.txt'].adds, 2)
    assert.equal(byPath['fresh.txt'].dels, null)
    assert.equal(byPath['fresh.txt'].untracked, true)
    assert.equal(byPath['renamed.txt'].renamedFrom, 'rename old.txt')
    assert.equal(byPath['gone.txt'].code, 'D')
  })

  it('sorts by path', () => {
    const files = buildFiles(entries, counts, untracked)
    const paths = files.map((file) => file.path)
    assert.deepEqual(paths, [...paths].sort())
  })

  it('leaves counts null when git has no numstat line for the path', () => {
    const files = buildFiles(parsePorcelain(' M orphan.txt\u0000'), new Map())
    assert.equal(files[0].adds, null)
    assert.equal(files[0].dels, null)
  })

  it('sums only numeric counts and reports the full file count', () => {
    const files = buildFiles(entries, counts, untracked)
    assert.deepEqual(totalsOf(files, true), { files: 4, adds: 5, dels: 5, truncated: true })
  })
})

describe('countLines', () => {
  it('counts a file without a final newline', () => {
    assert.equal(countLines(''), 0)
    assert.equal(countLines('a'), 1)
    assert.equal(countLines('a\n'), 1)
    assert.equal(countLines('a\nb'), 2)
    assert.equal(countLines('a\r\nb\r\n'), 2)
  })
})

describe('normalizePath', () => {
  it('keeps forward slashes', () => {
    assert.equal(normalizePath('src\\a\\b.ts'), 'src/a/b.ts')
  })
})
