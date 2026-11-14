/** Test helpers: temp projects, snapshots and fault-injecting I/O. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DevkitIo, nodeIo } from '../../src/devkit/io.ts'

/** A fresh temp directory and its cleanup. */
export async function tempProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sv-devkit-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Write files into a project (paths are project-relative POSIX). */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await nodeIo.writeText(join(root, path), content)
  }
}

/** Read a project file (undefined if missing). */
export function readFile(root: string, path: string): Promise<string | undefined> {
  return nodeIo.readText(join(root, path))
}

/** Every file under root (path → content), for "nothing changed" assertions. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of await nodeIo.listFiles(root, [])) {
    out[f] = (await nodeIo.readText(join(root, f))) ?? ''
  }
  return out
}

/**
 * I/O whose `rename` fails on the Nth call. With `dieAfterFailure`, every later operation also
 * fails, which simulates the process dying mid-commit (no rollback possible).
 */
export function faultyIo(
  failOnRename: number,
  options: { readonly dieAfterFailure?: boolean } = {},
): DevkitIo {
  let renames = 0
  let dead = false
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (dead) throw new Error('simulated crash: process is gone')
      return fn(...args)
    }
  return {
    readText: guard(nodeIo.readText),
    writeText: guard(nodeIo.writeText),
    remove: guard(nodeIo.remove),
    removeFile: guard(nodeIo.removeFile),
    inspect: guard(nodeIo.inspect),
    exists: guard(nodeIo.exists),
    listFiles: guard(nodeIo.listFiles),
    rename: guard(async (from: string, to: string) => {
      renames++
      if (renames === failOnRename) {
        if (options.dieAfterFailure === true) dead = true
        throw new Error(`simulated rename failure #${renames}`)
      }
      return nodeIo.rename(from, to)
    }),
  }
}

/** I/O whose `writeText` fails on the Nth call (staging failures). */
export function failingWriteIo(failOnWrite: number): DevkitIo {
  let writes = 0
  return {
    ...nodeIo,
    async writeText(path, content) {
      writes++
      if (writes === failOnWrite) throw new Error(`simulated write failure #${writes}`)
      return nodeIo.writeText(path, content)
    },
  }
}

/** Await a promise expected to reject and return the error. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/**
 * Create a symlink (or junction) if the OS allows it. Returns `false` where creating one needs a
 * privilege the test runner lacks (e.g. file symlinks on Windows without Developer Mode), so
 * symlink tests can skip gracefully instead of failing.
 */
export async function trySymlink(
  target: string,
  path: string,
  type: 'file' | 'dir' | 'junction',
): Promise<boolean> {
  const { symlink } = await import('node:fs/promises')
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false
    throw error
  }
}

/** True on POSIX systems, where permission bits and file ownership are meaningful. */
export const isPosix: boolean = process.platform !== 'win32'
