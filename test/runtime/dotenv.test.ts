// Loading `.env` at runtime: it must agree with the CLI's checks and with devkit's writer.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseEnv as cliParseEnv } from '../../src/console/project/env-file.ts'
import { loadDotEnv } from '../../src/runtime/project.ts'

const KEYS = ['SV_DOTENV_FIRST', 'SV_DOTENV_SECOND', 'SV_DOTENV_SET', 'SV_DOTENV_EMPTY']
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sv-dotenv-'))
  for (const key of KEYS) delete process.env[key]
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const key of KEYS) delete process.env[key]
})

describe('loadDotEnv', () => {
  test('a byte-order mark never hides the first variable (CRLF files too)', () => {
    const text = '\uFEFFSV_DOTENV_FIRST=one\r\nSV_DOTENV_SECOND="two"\r\n'
    writeFileSync(join(root, '.env'), text)
    loadDotEnv(root)
    expect(process.env['SV_DOTENV_FIRST']).toBe('one')
    expect(process.env['SV_DOTENV_SECOND']).toBe('two')
    expect(Object.keys(process.env).some((k) => k.startsWith('\uFEFF'))).toBe(false)
    // The CLI's checks (env:check, the production guard) read the same values.
    const cli = cliParseEnv(text)
    expect(cli.entries.get('SV_DOTENV_FIRST')?.value).toBe('one')
  })

  test('variables already set (even to an empty string) win over the file', () => {
    process.env['SV_DOTENV_SET'] = 'from-process'
    process.env['SV_DOTENV_EMPTY'] = ''
    writeFileSync(
      join(root, '.env'),
      'SV_DOTENV_SET=file\nSV_DOTENV_EMPTY=file\nSV_DOTENV_FIRST=f\n',
    )
    loadDotEnv(root)
    expect(process.env['SV_DOTENV_SET']).toBe('from-process')
    expect(process.env['SV_DOTENV_EMPTY']).toBe('')
    expect(process.env['SV_DOTENV_FIRST']).toBe('f')
  })

  test('a missing .env is not an error', () => {
    expect(() => loadDotEnv(root)).not.toThrow()
  })
})
