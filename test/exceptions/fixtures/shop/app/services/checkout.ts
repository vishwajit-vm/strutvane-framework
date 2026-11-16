/**
 * App code that fails in the ways the exception tests need. Line numbers matter: the tests
 * assert the code frame points at the `throw` lines below.
 */
import { BootError } from '../../../../../../src/foundation/boot-error.ts'

/** Throws an error whose message is the given text (line 9). */
export function failWith(message: string): never {
  throw new Error(message)
}

/** Throws a developer mistake with a hint (line 14). */
export function misconfigured(): never {
  throw new BootError(
    'missing_gateway',
    'No payment gateway is configured.',
    'Set PAYMENT_GATEWAY in .env.',
  )
}

/** Throws a value that is not an Error. */
export function failWithValue(): never {
  throw 'a plain string'
}
