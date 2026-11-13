/**
 * Container tokens the framework provides (integration map §3). Other packages resolve these
 * from the core container; they never import framework internals.
 *
 * @module
 */
import { type Token, token } from '@strutvane/core'
import type { Database } from './database/types.ts'
import type { ModelRegistry } from './model/registry.ts'
import type { StorageManager } from './storage/manager.ts'

/** The primary database connection (pool). */
export const DatabaseToken: Token<Database> = token<Database>('strutvane.database')

/** The app's validated model registry. */
export const ModelRegistryToken: Token<ModelRegistry> = token<ModelRegistry>('strutvane.models')

/** Storage disks (`local`, `memory`; `@strutvane/files` adds cloud drivers). */
export const StorageManagerToken: Token<StorageManager> = token<StorageManager>('strutvane.storage')
