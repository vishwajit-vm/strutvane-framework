/**
 * Projects reached through a linked folder, on every OS.
 *
 * On macOS `os.tmpdir()` is under `/var`, a symlink to `/private/var`, so every temp project is
 * reached through a link there and code that compares real paths with spelled ones breaks only on
 * macOS. These helpers recreate that on every OS: a directory symlink on POSIX, a directory
 * junction on Windows (junctions need no privilege, unlike symlinks).
 *
 * @module
 */
import { lstatSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A link to a folder, or why the OS refused to create one. */
export type LinkedFolder = { readonly path: string } | { readonly skipped: string }

const created: { readonly holder: string | undefined; readonly link: string }[] = []

/**
 * Create a link (symlink on POSIX, junction on Windows) to `target` in a fresh temp folder.
 *
 * @example
 * const linked = linkFolder(realProject)
 * if ('path' in linked) await run(linked.path, 'migrate')
 */
export function linkFolder(target: string): LinkedFolder {
  const holder = mkdtempSync(join(tmpdir(), 'sv-link-'))
  const path = join(holder, 'project')
  created.push({ holder, link: path })
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return { path }
  } catch (error) {
    return {
      skipped: `the OS refused to create a directory link (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/**
 * Create a directory link at `path` pointing to `target` (a junction on Windows), or say why the
 * OS refused. {@link removeLinks} removes the link itself, never the target.
 */
export function linkDirectory(target: string, path: string): string | undefined {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    created.push({ holder: undefined, link: path })
    return undefined
  } catch (error) {
    return `the OS refused to create a directory link (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Create a file symlink at `path` pointing to `target`, or say why the OS refused (Windows
 * allows file symlinks only with Developer Mode or an elevated shell).
 */
export function linkFile(target: string, path: string): string | undefined {
  try {
    symlinkSync(target, path, 'file')
    return undefined
  } catch (error) {
    return `the OS refused to create a file symlink (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Remove the links created so far (call it before removing the projects), never what they point to: each link is removed on its own
 * first (`unlink`, or a non-recursive `rmdir` for a junction), and only then its holder folder.
 */
export function removeLinks(): void {
  for (const { holder, link } of created.splice(0)) {
    if (isLink(link)) {
      try {
        unlinkSync(link)
      } catch {
        rmdirSync(link) // A junction on Windows: removes the link, not the target's contents.
      }
    }
    if (holder !== undefined) rmSync(holder, { recursive: true, force: true })
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
