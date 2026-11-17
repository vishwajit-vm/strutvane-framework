/**
 * The facades whose subsystems arrive in Strutvane 0.3: `Mail`, `Queue`, `Bus`, `Notification`
 * and `Hash`. They exist now so the names are reserved and typed, and every member throws one
 * clear `BootError('facade_not_available')` instead of `undefined is not a function`.
 *
 * Each member returns `never`: code that calls one compiles, and the error says what to use
 * until 0.3.
 *
 * @module
 */
import { notAvailable } from './facade.ts'

/**
 * A facade that arrives later: every member is typed and throws `facade_not_available`.
 *
 * @example
 * const mail: ComingSoon<'send'> = Mail
 */
export type ComingSoon<TMembers extends string> = Readonly<
  Record<TMembers, (...args: readonly unknown[]) => never>
>

function member(
  facade: string,
  name: string,
  hint: string,
): (...args: readonly unknown[]) => never {
  return () => {
    throw notAvailable(facade, name, hint)
  }
}

function placeholder<TMembers extends string>(
  facade: string,
  members: readonly TMembers[],
  hint: string,
): ComingSoon<TMembers> {
  const out: Partial<Record<TMembers, (...args: readonly unknown[]) => never>> = {}
  for (const name of members) out[name] = member(facade, name, hint)
  return Object.freeze(out as Record<TMembers, (...args: readonly unknown[]) => never>)
}

/**
 * The `Mail` facade (arrives in 0.3). Every member throws `facade_not_available`.
 *
 * @example
 * Mail.to(user.email) // throws: Mail.to() is not available yet …
 */
export const Mail: ComingSoon<'to' | 'send' | 'queue' | 'raw' | 'fake'> = placeholder(
  'Mail',
  ['to', 'send', 'queue', 'raw', 'fake'],
  "Until 0.3, send mail with your provider's SDK (bound in a service provider) or an SMTP client.",
)

/**
 * The `Queue` facade (arrives in 0.3). Every member throws `facade_not_available`.
 *
 * @example
 * Queue.push(job) // throws: Queue.push() is not available yet …
 */
export const Queue: ComingSoon<'push' | 'later' | 'size' | 'fake'> = placeholder(
  'Queue',
  ['push', 'later', 'size', 'fake'],
  'Until 0.3, run the work inline, or after the response with defer(() => …).',
)

/**
 * The `Bus` facade (arrives in 0.3). Every member throws `facade_not_available`.
 *
 * @example
 * Bus.dispatch(job) // throws: Bus.dispatch() is not available yet …
 */
export const Bus: ComingSoon<'dispatch' | 'dispatchSync' | 'chain' | 'batch' | 'fake'> =
  placeholder(
    'Bus',
    ['dispatch', 'dispatchSync', 'chain', 'batch', 'fake'],
    "Until 0.3, call the job's handler directly, or after the response with defer(() => …).",
  )

/**
 * The `Notification` facade (arrives in 0.3). Every member throws `facade_not_available`.
 *
 * @example
 * Notification.send(users, new InvoicePaid(invoice)) // throws: Notification.send() is not available yet …
 */
export const Notification: ComingSoon<'send' | 'sendNow' | 'route' | 'fake'> = placeholder(
  'Notification',
  ['send', 'sendNow', 'route', 'fake'],
  'Until 0.3, emit a domain event (Event.emit) and send the message from a listener.',
)

/**
 * The `Hash` facade (arrives in 0.3, from `@strutvane/auth`). Every member throws
 * `facade_not_available`.
 *
 * @example
 * Hash.make(password) // throws: Hash.make() is not available yet …
 */
export const Hash: ComingSoon<'make' | 'check' | 'needsRehash'> = placeholder(
  'Hash',
  ['make', 'check', 'needsRehash'],
  "Password hashing belongs to @strutvane/auth (its Hash facade arrives in 0.3); until then let the auth package's identity adapter hash passwords, never a fast hash such as SHA-256.",
)
