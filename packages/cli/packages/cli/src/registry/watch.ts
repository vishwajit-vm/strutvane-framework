/**
 * Watch mode.
 *
 * Choice: `node:fs.watch` with `recursive: true` (native on Windows and macOS; supported on Linux
 * since Node 20). No chokidar dependency because:
 * - we only watch two fixed folders (`app/`, `web/`), not arbitrary globs;
 * - we never trust individual events: any event just schedules a debounced rebuild, and the
 *   rebuild re-lists the folders and compares content hashes. Duplicate, missing or reordered
 *   events (a known fs.watch quirk, especially for renames and editor "safe writes") therefore
 *   cannot produce a wrong registry; at worst they cause one extra cheap rebuild.
 *
 * Watching the project root recursively is avoided on purpose: it would include `node_modules`
 * and exhaust inotify watches on Linux. The root is watched non-recursively only to notice when
 * `app/` or `web/` is created or deleted.
 *
 * Event storms (found by this spike's tests, Windows): deleting a folder that is being watched
 * makes fs.watch emit an ENDLESS stream of `rename` events for that folder (thousands per second),
 * with no `error` and no `close`. A plain trailing debounce restarts on every event and so NEVER
 * fires: the registry silently stopped updating. Two defences:
 * 1. the debounce has a maximum wait (`maxWaitMs`): a rebuild happens at the latest that long after
 *    the first pending event, however many events keep arriving;
 * 2. an event for a watched folder that no longer exists closes that watcher at once, which ends
 *    the storm at its source.
 * A once-a-second existence check of the two folders (unref'd) covers platforms that emit no event
 * at all for such changes.
 */
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import { RegistryCompiler, type WriteResult } from './compiler.ts'

export interface WatchOptions {
  /** Quiet period before rebuilding (editors often write a file in several steps). */
  readonly debounceMs?: number
  /** Upper bound between the first pending event and the rebuild, even under an event storm. */
  readonly maxWaitMs?: number
  /** How often the watched folders' existence is re-checked (safety net). */
  readonly folderCheckMs?: number
  /** Called after every rebuild (also the initial one). */
  readonly onResult: (result: WriteResult) => void
  /** Called if a rebuild throws unexpectedly (I/O failure). The watcher keeps running. */
  readonly onError?: (error: unknown) => void
}

export interface WatchHandle {
  /** Stop watching and release all handles. Safe to call twice. */
  close(): void
  /** Force a rebuild now (used by tests and by `sv` when it knows a file changed). */
  rebuild(): WriteResult
}

const WATCHED_DIRS = ['app', 'web'] as const

export function watchProject(root: string, options: WatchOptions): WatchHandle {
  const compiler = new RegistryCompiler(root)
  const debounceMs = options.debounceMs ?? 25
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? 200)
  const watchers = new Map<string, FSWatcher>()
  let timer: NodeJS.Timeout | undefined
  let pendingSince: number | undefined
  let closed = false

  const rebuild = (): WriteResult => {
    const result = compiler.write()
    options.onResult(result)
    return result
  }

  const flush = (): void => {
    timer = undefined
    pendingSince = undefined
    if (closed) return
    try {
      attach() // folders may have appeared or disappeared
      rebuild()
    } catch (error) {
      options.onError?.(error)
    }
  }

  /** Debounce with a maximum wait, so a continuous stream of events cannot starve the rebuild. */
  const schedule = (): void => {
    if (closed) return
    const now = Date.now()
    pendingSince ??= now
    const waited = now - pendingSince
    if (timer !== undefined) {
      if (waited >= maxWaitMs) return // let the pending timer fire
      clearTimeout(timer)
    }
    timer = setTimeout(flush, Math.min(debounceMs, Math.max(0, maxWaitMs - waited)))
  }

  const detach = (name: string): void => {
    watchers.get(name)?.close()
    watchers.delete(name)
  }

  const attach = (): void => {
    for (const name of WATCHED_DIRS) {
      const dir = join(root, name)
      if (!existsSync(dir)) {
        detach(name)
        continue
      }
      if (watchers.has(name)) continue
      const watcher = watch(dir, { recursive: true }, () => {
        // An event for a folder that is gone: stop this watcher (ends the Windows event storm).
        if (!existsSync(dir)) detach(name)
        schedule()
      })
      watcher.on('error', () => {
        // e.g. the folder was deleted (EPERM on Windows). Drop it; the next rebuild re-attaches.
        detach(name)
        schedule()
      })
      watchers.set(name, watcher)
    }
  }

  const rootWatcher = watch(root, { recursive: false }, (_event, filename) => {
    if (filename === null || WATCHED_DIRS.some((d) => filename === d)) schedule()
  })
  rootWatcher.on('error', (error) => options.onError?.(error))

  // Safety net for platforms that report nothing when a watched folder appears or disappears.
  const folderCheck = setInterval(() => {
    if (WATCHED_DIRS.some((name) => existsSync(join(root, name)) !== watchers.has(name))) schedule()
  }, options.folderCheckMs ?? 1_000)
  folderCheck.unref()

  attach()
  rebuild()

  return {
    rebuild,
    close(): void {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      clearInterval(folderCheck)
      rootWatcher.close()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
