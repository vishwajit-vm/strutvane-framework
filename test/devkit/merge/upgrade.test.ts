/**
 * End-to-end tests of the upgrade engine on real temp directories: planning decisions, dry run,
 * transactional apply, rollback, crash recovery and damaged-state handling. Ported from spike 06.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DevkitError, TransactionAbortedError } from '../../../src/devkit/errors.ts'
import { nodeIo, sha256 } from '../../../src/devkit/io.ts'
import { basePathOf, LOCK_PATH, readLock } from '../../../src/devkit/merge/lock.ts'
import {
  applyUpgrade,
  planUpgrade,
  recordEjection,
  renderUpgradePreview,
  type TemplateOutput,
} from '../../../src/devkit/merge/upgrade.ts'
import { recoverTransactions } from '../../../src/devkit/transaction.ts'
import {
  CONTROLLER_V1,
  CONTROLLER_V2,
  FORM_V1,
  FORM_V2,
  insertAfterLine,
  replaceOnce,
} from '../fixtures/templates.ts'
import { faultyIo, readFile, rejectionOf, snapshot, tempProject, writeFiles } from '../helpers.ts'

const CTRL = 'app/http/controllers/invoice.controller.ts'
const FORM = 'web/pages/invoices/form.tsx'
const v1: TemplateOutput[] = [
  { path: CTRL, template: 'framework/controller', version: '1.0.0', content: CONTROLLER_V1 },
  { path: FORM, template: 'ui/form-page', version: '1.0.0', content: FORM_V1 },
]
const v2: TemplateOutput[] = [
  { path: CTRL, template: 'framework/controller', version: '1.1.0', content: CONTROLLER_V2 },
  { path: FORM, template: 'ui/form-page', version: '1.1.0', content: FORM_V2 },
]
const USER_HOOK = `  async beforeCreate(ctx) {\n    ctx.input.number ??= await nextInvoiceNumber(ctx.actor.tenantId)\n  },\n`
const POLICY: TemplateOutput = {
  path: 'app/policies/invoice.policy.ts',
  template: 'auth/policy',
  version: '1.1.0',
  content: '// @strutvane-template auth/policy@1.1.0\nexport default {}\n',
}

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  await recordEjection({ projectRoot, outputs: v1 })
})
afterEach(() => cleanup())

const read = (p: string) => readFile(projectRoot, p)
const write = (p: string, content: string) => writeFiles(projectRoot, { [p]: content })
const remove = (p: string) => nodeIo.remove(join(projectRoot, p))
const edit = async (p: string, fn: (s: string) => string) => write(p, fn((await read(p)) ?? ''))
const plan = (templates: readonly TemplateOutput[] = v2) => planUpgrade({ projectRoot, templates })
const addHook = (s: string) => insertAfterLine(s, 'export default defineController', USER_HOOK)

describe('recordEjection', () => {
  test('writes files, bases and a lock entry per file', async () => {
    expect(await read(CTRL)).toBe(CONTROLLER_V1)
    expect(await read(basePathOf(CTRL))).toBe(CONTROLLER_V1)
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && lock.lock.files[FORM]).toEqual({
      template: 'ui/form-page',
      templateVersion: '1.0.0',
      baseSha256: sha256(FORM_V1),
      status: 'active',
      conflicted: false,
    })
  })

  test('keeps existing lock entries when ejecting more files', async () => {
    await recordEjection({ projectRoot, outputs: [POLICY] })
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && Object.keys(lock.lock.files).sort()).toEqual(
      [CTRL, FORM, POLICY.path].sort(),
    )
  })
})

describe('plan + apply', () => {
  test('clean merge: applies, advances the base and lock, and a second run is a no-op', async () => {
    await edit(CTRL, addHook)
    const p = await plan()
    expect(p.items.map((i) => [i.path, i.action, i.mode])).toEqual([
      [CTRL, 'update', 'three-way'],
      [FORM, 'update', 'three-way'], // untouched by the user → becomes exactly v2
    ])
    expect(await applyUpgrade({ projectRoot, plan: p })).toEqual({
      written: [CTRL, FORM],
      conflicted: [],
    })

    const ctrl = (await read(CTRL)) ?? ''
    expect(ctrl).toContain('nextInvoiceNumber')
    expect(ctrl).toContain('async restore(ctx)')
    expect(await read(FORM)).toBe(FORM_V2)
    expect(await read(basePathOf(CTRL))).toBe(CONTROLLER_V2)
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && lock.lock.files[CTRL]).toMatchObject({
      templateVersion: '1.1.0',
      baseSha256: sha256(CONTROLLER_V2),
      conflicted: false,
    })

    const again = await plan()
    expect(again.items.every((i) => i.action === 'unchanged')).toBe(true)
    expect(await nodeIo.exists(join(projectRoot, '.strutvane/staging'))).toBe(false)
  })

  test('conflict: writes markers, marks the lock, and blocks the next run until resolved', async () => {
    await edit(CTRL, (s) =>
      replaceOnce(
        s,
        'ctx.query.update(ctx.params.id, input)',
        'ctx.query.update(ctx.params.id, { ...input, updatedBy: ctx.actor.id })',
      ),
    )
    const p = await plan()
    const item = p.items.find((i) => i.path === CTRL)
    expect(item?.action).toBe('conflict')
    expect(item?.conflicts[0]?.kind).toBe('both-modified')
    const result = await applyUpgrade({ projectRoot, plan: p })
    expect(result.conflicted).toEqual([CTRL])
    expect(await read(CTRL)).toContain('<<<<<<< yours')
    expect(await read(CTRL)).toContain('framework/controller@1.0.0 (original)')
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && lock.lock.files[CTRL]?.conflicted).toBe(true)

    const again = await plan()
    expect(again.items.find((i) => i.path === CTRL)).toMatchObject({ action: 'blocked' })
  })

  test('user deleted the file: never recreated, remembered in the lock', async () => {
    await remove(CTRL)
    const p = await plan()
    expect(p.items.find((i) => i.lockKey === CTRL)?.action).toBe('skip-user-deleted')
    await applyUpgrade({ projectRoot, plan: p })
    expect(await read(CTRL)).toBeUndefined()
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && lock.lock.files[CTRL]?.status).toBe('deleted-by-user')
    const again = await plan()
    const item = again.items.find((i) => i.lockKey === CTRL)
    expect(item?.action).toBe('skip-user-deleted')
    expect(item?.notes.join(' ')).toContain('deleted this file earlier')
  })

  test('user moved the file: found by its header, merged in place, lock + base follow it', async () => {
    const moved = 'app/http/billing/invoices.ts'
    await write(moved, addHook(CONTROLLER_V1))
    await remove(CTRL)
    const p = await plan()
    expect(p.items.find((i) => i.lockKey === CTRL)).toMatchObject({
      action: 'update',
      path: moved,
      renamedFrom: CTRL,
    })
    await applyUpgrade({ projectRoot, plan: p })
    expect(await read(moved)).toContain('async restore(ctx)')
    expect(await read(CTRL)).toBeUndefined()
    const lock = await readLock(nodeIo, projectRoot)
    expect(lock.status === 'ok' && Object.keys(lock.lock.files).sort()).toEqual(
      [moved, FORM].sort(),
    )
    expect(await read(basePathOf(CTRL))).toBeUndefined()
    expect(await read(basePathOf(moved))).toBe(CONTROLLER_V2)
  })

  test('ambiguous move (two files claim the template) is blocked, not guessed', async () => {
    await writeFiles(projectRoot, { 'a/one.ts': CONTROLLER_V1, 'b/two.ts': CONTROLLER_V1 })
    await remove(CTRL)
    const item = (await plan()).items.find((i) => i.lockKey === CTRL)
    expect(item?.action).toBe('blocked')
    expect(item?.notes.join(' ')).toContain('a/one.ts, b/two.ts')
  })

  test('a foreign file at a template path (no lock entry, no header) is blocked', async () => {
    await write(POLICY.path, 'export const mine = true\n')
    const p = await plan([...v2, POLICY])
    expect(p.items.find((i) => i.path === POLICY.path)?.action).toBe('blocked')
    await applyUpgrade({ projectRoot, plan: p })
    expect(await read(POLICY.path)).toBe('export const mine = true\n') // never touched
  })

  test('a file new in this template version is created', async () => {
    const p = await plan([...v2, POLICY])
    expect(p.items.find((i) => i.path === POLICY.path)?.action).toBe('create')
    await applyUpgrade({ projectRoot, plan: p })
    expect(await read(POLICY.path)).toBe(POLICY.content)
  })

  test('nothing changed on either side: every item is unchanged', async () => {
    const p = await plan(v1)
    expect(p.items.map((i) => i.action)).toEqual(['unchanged', 'unchanged'])
    expect(p.items[0]?.after).toBeUndefined()
  })

  test('ignoreTrailingWhitespace: false is passed through to the merge', async () => {
    await edit(CTRL, (s) => s.replace('(ejected: this file is yours to edit)', '$&  '))
    const strict = await planUpgrade({
      projectRoot,
      templates: v2,
      ignoreTrailingWhitespace: false,
    })
    expect(strict.items[0]?.action).toBe('conflict')
  })
})

describe('missing or damaged state', () => {
  test('missing base → two-way merge with every difference reported', async () => {
    await edit(CTRL, addHook)
    await remove(basePathOf(CTRL))
    const item = (await plan()).items.find((i) => i.path === CTRL)
    expect(item).toMatchObject({ action: 'conflict', mode: 'two-way' })
    expect(item?.notes.join(' ')).toContain('merge base missing')
    expect(item?.after).toContain('nextInvoiceNumber')
  })

  test('tampered base (hash mismatch) → two-way merge, never a wrong three-way merge', async () => {
    await write(basePathOf(CTRL), `${CONTROLLER_V1}// tampered\n`)
    const item = (await plan()).items.find((i) => i.path === CTRL)
    expect(item?.mode).toBe('two-way')
    expect(item?.notes.join(' ')).toContain('hash mismatch')
  })

  test('corrupt lock (bad JSON) → backed up, reported, files with headers merged two-way', async () => {
    await write(LOCK_PATH, '{ this is not json')
    const p = await plan()
    expect(p.lockStatus).toBe('corrupt')
    expect(p.notes.join(' ')).toContain('corrupt')
    const state = await nodeIo.listFiles(join(projectRoot, '.strutvane'), [])
    expect(state.some((f) => f.startsWith('lock.json.corrupt-'))).toBe(true)
    expect(p.items.find((i) => i.path === CTRL)?.mode).toBe('two-way')
  })

  test('lock with a path-traversal or absolute key is treated as corrupt', async () => {
    const entry = { template: 'x', templateVersion: '1.0.0', baseSha256: 'a'.repeat(64) }
    for (const key of ['../../etc/passwd', 'C:/x', '/etc/passwd', 'a\\b']) {
      await write(LOCK_PATH, JSON.stringify({ lockfileVersion: 1, files: { [key]: entry } }))
      expect((await readLock(nodeIo, projectRoot)).status).toBe('corrupt')
    }
  })

  test('missing lock → headered files merged two-way; next apply rebuilds lock and bases', async () => {
    await remove(LOCK_PATH)
    const p = await plan()
    expect(p.lockStatus).toBe('missing')
    expect(p.notes.join(' ')).toContain('no .strutvane/lock.json')
    expect(p.items.map((i) => i.mode)).toEqual(['two-way', 'two-way'])
    await applyUpgrade({ projectRoot, plan: p })
    expect((await readLock(nodeIo, projectRoot)).status).toBe('ok')
    expect(await read(basePathOf(CTRL))).toBe(CONTROLLER_V2)
  })

  test('a file with leftover conflict markers is blocked', async () => {
    await edit(CTRL, (s) => `${s}<<<<<<< yours\nx\n=======\ny\n>>>>>>> new template\n`)
    expect((await plan()).items[0]?.action).toBe('blocked')
  })
})

describe('preview and transactions', () => {
  test('the preview shows actions, notes and unified diffs, and writes nothing', async () => {
    await edit(CTRL, addHook)
    await remove(basePathOf(FORM))
    const before = await snapshot(projectRoot)
    const text = renderUpgradePreview(await plan())
    expect(text).toContain(`update            ${CTRL} [three-way]`)
    expect(text).toContain('+  async restore(ctx) {')
    expect(text).toMatch(
      /conflict\s+web\/pages\/invoices\/form\.tsx \[two-way, \d+ conflict\(s\)\]/,
    )
    expect(text).toContain('    merge base missing')
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('the preview shows moves and top-level notes', async () => {
    await write('moved.ts', CONTROLLER_V1)
    await remove(CTRL)
    expect(renderUpgradePreview(await plan())).toContain(`${CTRL} → moved.ts`)
    await write(LOCK_PATH, 'not json')
    expect(renderUpgradePreview(await plan())).toMatch(/^note: lock was corrupt/)
  })

  test('a failure mid-commit rolls every change back', async () => {
    await edit(CTRL, addHook)
    const before = await snapshot(projectRoot)
    const p = await plan()
    const error = await rejectionOf(applyUpgrade({ projectRoot, plan: p, io: faultyIo(3) }))
    expect(error).toBeInstanceOf(TransactionAbortedError)
    expect((error as TransactionAbortedError).rolledBack).toBe(true)
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('a crash mid-commit leaves a journal; apply refuses; recovery restores everything', async () => {
    await edit(CTRL, addHook)
    const before = await snapshot(projectRoot)
    const p = await plan()
    const io = faultyIo(3, { dieAfterFailure: true })
    const error = await rejectionOf(applyUpgrade({ projectRoot, plan: p, io }))
    expect((error as TransactionAbortedError).rolledBack).toBe(false)
    expect(await nodeIo.exists(join(projectRoot, '.strutvane/staging'))).toBe(true)

    const refused = await rejectionOf(applyUpgrade({ projectRoot, plan: p }))
    expect(refused).toBeInstanceOf(DevkitError)
    expect((refused as DevkitError).code).toBe('INTERRUPTED_TRANSACTION')
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(1)
    expect(await snapshot(projectRoot)).toEqual(before)
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(0) // idempotent
  })
})
