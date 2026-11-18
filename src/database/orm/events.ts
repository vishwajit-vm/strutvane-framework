/**
 * Model lifecycle events: `post.created`, `post.updated`, `post.deleted`, `post.restored`, the
 * domain events the integration map (§5, `<model>.created/.updated/.deleted`) promises to search,
 * notifications and webhooks.
 *
 * **What emits them:** a model's own `save()` (insert or update with changes), `delete()` (soft
 * or hard), `forceDelete()` and `restore()`. Mass updates and deletes through the query builder
 * (`Post.where(…).delete()`) emit nothing, exactly like Eloquent: there is no model instance to
 * describe.
 *
 * **When:** after the change is committed. Inside `transaction(…)` the event waits for the
 * outermost COMMIT and is dropped on rollback (`Connection.afterCommit`), so a listener never
 * indexes or announces a row that doesn't exist. Outside a transaction it is emitted right after
 * the statement.
 *
 * **Where to:** the running application's event bus (`EventBusToken`), as a `DomainEvent` with
 * the payload below and the tenant. The ORM never imports the application: the app installs a
 * dispatcher for its requests and commands with {@link runWithModelEvents}, the same way it
 * installs its connection. Without one (a plain script), nothing is emitted. Listener failures
 * are the bus's business (reported, isolated); they never undo the committed write.
 *
 * **The payload is data, not the live model:** `record` is the model's `toJSON()` (hidden columns
 * already removed), so it is safe to log, queue or send. Listeners that need the instance load it
 * by `key` (inside the same tenant scope).
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { singularize } from '../../core/inflection.ts'

/**
 * The model lifecycle moments that become events.
 *
 * @example
 * const verb: ModelEventVerb = 'created'
 */
export type ModelEventVerb = 'created' | 'updated' | 'deleted' | 'restored'

/**
 * The payload of a model event.
 *
 * @example
 * bus.on('post.updated', (event) => event.payload.changed) // ['title', 'updated_at']
 */
export interface ModelEventPayload {
  /** The table, e.g. `posts`. */
  readonly table: string
  /** The model class name, e.g. `Post`. */
  readonly model: string
  /** The primary key value. */
  readonly key: unknown
  /** The row as the API would show it (`toJSON()`: hidden columns removed). */
  readonly record: Readonly<Record<string, unknown>>
  /** `updated` only: the columns that changed. */
  readonly changed?: readonly string[]
  /** `deleted` only: `true` for a soft delete (`deleted_at` set), `false` for a real delete. */
  readonly soft?: boolean
}

/**
 * Where model events go. The application provides one per request and command.
 *
 * @example
 * const dispatcher: ModelEventDispatcher = { wants: () => true, dispatch: async () => {} }
 */
export interface ModelEventDispatcher {
  /** `false` when nobody listens to `type`: the ORM then builds no payload at all. */
  wants(type: string): boolean
  /** Deliver one event (after commit). */
  dispatch(type: string, payload: ModelEventPayload, tenantId: string | undefined): Promise<void>
}

const scoped = new AsyncLocalStorage<ModelEventDispatcher>()

/**
 * Run `work` with model events going to `dispatcher`. The application wraps every request and
 * command in it.
 *
 * @example
 * await runWithModelEvents(dispatcher, () => post.save())
 */
export function runWithModelEvents<TResult>(
  dispatcher: ModelEventDispatcher,
  work: () => TResult,
): TResult {
  return scoped.run(dispatcher, work)
}

/**
 * The dispatcher in scope, or `undefined` (scripts without an application).
 *
 * @example
 * currentModelEvents()?.wants('post.created')
 */
export function currentModelEvents(): ModelEventDispatcher | undefined {
  return scoped.getStore()
}

/**
 * The event name for a table (or model class) and a verb: `posts` → `post.created`,
 * `blog_posts` → `blog_post.updated`. Packages use this instead of guessing the spelling.
 *
 * @example
 * bus.on(modelEventName(Post, 'created'), listener)
 * modelEventName('order_lines', 'deleted') // 'order_line.deleted'
 */
export function modelEventName(
  target: string | { readonly table: string },
  verb: ModelEventVerb,
): string {
  const table = typeof target === 'string' ? target : target.table
  return `${singularize(table)}.${verb}`
}
