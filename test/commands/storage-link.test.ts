/**
 * `node strut storage:link`: links public/storage to the public disk; idempotent; never replaces
 * a real folder; `--force` only re-points an existing link; both ends stay inside the app.
 */
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkStorage, storageLinks } from '../../src/console/commands/app/storage-link.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { appFolder, buildApp, cleanupFolders, strut, testConfig } from './helpers.ts'

afterEach(cleanupFolders)

describe('storage:link', () => {
  it('links public/storage to storage/app/public, then reports it exists', async () => {
    const base = appFolder()
    const first = await strut(['storage:link', '--json'], { cwd: base })
    expect(first.code, first.stderr).toBe(0)
    expect(first.json().data).toEqual({
      links: [{ link: 'public/storage', target: 'storage/app/public', status: 'created' }],
    })
    expect(lstatSync(join(base, 'public', 'storage')).isSymbolicLink()).toBe(true)
    writeFileSync(join(base, 'storage', 'app', 'public', 'a.txt'), 'hello')
    expect(realpathSync(join(base, 'public', 'storage', 'a.txt'))).toBe(
      realpathSync(join(base, 'storage', 'app', 'public', 'a.txt')),
    )
    const again = await strut(['storage:link', '--json'], { cwd: base })
    expect(again.code).toBe(0)
    expect((again.json().data as { links: { status: string }[] }).links[0]?.status).toBe('exists')
  })

  it('uses the public disk root, or the links in config/filesystems.ts', async () => {
    const base = appFolder()
    const filesystems = defineConfig(() => ({
      disks: { public: { driver: 'local', root: 'storage/media', visibility: 'public' } },
    }))
    const result = await strut(['storage:link', '--json'], {
      cwd: base,
      app: () => buildApp(base, { config: { ...testConfig, filesystems } }).app,
    })
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.stringify(result.json().data)).toContain('storage/media')
    expect(storageLinks({ links: { 'public/files': 'storage/files', bad: 3 } })).toEqual({
      'public/files': 'storage/files',
    })
    expect(storageLinks(undefined)).toEqual({ 'public/storage': 'storage/app/public' })
  })

  it('never replaces a real folder; --force only re-points a link', async () => {
    const base = appFolder()
    mkdirSync(join(base, 'public', 'storage'), { recursive: true })
    writeFileSync(join(base, 'public', 'storage', 'mine.txt'), 'keep me')
    const refused = await strut(['storage:link', '--force', '--json'], { cwd: base })
    expect(refused.code).not.toBe(0)
    expect(refused.json().error?.code).toBe('storage_link_exists')
    expect(lstatSync(join(base, 'public', 'storage')).isSymbolicLink()).toBe(false)

    const other = appFolder()
    const root = realpathSync(other)
    expect(linkStorage(root, 'public/storage', 'storage/old', false).status).toBe('created')
    expect(() => linkStorage(root, 'public/storage', 'storage/app/public', false)).toThrow(
      /links somewhere else/,
    )
    expect(linkStorage(root, 'public/storage', 'storage/app/public', true).status).toBe('replaced')
  })

  it('refuses links or targets outside the app', () => {
    const root = realpathSync(appFolder())
    expect(() => linkStorage(root, '../escape', 'storage/app/public', false)).toThrow(
      /outside the app/,
    )
    expect(() => linkStorage(root, 'public/storage', '../../etc', false)).toThrow(/outside the app/)
  })
})
