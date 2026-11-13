/**
 * The zero-option framework provider (`@strutvane/framework/provider`), the one
 * `strutvane.config.ts` registers. It reads everything from the app:
 * - the connection from `config/database.ts` (see {@link databaseConfigFrom});
 * - the models from {@link ProjectModelsToken}, bound by the project runtime (`sv dev`/`start`).
 *
 * Apps that wire things by hand use `frameworkProvider({ database, models })` instead.
 *
 * @module
 */
import { type Application, defineProvider, type Provider } from '@strutvane/core'
import { frameworkProvider } from '../provider.ts'
import { ProjectModelsToken } from '../tokens.ts'
import { type AppDatabaseConfig, databaseConfigFrom } from './database-config.ts'

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
      inner = frameworkProvider({
        database: databaseConfigFrom(section<AppDatabaseConfig>(app, 'database'), projectRoot(app)),
        models: app.container.has(ProjectModelsToken) ? app.make(ProjectModelsToken) : [],
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
