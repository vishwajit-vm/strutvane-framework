/**
 * The `Event` facade: the current app's domain event bus (core `EventBusToken`), Laravel's
 * `Event::`. Listeners discovered in `app/listeners` are attached to the same bus at boot.
 *
 * Note: importing `Event` shadows the global DOM `Event` class in that module. Import it under
 * another name (`import { Event as Events }`) where you also need the DOM class.
 *
 * @module
 */
import type { EmitOptions, EmitResult, EventBus, EventListener } from '../core/events.ts'
import { EventBusToken } from '../core/tokens.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

type Bus = EventBus<Record<string, unknown>>

const binding: FacadeBinding<Bus> = {
  facade: 'Event',
  token: EventBusToken,
  provides: 'the event bus',
  install:
    'The core binds an event bus when the app is created; bind your own with app.container.value(EventBusToken, bus).',
}

/**
 * What the `Event` facade offers.
 *
 * @example
 * const events: EventFacade = Event
 */
export interface EventFacade {
  /** Subscribe; returns a function that unsubscribes. */
  on(type: string, listener: EventListener<string, unknown>): () => void
  /** Subscribe for the next event of this type only. */
  once(type: string, listener: EventListener<string, unknown>): () => void
  /** Emit a domain event to every listener (they run concurrently). */
  emit(type: string, payload: unknown, options?: EmitOptions): Promise<EmitResult<string, unknown>>
  /** Laravel's name for {@link EventFacade.emit}. */
  dispatch(
    type: string,
    payload: unknown,
    options?: EmitOptions,
  ): Promise<EmitResult<string, unknown>>
  /** How many listeners a type has. */
  listenerCount(type: string): number
  /** The bus itself, for code that takes an `EventBus`. */
  bus(): Bus
}

/**
 * Emit and listen to domain events on the current app's bus.
 *
 * @example
 * await Event.emit('invoice.paid', { invoiceId: invoice.id })
 * const off = Event.on('invoice.paid', (event) => audit.record(event))
 */
export const Event: EventFacade = Object.freeze({
  on: (type: string, listener: EventListener<string, unknown>): (() => void) =>
    resolveFacade(binding, 'on').on(type, listener),
  once: (type: string, listener: EventListener<string, unknown>): (() => void) =>
    resolveFacade(binding, 'once').once(type, listener),
  emit: (
    type: string,
    payload: unknown,
    options?: EmitOptions,
  ): Promise<EmitResult<string, unknown>> =>
    resolveFacade(binding, 'emit').emit(type, payload, options),
  dispatch: (
    type: string,
    payload: unknown,
    options?: EmitOptions,
  ): Promise<EmitResult<string, unknown>> =>
    resolveFacade(binding, 'dispatch').emit(type, payload, options),
  listenerCount: (type: string): number =>
    resolveFacade(binding, 'listenerCount').listenerCount(type),
  bus: (): Bus => resolveFacade(binding, 'bus'),
})
