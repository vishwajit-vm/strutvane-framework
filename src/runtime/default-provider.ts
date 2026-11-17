/**
 * The zero-option framework provider (`@strutvane/framework/provider`), the one
 * `strutvane.config.ts` registers. It reads everything from the app:
 * - the connection from `config/database.ts` (see {@link databaseConfigFrom});
 * - the models from {@link ProjectModelsToken}, bound by the project runtime (`node strut dev`/`start`);
 * - the storage disks from `config/filesystems.ts` (see {@link storageFromConfig}), signing
 *   temporary links with `APP_KEY` and serving them at `/storage/<disk>/…`.
 *
 * Apps that wire things by hand use `frameworkProvider({ database, models })` instead.
 *
 * @module
 */
import { type Application, defineProvider, type Provider } from '../core/index.ts'
import { frameworkProvider } from '../provider.ts'
import { ProjectModelsToken, ProjectSignedFilesToken } from '../tokens.ts'
import { type AppDatabaseConfig, databaseConfigFrom } from './database-config.ts'
import { type AppFilesystemsConfig, storageFromConfig } from './storage-config.ts'

/** Read a top-level config section without assuming the app's config type. */
export function section<T>(app: Application, name: string): T | undefined {
  return (app.settings as Readonly<Record<string, unknown>>)[name] as T | undefined
}

/** The project root: `app.root` (set by the runtime), else the working directory. */
export function projectRoot(app: Application): string {
  return section<{ root?: string }>(app, 'app')?.root ?? process.cwd()
}

/** Create the zero-option provider (a factory so tests get a fresh instance). */
export function createDefaultFrameworkProvider(): Provider {
  let inner: Provider | undefined
  return defineProvider({
    name: '@strutvane/framework',
    register(app) {
      const root = projectRoot(app)
      const storage = storageFromConfig(section<AppFilesystemsConfig>(app, 'filesystems'), {
        root,
        appKey: section<{ key?: string }>(app, 'app')?.key || process.env['APP_KEY'],
      })
      app.container.value(ProjectSignedFilesToken, storage.signedFiles)
      inner = frameworkProvider({
        database: databaseConfigFrom(section<AppDatabaseConfig>(app, 'database'), root),
        models: app.container.has(ProjectModelsToken) ? app.make(ProjectModelsToken) : [],
        storage: { default: storage.default, disks: storage.disks },
      })
      inner.register(app)
    },
    async boot(app) {
      await inner?.boot?.(app)
    },
    async shutdown(app) {
      await inner?.shutdown?.(app)
    },
  })
}
