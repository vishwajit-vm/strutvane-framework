/**
 * The `--render` page of `node strut down`: an `.html` file inside `resources/views`, read once
 * and stored in the state file, so it shows even when the app's views can't load mid-deploy.
 *
 * The file name comes from the command line, so it is treated as untrusted: it must resolve inside
 * `resources/views` both as written (`../../.env` is refused) and after following links (a symlink
 * pointing out of the folder is refused), end in `.html`, be a regular file and stay small.
 *
 * @module
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BootError } from '../foundation/boot-error.ts'
import { MAX_PAGE_BYTES } from './state.ts'

/**
 * The folder `--render` reads from, relative to the app.
 *
 * @example
 * join(basePath, VIEWS_FOLDER) // '/srv/blog/resources/views'
 */
export const VIEWS_FOLDER: string = join('resources', 'views')

/**
 * Read `resources/views/<file>` for `down --render`, refusing anything outside that folder.
 *
 * @example
 * readMaintenancePage('/srv/blog', 'maintenance.html') // '<h1>Back soon</h1>'
 */
export function readMaintenancePage(basePath: string, file: string): string {
  const views = join(basePath, VIEWS_FOLDER)
  const target = resolve(views, file)
  const refuse = (detail: string): BootError =>
    new BootError(
      'invalid_render',
      `--render ${detail} (got "${file}").`,
      'Example: --render=maintenance.html for resources/views/maintenance.html: a small, self-contained page.',
    )
  if (escapes(target, views) || !target.endsWith('.html'))
    throw refuse('must name an .html file inside resources/views')
  if (!existsSync(target) || !statSync(target).isFile())
    throw refuse('names a file that does not exist')
  if (escapes(realpathSync(target), realpathSync(views)))
    throw refuse('points outside resources/views through a link')
  if (statSync(target).size > MAX_PAGE_BYTES)
    throw refuse(`is larger than ${MAX_PAGE_BYTES / 1024} KiB`)
  return readFileSync(target, 'utf8')
}

function escapes(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)
}
