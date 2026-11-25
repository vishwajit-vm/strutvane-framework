/**
 * `node strut storage:link`: Laravel's `php artisan storage:link`. Links `public/storage` to the
 * public disk's folder (`storage/app/public`), for apps that serve `public/` with a web server or
 * a CDN. The app itself already serves public disks at `/storage/…` without the link.
 *
 * Which links: `config/filesystems.ts` `links` (`{ 'public/storage': 'storage/app/public' }`),
 * else `public/storage` → the `public` disk's `root` (default `storage/app/public`).
 *
 * Safety:
 * - both ends must stay inside the app folder (a `links` entry like `../../etc` is refused);
 * - an existing link to the same folder is left alone (idempotent);
 * - an existing link elsewhere is only replaced with `--force`, and a real file or folder at the
 *   link's place is **never** replaced (it may hold the developer's files);
 * - on Windows a directory junction is made (no administrator rights or developer mode needed);
 * - a target holding files a disk stored as **private** is refused: once linked, a web server
 *   would serve them to anyone (move them to the private disk, or make them public first).
 *
 * @module
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { localDiskSidecar, moveLocalDiskSidecars } from '../../../storage/local-disk.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import {
  type AppCommandDeps,
  BOOT_FLAGS,
  commandError,
  defineAppCommand,
  withBootedApp,
} from './support.ts'

/** The default link, Laravel's: `public/storage` → `storage/app/public`. */
export const DEFAULT_STORAGE_LINK: Readonly<Record<string, string>> = Object.freeze({
  'public/storage': 'storage/app/public',
})

/** What happened to one link. */
export interface StorageLinkResult {
  readonly link: string
  readonly target: string
  readonly status: 'created' | 'exists' | 'replaced'
}

/** The links to make, from the `filesystems` config tree (unchecked). */
export function storageLinks(filesystems: unknown): Readonly<Record<string, string>> {
  if (typeof filesystems !== 'object' || filesystems === null) return DEFAULT_STORAGE_LINK
  const tree = filesystems as { links?: unknown; disks?: unknown }
  if (typeof tree.links === 'object' && tree.links !== null) {
    const links: Record<string, string> = {}
    for (const [link, target] of Object.entries(tree.links))
      if (typeof target === 'string') links[link] = target
    return links
  }
  const disks = typeof tree.disks === 'object' && tree.disks !== null ? tree.disks : {}
  const root = (disks as Record<string, { root?: unknown } | undefined>)['public']?.root
  return typeof root === 'string' && root !== '' ? { 'public/storage': root } : DEFAULT_STORAGE_LINK
}

/** `path` resolved against the app, or a usage error when it leaves the app folder. */
function inside(base: string, path: string, what: string): string {
  const full = isAbsolute(path) ? resolve(path) : resolve(base, path)
  const rel = relative(base, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw commandError(
      'storage_link_outside_app',
      `The ${what} "${path}" is outside the app folder.`,
      'Links and their targets must stay inside the project (config/filesystems.ts links).',
      EXIT.VALIDATION,
    )
  return full
}

/** How many private files the refusal names (the rest are counted). */
const LISTED = 5

/**
 * Keys of files in `target` that a disk stored as private (its metadata says so). A file with no
 * metadata was put there by hand and is the developer's call; symbolic links are not followed.
 *
 * @example
 * await privateFilesIn('/srv/blog/storage/app/public') // ['invoices/7.pdf']
 */
export async function privateFilesIn(target: string): Promise<string[]> {
  await moveLocalDiskSidecars(target)
  const { meta } = localDiskSidecar(target)
  const found: string[] = []
  const walk = async (dir: string, parts: readonly string[]): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = [...parts, entry.name]
      if (entry.isDirectory()) await walk(join(dir, entry.name), path)
      else if (entry.isFile() && (await visibilityOf(meta, path)) === 'private')
        found.push(path.join('/'))
    }
  }
  await walk(target, [])
  return found.sort()
}

/** The visibility a disk recorded for a file, or `undefined` without (readable) metadata. */
async function visibilityOf(meta: string, parts: readonly string[]): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(`${join(meta, ...parts)}.json`, 'utf8'))
    const visibility = (parsed as { visibility?: unknown } | null)?.visibility
    return visibility === 'public' ? 'public' : 'private'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // Unreadable or broken metadata: treat the file as private (fail closed).
    return 'private'
  }
}

/**
 * Refuse to link `target` while it holds private files (a CLI error naming a few of them).
 *
 * @example
 * await assertNothingPrivate('/srv/blog', 'storage/app/public')
 */
export async function assertNothingPrivate(base: string, target: string): Promise<void> {
  const targetPath = inside(base, target, 'target')
  const files = await privateFilesIn(targetPath)
  if (files.length === 0) return
  const named = files.slice(0, LISTED).join(', ')
  const more = files.length > LISTED ? ` and ${files.length - LISTED} more` : ''
  throw commandError(
    'storage_link_private_files',
    `${target} holds files stored as private (${named}${more}); a link would let a web server serve them to anyone.`,
    'Keep private files on the private disk (storage/app/private), or store each one again with put(key, body, { visibility: "public" }) if it really is public, then run storage:link again.',
    EXIT.VALIDATION,
  )
}

/**
 * Make one link (or confirm it). Throws a friendly CLI error for anything it won't do.
 *
 * @example
 * linkStorage('/srv/blog', 'public/storage', 'storage/app/public', false)
 */
export function linkStorage(
  base: string,
  link: string,
  target: string,
  force: boolean,
): StorageLinkResult {
  const linkPath = inside(base, link, 'link')
  const targetPath = inside(base, target, 'target')
  mkdirSync(targetPath, { recursive: true })
  let replaced = false
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink())
      throw commandError(
        'storage_link_exists',
        `${link} already exists and is a real ${existing.isDirectory() ? 'folder' : 'file'}.`,
        'Move or delete it yourself if it should become the link; storage:link never replaces real files.',
        EXIT.CONFLICT,
      )
    const pointsAt = existsSync(linkPath) ? realpathSync(linkPath) : undefined
    if (pointsAt === realpathSync(targetPath)) return { link, target, status: 'exists' }
    if (!force)
      throw commandError(
        'storage_link_exists',
        `${link} already links somewhere else.`,
        'Pass --force to point it at the public disk.',
        EXIT.CONFLICT,
      )
    unlinkSync(linkPath)
    replaced = true
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  if (process.platform === 'win32') symlinkSync(targetPath, linkPath, 'junction')
  else symlinkSync(relative(dirname(linkPath), targetPath), linkPath, 'dir')
  return { link, target, status: replaced ? 'replaced' : 'created' }
}

/**
 * The `storage:link` command.
 *
 * @example
 * storageLinkCommand(DEFAULT_APP_DEPS)
 */
export function storageLinkCommand(deps: AppCommandDeps): AnyCommand {
  return defineAppCommand({
    name: 'storage:link',
    description: 'Link public/storage to the public disk (storage/app/public)',
    details:
      'The app already serves public disks at /storage/…; the link is for a web server or CDN serving public/. Links come from config/filesystems.ts "links" when set.',
    requiresProject: false,
    flags: {
      ...BOOT_FLAGS,
      force: { type: 'boolean', description: 'Replace an existing link that points elsewhere' },
    },
    examples: ['node strut storage:link', 'node strut storage:link --force'],
    async run(ctx) {
      const { base, links } = await withBootedApp(ctx, deps, (app) => ({
        base: app.basePath,
        links: storageLinks(
          app.configRepository.has('filesystems') ? app.config('filesystems') : undefined,
        ),
      }))
      const root = realpathSync(base)
      for (const target of Object.values(links)) await assertNothingPrivate(root, target)
      const results = Object.entries(links).map(([link, target]) =>
        linkStorage(root, link, target, ctx.flags.force === true),
      )
      for (const result of results)
        if (result.status === 'exists')
          ctx.out.info(`${result.link} already links to ${result.target}.`)
        else ctx.out.success(`${result.link} → ${result.target} (${result.status})`)
      return { data: { links: results } }
    },
  })
}
