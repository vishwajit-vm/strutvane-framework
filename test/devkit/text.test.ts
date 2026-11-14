/** Text shape helpers and template headers. */
import { describe, expect, test } from 'vitest'
import { formatHeader, parseHeader } from '../../src/devkit/merge/header.ts'
import { hasConflictMarkers, mergeThreeWay, mergeTwoWay } from '../../src/devkit/merge/merge.ts'
import {
  fromLines,
  lineKey,
  matchLineEndings,
  mergeShapes,
  shapeOf,
  toLines,
} from '../../src/devkit/text.ts'

describe('shapeOf / toLines / fromLines', () => {
  test('detects line endings, BOM and final newline', () => {
    expect(shapeOf('a\r\nb\r\n')).toEqual({
      eol: '\r\n',
      mixedEol: false,
      bom: false,
      finalNewline: true,
    })
    expect(shapeOf('﻿a\nb')).toEqual({
      eol: '\n',
      mixedEol: false,
      bom: true,
      finalNewline: false,
    })
    expect(shapeOf('a\r\nb\r\nc\n').mixedEol).toBe(true)
    expect(shapeOf('').eol).toBe('\n')
  })

  test('round-trips text through lines and shape', () => {
    for (const text of ['a\nb\n', 'a\r\nb', '﻿x\r\ny\r\n', '', 'single']) {
      expect(fromLines(toLines(text), shapeOf(text))).toBe(text)
    }
    expect(toLines('a\rb\r\nc')).toEqual(['a', 'b', 'c'])
    expect(fromLines([], { eol: '\n', bom: true, finalNewline: true })).toBe('﻿')
  })

  test('mergeShapes keeps the user’s conventions only where the user changed them', () => {
    const lf = shapeOf('a\n')
    const crlf = shapeOf('a\r\n')
    expect(mergeShapes(lf, crlf, lf).eol).toBe('\r\n') // user switched to CRLF: kept
    expect(mergeShapes(lf, lf, crlf).eol).toBe('\r\n') // template switched: applied
    expect(mergeShapes(lf, shapeOf('﻿a\n'), lf).bom).toBe(true)
  })

  test('matchLineEndings re-encodes new content in the existing file’s style', () => {
    expect(matchLineEndings('old\r\nfile\r\n', 'new\ncontent\n')).toBe('new\r\ncontent\r\n')
    expect(matchLineEndings('old\n', 'new\r\ncontent\r\n')).toBe('new\ncontent\n')
    expect(matchLineEndings('﻿old\n', 'new\n')).toBe('﻿new\n')
  })

  test('lineKey optionally ignores trailing whitespace', () => {
    expect(lineKey('x  \t', true)).toBe('x')
    expect(lineKey('x  ', false)).toBe('x  ')
  })
})

describe('template headers', () => {
  test('format and parse round-trip', () => {
    const line = formatHeader({ template: 'framework/controller', version: '1.2.0-next.1' })
    expect(parseHeader(`${line}\nexport {}\n`)).toEqual({
      template: 'framework/controller',
      version: '1.2.0-next.1',
    })
    expect(parseHeader(`﻿${line}`)?.template).toBe('framework/controller')
  })

  test('no header, or a header not on the first line, is not a header', () => {
    expect(parseHeader('export {}\n')).toBeUndefined()
    expect(parseHeader('\n// @strutvane-template a/b@1.0.0')).toBeUndefined()
  })

  test('refuses invalid ids and versions (no newline injection into generated files)', () => {
    expect(() => formatHeader({ template: 'Bad Id', version: '1.0.0' })).toThrow(/invalid/)
    expect(() => formatHeader({ template: 'a/b', version: '1.0.0\nmalicious()' })).toThrow()
  })
})

describe('merge edge cases', () => {
  test('conflict markers are detected only at line starts', () => {
    expect(hasConflictMarkers('a\n<<<<<<< yours\n')).toBe(true)
    expect(hasConflictMarkers('a\n=======\n')).toBe(true)
    expect(hasConflictMarkers('const s = "<<<<<<< not a marker"\n')).toBe(false)
  })

  test('custom labels appear next to the markers', () => {
    const r = mergeThreeWay(
      { base: 'a\n', ours: 'b\n', theirs: 'c\n' },
      { labels: { ours: 'mine', theirs: 'next' } },
    )
    expect(r.text).toContain('<<<<<<< mine')
    expect(r.text).toContain('>>>>>>> next')
    expect(r.conflicts[0]).toMatchObject({ kind: 'both-modified', outputLine: 1 })
  })

  test('two-way merge of identical files is clean; additions become both-added conflicts', () => {
    expect(mergeTwoWay({ ours: 'a\n', theirs: 'a\n' }).status).toBe('clean')
    const r = mergeTwoWay({ ours: 'a\n', theirs: 'a\nb\n' })
    expect(r.conflicts.map((c) => c.kind)).toEqual(['both-added'])
    expect(r.conflicts[0]?.base).toBeNull()
  })

  test('mixed line endings are noted', () => {
    const r = mergeThreeWay({ base: 'a\nb\n', ours: 'a\r\nb\n', theirs: 'a\nb\nc\n' })
    expect(r.notes.join(' ')).toMatch(/mixed line endings/)
  })
})
