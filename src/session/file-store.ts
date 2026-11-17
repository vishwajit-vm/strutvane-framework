/**
 * The framework's file session store, `storage/framework/sessions`: the default
 * `SessionStoreToken` binding when no package (the auth package's database sessions) bound one.
 *
 * The framework only needs `flush()` from it, for `node strut session:flush` after an incident (a
 * leaked session store, a compromised admin): deleting every session signs everyone out. Reading
 * and writing sessions belongs to the auth package.
 *
 * Only regular, non-hidden files directly in the folder are removed: nothing outside it, and no
 * `.gitignore` the skeleton keeps there. Each removal retries Windows' transient sharing errors.
 *
 * @module
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeFile } from '../support/atomic-write.ts'
import type { SessionStore } from './contract.ts'

/**
 * The file store's folder, relative to the app.
 *
 * @example
 * join(basePath, SESSION_FOLDER) // '/srv/blog/storage/framework/sessions'
 */
export const SESSION_FOLDER: string = join('storage', 'framework', 'sessions')

/**
 * The file session store: one file per session.
 *
 * @example
 * const removed = await new FileSessionStore('/srv/blog').flush() // 3
 */
export class FileSessionStore implements SessionStore {
  readonly #folder: string

  constructor(basePath: string) {
    this.#folder = join(basePath, SESSION_FOLDER)
  }

  async flush(): Promise<number> {
    if (!existsSync(this.#folder)) return 0
    let removed = 0
    for (const entry of readdirSync(this.#folder, { withFileTypes: true }))
      if (
        entry.isFile() &&
        !entry.name.startsWith('.') &&
        removeFile(join(this.#folder, entry.name))
      )
        removed++
    return removed
  }
}
