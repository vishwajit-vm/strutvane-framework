/**
 * The in-process event bus. Packages announce business facts ("invoice.sent") as
 * {@link DomainEvent}s; listeners react without the emitter knowing about them
 * (integration map §5).
 *
 * **Isolation:** one failing listener never stops the others and never breaks the emitter. Errors
 * are collected, reported through `onListenerError`, and returned. Set `throwListenerErrors` to make
 * `emit` reject (useful in tests and for critical in-transaction listeners).
 *
 * Durable, cross-process delivery (outbox → queue) is built on top of this by the framework.
 *
 * @module
 */
import type { ActorStamp, DomainEvent } from '@strutvane/contracts'
import { type Clock, systemClock } from './clock.ts'
import { type UuidGenerator, uuidv7 } from './uuid.ts'

/** A listener for one event type. May be async. */
export type EventListener<T extends string, P> = (event: DomainEvent<T, P>) => void | Promise<void>

/** Optional event metadata supplied by the emitter. */
export interface EmitOptions {
  /** Payload schema version (default 1). */
  readonly version?: number
  readonly tenantId?: string
  readonly actor?: ActorStamp
  /** Defaults to the event id. Supply one to make retries deduplicate. */
  readonly idempotencyKey?: string
  readonly correlationId?: string
}

/** What happened during an emit. */
export interface EmitResult<T extends string, P> {
  readonly event: DomainEvent<T, P>
  /** Number of listeners that ran. */
  readonly delivered: number
  /** Errors thrown by listeners (empty when all succeeded). */
  readonly errors: readonly unknown[]
}

/** A typed event bus. `E` maps event names to payload types. */
export interface EventBus<E extends Record<string, unknown>> {
  /** Subscribe. Returns a function that unsubscribes. */
  on<K extends keyof E & string>(type: K, listener: EventListener<K, E[K]>): () => void
  /** Subscribe for the next event of this type only. */
  once<K extends keyof E & string>(type: K, listener: EventListener<K, E[K]>): () => void
  /** Build a DomainEvent and deliver it to every listener. Listeners run concurrently. */
  emit<K extends keyof E & string>(
    type: K,
    payload: E[K],
    options?: EmitOptions,
  ): Promise<EmitResult<K, E[K]>>
  /** Number of listeners for a type. */
  listenerCount<K extends keyof E & string>(type: K): number
}

/** Options for {@link createEventBus}. */
export interface EventBusOptions {
  readonly clock?: Clock
  readonly ids?: UuidGenerator
  /** Receives every listener error (e.g. to log it). */
  readonly onListenerError?: (error: unknown, event: DomainEvent<string, unknown>) => void
  /** Make `emit` reject with an AggregateError when any listener fails. Default: false. */
  readonly throwListenerErrors?: boolean
}

/** Create an event bus. */
export function createEventBus<E extends Record<string, unknown>>(
  options: EventBusOptions = {},
): EventBus<E> {
  const clock = options.clock ?? systemClock
  const ids = options.ids ?? uuidv7
  const listeners = new Map<string, Set<EventListener<string, unknown>>>()

  const add = (type: string, listener: EventListener<string, unknown>): (() => void) => {
    const set = listeners.get(type) ?? new Set()
    set.add(listener)
    listeners.set(type, set)
    return () => {
      set.delete(listener)
    }
  }

  return {
    on(type, listener) {
      return add(type, listener as EventListener<string, unknown>)
    },

    once(type, listener) {
      const wrapper: EventListener<string, unknown> = (event) => {
        off()
        return (listener as EventListener<string, unknown>)(event)
      }
      const off = add(type, wrapper)
      return off
    },

    async emit(type, payload, emitOptions = {}) {
      const id = ids()
      const event = Object.freeze({
        id,
        type,
        version: emitOptions.version ?? 1,
        payload,
        occurredAt: new Date(clock.now()).toISOString(),
        idempotencyKey: emitOptions.idempotencyKey ?? id,
        ...(emitOptions.tenantId !== undefined ? { tenantId: emitOptions.tenantId } : {}),
        ...(emitOptions.actor !== undefined ? { actor: emitOptions.actor } : {}),
        ...(emitOptions.correlationId !== undefined
          ? { correlationId: emitOptions.correlationId }
          : {}),
      }) as DomainEvent<typeof type, typeof payload>

      // Snapshot so listeners added or removed during delivery don't affect this emit.
      const current = [...(listeners.get(type) ?? [])]
      const settled = await Promise.allSettled(
        current.map(async (listener) => listener(event as DomainEvent<string, unknown>)),
      )
      const errors = settled
        .filter((s) => s.status === 'rejected')
        .map((s) => (s as PromiseRejectedResult).reason)
      for (const error of errors) {
        try {
          options.onListenerError?.(error, event as DomainEvent<string, unknown>)
        } catch {
          // An error reporter must never break event delivery.
        }
      }
      if (errors.length > 0 && options.throwListenerErrors) {
        throw new AggregateError(errors, `${errors.length} listener(s) failed for "${type}"`)
      }
      return { event, delivered: current.length, errors }
    },

    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}
