/**
 * `frameworkProvider()`: registers the framework's services in a core `Application`:
 * the database, the model registry and storage, plus its error codes. The HTTP app is created
 * from the booted application with `createHttpApp(app, …)`.
 *
 * ```ts
 * const app = createApp({
 *   config: {},
 *   providers: [frameworkProvider({ database: { driver: 'sqlite', url: 'file:dev.db' }, models: [Invoice] })],
 * })
 * await app.boot()
 * const http = createHttpApp(app, { resources: [Invoice] })
 * ```
 *
 * @module
 */
import type { StorageDisk } from '@strutvane/contracts'
import { defineProvider, ErrorRegistryToken, type Provider } from '@strutvane/core'
import { connectDatabase, type DatabaseConfig } from './database/connect.ts'
import type { Database } from './database/types.ts'
import { registerFrameworkErrors } from './messages.ts'
import type { AnyModel, ModelDefinition } from './model/define-model.ts'
import { createModelRegistry, type ModelRegistry } from './model/registry.ts'
import { registerModelSensitiveKeys } from './model/sensitive-keys.ts'
import { createLocalDisk } from './storage/local-disk.ts'
import { createStorageManager, type StorageManager } from './storage/manager.ts'
import { DatabaseToken, ModelRegistryToken, StorageManagerToken } from './tokens.ts'

/** Options for {@link frameworkProvider}. */
export interface FrameworkProviderOptions {
  /** A ready connection, or configuration to open one at boot. */
  readonly database: Database | DatabaseConfig
  readonly models: readonly (AnyModel | ModelDefinition)[]
  /** Disks; default one private `local` disk at `storage/app`. */
  readonly storage?: { readonly default: string; readonly disks: readonly StorageDisk[] }
}

/** The framework's service provider. */
export function frameworkProvider(options: FrameworkProviderOptions): Provider {
  let db: Database | undefined
  let registry: ModelRegistry | undefined
  let storage: StorageManager | undefined
  return defineProvider({
    name: '@strutvane/framework',
    register(app) {
      // Validate models at register time: a bad model set must stop the app early and loudly.
      registry = createModelRegistry(options.models)
      const models = registry
      app.container.value(ModelRegistryToken, models)
      app.container.singleton(DatabaseToken, () => {
        if (!db)
          throw new Error('The database is not connected yet (resolve DatabaseToken after boot)')
        return db
      })
      app.container.singleton(StorageManagerToken, () => {
        storage ??= createStorageManager(
          options.storage ?? {
            default: 'local',
            disks: [createLocalDisk({ name: 'local', root: 'storage/app' })],
          },
        )
        return storage
      })
    },
    async boot(app) {
      registerFrameworkErrors(app.make(ErrorRegistryToken))
      // Model fields marked sensitive or hidden never appear in logs (core's redaction registry).
      registerModelSensitiveKeys(registry?.all ?? [])
      db = 'query' in options.database ? options.database : await connectDatabase(options.database)
    },
    async shutdown() {
      await db?.close()
    },
  })
}
