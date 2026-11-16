/**
 * What the F-06 replay sandbox's parent and child agree on. Kept apart from the worker module so
 * the parent never imports the worker: the worker must stay its own built entry
 * (`dist/replay-worker.mjs`), whose `import.meta.url` is what starts it in the child.
 *
 * @module
 */

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
