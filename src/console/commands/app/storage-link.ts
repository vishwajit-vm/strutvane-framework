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
 * - on Windows a directory junction is made (no administrator rights or developer mode needed).
 *
 * @module
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
