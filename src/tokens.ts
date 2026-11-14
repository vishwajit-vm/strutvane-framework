/**
 * Container tokens the framework provides (integration map §3). Other packages resolve these
 * from the core container; they never import framework internals.
 *
 * @module
 */
import { type Token, token } from '@strutvane/core'
import type { Database } from './database/types.ts'
import type { AnyModel } from './model/define-model.ts'
import type { ModelRegistry } from './model/registry.ts'
import type { StorageManager } from './storage/manager.ts'
import type { SignedFileOptions } from './storage/serve-signed.ts'

/** The primary database connection (pool). */
export const DatabaseToken: Token<Database> = token<Database>('strutvane.database')

/** The app's validated model registry. */
export const ModelRegistryToken: Token<ModelRegistry> = token<ModelRegistry>('strutvane.models')

/** Storage disks (`local`, `memory`; `@strutvane/files` adds cloud drivers). */
export const StorageManagerToken: Token<StorageManager> = token<StorageManager>('strutvane.storage')

/**
 * The models discovered in `app/models` by the project runtime. The zero-option provider
 * (`@strutvane/framework/provider`) reads it; apps wiring `frameworkProvider({ models })` by hand
 * don't need it.
 */
/**
 * Disks whose signed temporary links the project's HTTP app serves (`/storage/<disk>/…`), from
 * `config/filesystems.ts`. Bound by the zero-option provider; framework-internal.
 */
export const ProjectSignedFilesToken: Token<readonly SignedFileOptions[]> = token<
  readonly SignedFileOptions[]
>('strutvane.framework.signedFiles')

export const ProjectModelsToken: Token<readonly AnyModel[]> = token<readonly AnyModel[]>(
  'strutvane.framework.projectModels',
)
