/**
 * The real path of a project root, resolved once, up front.
 *
 * Why: the framework's containment checks (migrations, seeders, policies) compare **real** paths
 * (`realpath`, symlinks followed), so a link can never smuggle a file in from outside. If the root
 * itself is still spelled through a link, the two spellings disagree: on macOS `os.tmpdir()` is
 * `/var/…`, a symlink to `/private/var/…`, and a project there is reached through a link; the same
 * happens with a symlinked checkout or a Windows junction. Then a file of the project is known
 * under two names, a module loader can load it twice (two module instances, so an identity check
 * like "this seeder object" no longer matches), and paths derived from the root no longer line up
 * with the checked ones. Resolving the root once, before anything is derived from it, gives one
 * spelling everywhere. It changes no protection: every check still realpaths what it checks, so a
 * link *inside* the project pointing outside is refused as before.
 *
 * @module
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The absolute real path of `root` (symlinks and junctions followed). A root that doesn't exist
 * is returned absolute but otherwise as given, so the caller's own "not found" error names it.
 *
 * Uses `realpathSync` (not `.native`), the same function every containment check uses, so both
 * sides of each comparison are spelled the same way.
 *
 * @example
 * realRoot('/var/folders/x/T/blog') // '/private/var/folders/x/T/blog' on macOS
 */
export function realRoot(root: string): string {
  const absolute = resolve(root)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}
