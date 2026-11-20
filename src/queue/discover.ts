/**
 * Job discovery (RFC-0006 §1.3): every job exported from a file under `app/jobs/` is registered,
 * the way listeners are discovered from `app/listeners/`. Only files inside the app's own folder
 * are imported (symbolic links are skipped), and only `defineJob` exports count.
 *
 * @module
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JobRegistry } from './registry.ts'

/** Where jobs live, relative to the app root. */
export const JOBS_FOLDER: string = join('app', 'jobs')

const JOB_FILE = /^(?!.*\.(?:test|spec|d)\.[cm]?[jt]s$).*\.(?:ts|js|mts|mjs)$/

/**
 * Import every job file under `app/jobs` and register its jobs. Returns the files imported.
 *
 * @example
 * await discoverJobs('/srv/blog', registry)
 */
export async function discoverJobs(basePath: string, registry: JobRegistry): Promise<string[]> {
  const files = jobFiles(join(basePath, JOBS_FOLDER))
  for (const file of files) {
    const module: Record<string, unknown> = await import(pathToFileURL(file).href)
    registry.registerModule(module)
  }
  return files
}

function jobFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .sort()
    .flatMap((name) => {
      const path = join(folder, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) return []
      if (stat.isDirectory()) return jobFiles(path)
      return JOB_FILE.test(name) ? [path] : []
    })
}
