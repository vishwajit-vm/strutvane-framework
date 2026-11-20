/**
 * `log:clear` deletes files and can't be undone, so it needs an explicit confirmation (audit
 * 2026-11-15): the function takes `confirm: true` (the command's confirmation is tested in
 * log-commands.test.ts). Every refusal deletes nothing.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ClearNotConfirmedError, clearLogs } from '../../src/logging/commands/list.ts'
import { tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function seeded(): { dir: string; old: string } {
  const t = tempDir()
  cleanups.push(t.cleanup)
  writeFileSync(join(t.dir, 'strutvane-2026-11-01.log'), 'x\n')
  writeFileSync(join(t.dir, 'strutvane-2026-11-02.log'), 'x\n')
  return { dir: t.dir, old: join(t.dir, 'strutvane-2026-11-01.log') }
}

describe('clearLogs needs confirm: true', () => {
  test.each([undefined, {}, { confirm: false }, { confirm: 'yes' }, { confirm: 1 }])(
    'refuses %j and deletes nothing',
    async (options) => {
      const { dir, old } = seeded()
      const sources = [{ dir, bases: new Set(['strutvane']) }]
      await expect(clearLogs(sources, options as never)).rejects.toThrow(ClearNotConfirmedError)
      expect(existsSync(old)).toBe(true)
    },
  )

  test('deletes with confirm: true', async () => {
    const { dir, old } = seeded()
    const result = await clearLogs([{ dir, bases: new Set(['strutvane']) }], { confirm: true })
    expect(result.deleted).toEqual(['strutvane-2026-11-01.log'])
    expect(existsSync(old)).toBe(false)
  })
})
