/**
 * Hooks: typed interception points where packages plug into each other's pipelines
 * (integration map §4), e.g. auth adds a row filter on `resource.beforeQuery`.
 *
 * Semantics:
 * - Handlers run **in a deterministic order**: registration order, adjusted by `before`/`after`
 *   hints that name other handlers. Hints naming handlers that aren't registered are ignored, so a
 *   plugin can say "run before auth" even when auth isn't installed.
 * - A handler may **transform** the payload by returning a new value, or **stop** the chain.
 * - An error **aborts** the chain by default (fail closed), wrapped in a {@link HookError} naming
 *   the hook and handler. `failSoft: true` reports the error and continues instead.
 *
 * @module
 */

/** Control passed to each handler. */
export interface HookControl {
  /** Stop running further handlers. The current payload becomes the result. */
  stop(): void
}

/** A handler: returns a replacement payload, or nothing to keep it unchanged. */
export type HookHandler<P> = (
  payload: P,
  control: HookControl,
) => P | undefined | Promise<P | undefined>

/** Options when registering a handler. */
export interface HookOptions {
  /** Unique name within the hook, e.g. `"auth.tenantScope"`. Used in ordering and errors. */
  readonly name: string
  /** Run before these handlers (by name). */
  readonly before?: string | readonly string[]
  /** Run after these handlers (by name). */
  readonly after?: string | readonly string[]
  /** Report errors and continue, instead of aborting. Off by default. */
  readonly failSoft?: boolean
}

/** Thrown when a handler fails (and isn't fail-soft) or the ordering hints are contradictory. */
export class HookError extends Error {
  readonly hook: string
  readonly handler: string | undefined
  constructor(hook: string, handler: string | undefined, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HookError'
    this.hook = hook
    this.handler = handler
  }
}

/** A registry of hooks, typed by a map of hook name to payload type. */
export interface HookRegistry<M extends Record<string, unknown>> {
  /** Register a handler. Returns a function that unregisters it. */
  on<K extends keyof M & string>(
    hook: K,
    handler: HookHandler<M[K]>,
    options: HookOptions,
  ): () => void
  /** Run every handler for `hook` in order and return the final payload. */
  run<K extends keyof M & string>(hook: K, payload: M[K]): Promise<M[K]>
  /** Handler names for a hook, in execution order (for `node strut doctor` and debugging). */
  order<K extends keyof M & string>(hook: K): readonly string[]
}

interface Entry {
  readonly handler: HookHandler<unknown>
  readonly options: HookOptions
  readonly seq: number
}

const list = (v: string | readonly string[] | undefined): readonly string[] =>
  v === undefined ? [] : typeof v === 'string' ? [v] : v

/** Topologically sort entries by before/after hints, stable by registration order. */
function sortEntries(hook: string, entries: readonly Entry[]): Entry[] {
  const byName = new Map(entries.map((e) => [e.options.name, e]))
  const edges = new Map<string, Set<string>>() // a → b means a runs before b
  for (const e of entries) edges.set(e.options.name, new Set())
  for (const e of entries) {
    const name = e.options.name
    for (const b of list(e.options.before)) if (byName.has(b)) edges.get(name)?.add(b)
    for (const a of list(e.options.after)) if (byName.has(a)) edges.get(a)?.add(name)
  }
  const indegree = new Map<string, number>()
  for (const e of entries) indegree.set(e.options.name, 0)
  for (const targets of edges.values()) {
    for (const t of targets) indegree.set(t, (indegree.get(t) ?? 0) + 1)
  }
  const ready = entries.filter((e) => indegree.get(e.options.name) === 0)
  const result: Entry[] = []
  while (ready.length > 0) {
    ready.sort((x, y) => x.seq - y.seq)
    const next = ready.shift() as Entry
    result.push(next)
    for (const t of edges.get(next.options.name) ?? []) {
      const d = (indegree.get(t) ?? 0) - 1
      indegree.set(t, d)
      if (d === 0) ready.push(byName.get(t) as Entry)
    }
  }
  if (result.length !== entries.length) {
    const stuck = entries.filter((e) => !result.includes(e)).map((e) => e.options.name)
    throw new HookError(
      hook,
      undefined,
      `Contradictory before/after hints on hook "${hook}": ${stuck.join(', ')}`,
    )
  }
  return result
}

/**
 * Create a hook registry.
 * @param onSoftError receives errors from `failSoft` handlers (e.g. to log them)
 */
export function createHooks<M extends Record<string, unknown>>(
  onSoftError: (error: HookError) => void = () => undefined,
): HookRegistry<M> {
  const hooks = new Map<string, Entry[]>()
  let seq = 0

  const sorted = (hook: string): Entry[] => sortEntries(hook, hooks.get(hook) ?? [])

  return {
    on(hook, handler, options) {
      if (!options.name) throw new TypeError(`hooks.on("${hook}"): options.name is required`)
      const entries = hooks.get(hook) ?? []
      if (entries.some((e) => e.options.name === options.name)) {
        throw new HookError(
          hook,
          options.name,
          `Handler "${options.name}" is already registered on "${hook}"`,
        )
      }
      const entry: Entry = { handler: handler as HookHandler<unknown>, options, seq: seq++ }
      const next = [...entries, entry]
      sortEntries(hook, next) // validate hints now, so contradictions fail at registration
      hooks.set(hook, next)
      return () => {
        hooks.set(
          hook,
          (hooks.get(hook) ?? []).filter((e) => e !== entry),
        )
      }
    },

    async run(hook, payload) {
      let current: unknown = payload
      let stopped = false
      const control: HookControl = {
        stop: () => {
          stopped = true
        },
      }
      for (const entry of sorted(hook)) {
        try {
          const result = await entry.handler(current, control)
          if (result !== undefined) current = result
        } catch (error) {
          const wrapped = new HookError(
            hook,
            entry.options.name,
            `Hook "${hook}" handler "${entry.options.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
          if (!entry.options.failSoft) throw wrapped
          onSoftError(wrapped)
        }
        if (stopped) break
      }
      return current as typeof payload
    },

    order(hook) {
      return sorted(hook).map((e) => e.options.name)
    },
  }
}
