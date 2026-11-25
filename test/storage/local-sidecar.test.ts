/**
 * A local disk's metadata and partial uploads live beside its root, never inside it: a web
 * server serving the root (after `storage:link`) can't hand them out. Overwrites never serve new
 * bytes under the old file's metadata.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalDisk, localDiskSidecar, SIDECAR_DIR } from '../../src/storage/local-disk.ts'
import { servePublicFile } from '../../src/storage/public-files.ts'

let base: string
let root: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sv-sidecar-'))
  root = join(base, 'public')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('local disk sidecars', () => {
  it('sit beside the root, so the root holds nothing but the files themselves', async () => {
    const disk = createLocalDisk({ name: 'public', root, visibility: 'public' })
    await disk.put('avatars/7.png', 'png', { contentType: 'image/png' })
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.error(new Error('client went away'))
      },
    })
    await expect(disk.put('avatars/8.png', failing)).rejects.toThrow('client went away')
    expect(await readdir(root)).toEqual(['avatars'])
    expect(await readdir(join(root, 'avatars'))).toEqual(['7.png'])
    const sidecar = localDiskSidecar(root)
    expect(sidecar.meta).toBe(join(base, SIDECAR_DIR, 'public', 'meta'))
    expect(sidecar.meta.startsWith(`${root}${sep}`)).toBe(false)
    expect(
      JSON.parse(await readFile(join(sidecar.meta, 'avatars', '7.png.json'), 'utf8')),
    ).toMatchObject({
      key: 'avatars/7.png',
      visibility: 'public',
    })
    expect(await readdir(sidecar.tmp)).toEqual([])
    expect((await disk.list('')).items.map((item) => item.key)).toEqual(['avatars/7.png'])
  })

  it('moves the sidecars an older version kept inside the root out of it, on first use', async () => {
    mkdirSync(join(root, '.strutvane-meta', 'docs'), { recursive: true })
    mkdirSync(join(root, '.strutvane-tmp'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'a.txt'), 'old')
    writeFileSync(join(root, '.strutvane-tmp', 'x.part'), 'half')
    writeFileSync(
      join(root, '.strutvane-meta', 'docs', 'a.txt.json'),
      JSON.stringify({
        disk: 'public',
        key: 'docs/a.txt',
        size: 3,
        sha256: 'x',
        contentType: 'text/plain',
        visibility: 'public',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const disk = createLocalDisk({ name: 'public', root })
    expect(await disk.stat('docs/a.txt')).toMatchObject({ key: 'docs/a.txt', visibility: 'public' })
    expect((await readdir(root)).sort()).toEqual(['docs'])
    // A second disk on the same root (another process) finds nothing left to move.
    expect(await createLocalDisk({ name: 'public', root }).stat('docs/a.txt')).toMatchObject({
      key: 'docs/a.txt',
    })
  })

  it('merges legacy metadata into an existing sidecar, the newer location winning', async () => {
    const disk = createLocalDisk({ name: 'public', root })
    await disk.put('docs/new.txt', 'new', { contentType: 'text/plain' })
    mkdirSync(join(root, '.strutvane-meta', 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'old.txt'), 'old')
    const legacy = {
      disk: 'public',
      size: 3,
      sha256: 'x',
      contentType: 'text/plain',
      visibility: 'private',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    writeFileSync(
      join(root, '.strutvane-meta', 'docs', 'old.txt.json'),
      JSON.stringify({ ...legacy, key: 'docs/old.txt' }),
    )
    writeFileSync(
      join(root, '.strutvane-meta', 'docs', 'new.txt.json'),
      JSON.stringify({ ...legacy, key: 'docs/new.txt', size: 99 }),
    )
    const fresh = createLocalDisk({ name: 'public', root })
    expect(await fresh.stat('docs/old.txt')).toMatchObject({ key: 'docs/old.txt' })
    expect(await fresh.stat('docs/new.txt')).toMatchObject({ size: 3 })
    expect((await readdir(root)).sort()).toEqual(['docs'])
  })

  it('refuses the file system root as a disk root (its metadata would sit inside it)', () => {
    const top = process.platform === 'win32' ? 'C:\\' : '/'
    expect(() => localDiskSidecar(top)).toThrow(/storage\/app\/private/)
  })
})

describe('overwriting a public file', () => {
  it('never serves the new bytes under the old metadata, even when the write stops halfway', async () => {
    let failClock = false
    const disk = createLocalDisk({
      name: 'public',
      root,
      visibility: 'public',
      now: () => {
        if (failClock) throw new Error('clock failed after the bytes moved')
        return new Date('2026-11-25T00:00:00.000Z')
      },
    })
    const mounts = [{ disk, prefix: '/storage' }]
    await disk.put('docs/report.png', 'public bytes', { contentType: 'image/png' })
    const before = await servePublicFile(
      new Request('http://localhost/storage/docs/report.png'),
      mounts,
    )
    expect(before?.status).toBe(200)
    // The replacement is private; the write fails after the bytes are in place.
    failClock = true
    await expect(
      disk.put('docs/report.png', 'private bytes', {
        visibility: 'private',
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/clock failed/)
    const after = await servePublicFile(
      new Request('http://localhost/storage/docs/report.png'),
      mounts,
    )
      .then((response) => response?.status)
      .catch((error: unknown) => (error as { status?: number }).status ?? 404)
    expect(after).toBe(404)
    failClock = false
    await disk.put('docs/report.png', 'private bytes', {
      visibility: 'private',
      contentType: 'image/png',
    })
    expect(await disk.stat('docs/report.png')).toMatchObject({ visibility: 'private', size: 13 })
  })
})
