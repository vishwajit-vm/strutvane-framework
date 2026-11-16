/**
 * Event listeners with Laravel 11's discovery: every `app/listeners/*.listener.ts` file exporting
 * a class with `static readonly event = 'post.published'` and a `handle(payload)` method is a
 * listener. `node strut event:cache` writes the discovered list to `bootstrap/cache/events.json`
 * so production skips the folder scan; `event:list` shows it.
 *
 * Listeners subscribe to the core event bus (`EventBusToken`), so `bus.emit('post.published', …)`
 * reaches them like any other listener, with the bus's isolation (one failing listener never
 * stops the others). Listener modules are imported on first delivery, not at boot, so a cached app
 * boots without loading listener code it may never need.
 *
 * @module
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DomainEvent } from '../contracts/events.ts'
import type { Resolver } from '../core/container.ts'
import type { EventBus } from '../core/events.ts'
import { BootError } from './boot-error.ts'
import { buildUnchecked, type Injectable } from './inject.ts'

/**
 * A listener class.
 *
 * @example
 * export class LogPostPublished {
 *   static readonly event = 'post.published'
 *   handle(payload: unknown): void { … }
 * }
 */
export type ListenerClass = Injectable<{
  handle(payload: unknown, event: DomainEvent<string, unknown>): void | Promise<void>
}> & { readonly event: string; readonly name: string }

/**
 * Where a discovered listener lives: a file relative to the app and the export name.
 *
 * @example
 * const entry: ListenerEntry = { event: 'post.published', file: 'app/listeners/log-post-published.listener.ts', exportName: 'LogPostPublished' }
 */
export interface ListenerEntry {
  readonly event: string
  readonly file: string
  readonly exportName: string
}

/**
 * The folder discovery scans, relative to the app.
 *
 * @example
 * join(basePath, LISTENERS_FOLDER)
 */
export const LISTENERS_FOLDER: string = join('app', 'listeners')

/**
 * Scan `app/listeners` and import each `*.listener.ts` to find its listener classes.
 *
 * @example
 * const entries = await discoverListeners('/srv/blog')
 */
export async function discoverListeners(basePath: string): Promise<ListenerEntry[]> {
  const entries: ListenerEntry[] = []
  for (const file of listenerFiles(join(basePath, LISTENERS_FOLDER))) {
    const module: Record<string, unknown> = await import(pathToFileURL(file).href)
    for (const [exportName, value] of Object.entries(module)) {
      if (isListenerClass(value))
        entries.push({
          event: value.event,
          file: relative(basePath, file).split(sep).join('/'),
          exportName,
        })
    }
  }
  return entries.sort((a, b) => a.event.localeCompare(b.event) || a.file.localeCompare(b.file))
}

function listenerFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .flatMap((name) => {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) return listenerFiles(path)
      return /\.listener\.(?:ts|js|mts|mjs)$/.test(name) ? [path] : []
    })
    .sort()
}

function isListenerClass(value: unknown): value is ListenerClass {
  return (
    typeof value === 'function' &&
    'event' in value &&
    typeof value.event === 'string' &&
    typeof (value.prototype as { handle?: unknown } | undefined)?.handle === 'function'
  )
}

/**
 * Checks a cached listener list (it came from a file, so it is checked like input): every entry
 * points at a file inside `app/listeners`.
 *
 * @example
 * isListenerList(payload) // true
 */
export function isListenerList(value: unknown): value is ListenerEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ListenerEntry).event === 'string' &&
        typeof (entry as ListenerEntry).exportName === 'string' &&
        typeof (entry as ListenerEntry).file === 'string' &&
        insideListeners((entry as ListenerEntry).file),
    )
  )
}

function insideListeners(file: string): boolean {
  const folder = LISTENERS_FOLDER.split(sep).join('/')
  const inside = relative(resolve('/', folder), resolve('/', file))
  return file.startsWith(`${folder}/`) && !inside.startsWith('..') && !isAbsolute(inside)
}

/**
 * The app's listeners: discovered (or cached) entries plus explicit `listen()` calls, subscribed
 * to the core event bus at boot.
 *
 * @example
 * app.events.listen(SendInvoice)
 */
export class ListenerRegistry {
  readonly #basePath: string
  readonly #entries: ListenerEntry[] = []
  readonly #explicit: ListenerClass[] = []

  constructor(basePath: string) {
    this.#basePath = basePath
  }

  /**
   * Replace the discovered entries (boot does this from the cache or a scan).
   *
   * @example
   * registry.useDiscovered(await discoverListeners(basePath))
   */
  useDiscovered(entries: readonly ListenerEntry[]): void {
    this.#entries.splice(0, this.#entries.length, ...entries)
  }

  /**
   * The discovered entries, for `event:cache`.
   *
   * @example
   * app.events.discovered
   */
  get discovered(): readonly ListenerEntry[] {
    return [...this.#entries]
  }

  /**
   * Register a listener by hand (from a provider).
   *
   * @example
   * app.events.listen(SendInvoice)
   */
  listen(listener: ListenerClass): void {
    if (!isListenerClass(listener))
      throw new BootError(
        'invalid_listener',
        `${String((listener as { name?: unknown }).name)} is not a listener class.`,
        "A listener has `static readonly event = 'name'` and a handle(payload) method.",
      )
    this.#explicit.push(listener)
  }

  /**
   * Every event and its listeners, for `event:list`.
   *
   * @example
   * app.events.list() // [{ event: 'post.published', listeners: ['LogPostPublished (app/listeners/…)'] }]
   */
  list(): { readonly event: string; readonly listeners: readonly string[] }[] {
    const events = new Map<string, string[]>()
    const add = (event: string, label: string): void => {
      events.set(event, [...(events.get(event) ?? []), label])
    }
    for (const entry of this.#entries) add(entry.event, `${entry.exportName} (${entry.file})`)
    for (const listener of this.#explicit) add(listener.event, listener.name)
    return [...events]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([event, listeners]) => ({ event, listeners }))
  }

  /**
   * Subscribe every listener to the event bus. Discovered modules are imported on first delivery;
   * instances are built through the container per event (their `static inject` is honoured).
   *
   * @example
   * app.events.attach(app.make(EventBusToken), app.container)
   */
  attach(bus: EventBus<Record<string, unknown>>, resolver: Resolver): void {
    for (const entry of this.#entries) {
      bus.on(entry.event, async (event) => {
        const module: Record<string, unknown> = await import(
          pathToFileURL(join(this.#basePath, entry.file)).href
        )
        const listener = module[entry.exportName]
        if (!isListenerClass(listener))
          throw new BootError(
            'listener_moved',
            `${entry.exportName} is no longer a listener in ${entry.file}.`,
            'Run `node strut event:cache` again (or `node strut event:clear`).',
          )
        await deliver(listener, resolver, event)
      })
    }
    for (const listener of this.#explicit)
      bus.on(listener.event, (event) => deliver(listener, resolver, event))
  }
}

async function deliver(
  listener: ListenerClass,
  resolver: Resolver,
  event: DomainEvent<string, unknown>,
): Promise<void> {
  const instance = buildUnchecked(resolver, listener) as {
    handle(payload: unknown, event: DomainEvent<string, unknown>): void | Promise<void>
  }
  await instance.handle(event.payload, event)
}
