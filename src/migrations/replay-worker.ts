/**
 * The child side of the migration replay sandbox (security review F-06). Never imported by app
 * code: `replayInSandbox()` starts it as `node --permission … replay-worker <dir> <files…>`.
 *
 * Before any migration is imported it:
 * 1. installs a module resolve hook: `@strutvane/framework/schema` maps to the framework's own
 *    schema entry next to this file, migrations may import relative `.ts` files inside the
 *    migrations folder, and **every other import is refused** (`node:fs`, `node:net`, packages,
 *    files elsewhere), including dynamic `import()`;
 * 2. removes the network globals (`fetch`, `WebSocket`, `EventSource`, …): Node 24 has no
 *    `--allow-net`, so network access is closed by this, the resolve hook, the static gate and
 *    the permission model together;
 * 3. then imports each migration, replays it in memory and sends the recorded operations back over
 *    the IPC channel as plain JSON, the only output the parent reads.
 *
 * @module
 */
import { registerHooks } from 'node:module'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SchemaError } from '../schema/errors.ts'
import { type LoadedMigration, loadMigrations, replayMigrations } from '../schema/replay.ts'

/** The message the worker sends to the parent. */
export type WorkerMessage =
  | {
      readonly ok: true
      readonly migrations: readonly {
        readonly name: string
        readonly up: unknown
        readonly down: unknown
      }[]
    }
  | {
      readonly ok: false
      readonly error: {
        readonly message: string
        readonly code?: string
        readonly hint?: string
        readonly migration?: string
      }
    }

/** The import specifier migrations use for the Schema builder. */
export const SCHEMA_SPECIFIER = '@strutvane/framework/schema'

/** Network capabilities removed from the sandbox's globals. */
export const NETWORK_GLOBALS: readonly string[] = [
  'fetch',
  'WebSocket',
  'EventSource',
  'Request',
  'Response',
  'Headers',
  'FormData',
]

/**
 * The framework's own schema entry, next to this worker: `src/entries/schema.ts` when running from
 * the sources, `schema.mjs` beside the built `replay-worker.mjs`.
 *
 * @example
 * schemaEntryUrl('file:///app/node_modules/@strutvane/framework/dist/replay-worker.mjs')
 * // 'file:///app/node_modules/@strutvane/framework/dist/schema.mjs'
 */
export function schemaEntryUrl(workerUrl: string): string {
  return workerUrl.endsWith('.ts')
    ? new URL('../entries/schema.ts', workerUrl).href
    : new URL('./schema.mjs', workerUrl).href
}

/** Is `child` the folder `parent` or inside it? */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Decide one import inside the sandbox: the mapped schema entry, a relative file inside the
 * migrations folder, or a refusal (thrown as a {@link SchemaError}).
 *
 * @example
 * sandboxResolve('@strutvane/framework/schema', parentUrl, rules) // { url: '…/schema.mjs' }
 */
export function sandboxResolve(
  specifier: string,
  parentUrl: string | undefined,
  rules: {
    readonly migrationsDir: string
    readonly frameworkDir: string
    readonly schemaUrl: string
  },
): { readonly url: string } | 'next' {
  if (specifier === SCHEMA_SPECIFIER) return { url: rules.schemaUrl }
  const parent =
    parentUrl === undefined || !parentUrl.startsWith('file:') ? undefined : fileURLToPath(parentUrl)
  // The worker itself and the framework's own modules load what they need.
  if (parent === undefined || inside(rules.frameworkDir, parent)) return 'next'
  if (
    inside(rules.migrationsDir, parent) &&
    (specifier.startsWith('./') || specifier.startsWith('../'))
  ) {
    const target = fileURLToPath(new URL(specifier, parentUrl))
    if (inside(rules.migrationsDir, target) && target.endsWith('.ts'))
      return { url: pathToFileURL(target).href }
  }
  throw new SchemaError(
    'invalid_migration',
    `A migration tried to import "${specifier}", which migrations may not use.`,
    `Migrations may only import ${SCHEMA_SPECIFIER} and .ts files inside database/migrations. Put data changes that need other modules in a seeder.`,
  )
}

/**
 * Import and replay the given migration files, and turn the outcome into the message the parent
 * reads: the recorded operations, or the error (message, code, hint and the migration's file).
 * Runs inside the sandboxed child after {@link main} has locked imports and globals down.
 *
 * @example
 * const message = await recordMigrations(folder, ['2026_01_01_000000_create_tags_table.ts'])
 */
export async function recordMigrations(
  migrationsDir: string,
  files: readonly string[],
): Promise<WorkerMessage> {
  try {
    const loaded: LoadedMigration[] = []
    for (const file of files) {
      const name = file.slice(0, -'.ts'.length)
      try {
        loaded.push(...(await loadMigrations([{ name, path: join(migrationsDir, file) }])))
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          migration: file,
        })
      }
    }
    const replay = replayMigrations(loaded)
    return {
      ok: true,
      migrations: replay.migrations.map((step) => ({
        name: step.name,
        up: step.up,
        down: step.down,
      })),
    }
  } catch (error) {
    const fields = error instanceof Error ? (error as Error & Record<string, unknown>) : undefined
    const text = (key: string): string | undefined =>
      typeof fields?.[key] === 'string' ? (fields[key] as string) : undefined
    const code = text('code')
    const hint = text('hint')
    const migration = text('migration')
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(code === undefined ? {} : { code }),
        ...(hint === undefined ? {} : { hint }),
        ...(migration === undefined ? {} : { migration }),
      },
    }
  }
}

/** The sandboxed child: lock imports and globals down, replay, send the result, exit. */
async function main(): Promise<void> {
  const [migrationsDir = '', ...files] = process.argv.slice(2)
  const workerUrl = import.meta.url
  const rules = {
    migrationsDir,
    frameworkDir: fileURLToPath(new URL(workerUrl.endsWith('.ts') ? '..' : '.', workerUrl)),
    schemaUrl: schemaEntryUrl(workerUrl),
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const decision = sandboxResolve(specifier, context.parentURL, rules)
      return decision === 'next'
        ? nextResolve(specifier, context)
        : { url: decision.url, shortCircuit: true }
    },
  })
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of NETWORK_GLOBALS) delete globals[name]
  const message = await recordMigrations(migrationsDir, files)
  process.send?.(message, () => process.exit(0))
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
