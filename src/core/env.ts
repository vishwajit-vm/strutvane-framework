/**
 * Environment-variable validation.
 *
 * **Why validate at boot?** A missing `DATABASE_URL` discovered on the first request (or worse, at
 * 3 a.m. when a rarely used code path runs) is an outage. Validating once at startup fails fast,
 * before the app accepts traffic.
 *
 * **Why one message with every problem?** Fixing env errors one restart at a time is slow and
 * frustrating. The error lists every missing or invalid key at once, with how to fix it.
 *
 * **Never prints values:** env values are often secrets, so error messages contain only key names
 * and the validator's description of what is wrong.
 *
 * Works with any Standard Schema validator (Zod, Valibot, ArkType, …).
 *
 * @module
 */
import type {
  InferOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
} from '@strutvane/contracts'
import { type DeepReadonly, deepFreeze } from './config.ts'

/** One problem with one environment variable. */
export interface EnvProblem {
  /** The variable name (or dotted path for nested schemas). Empty string = the whole env. */
  readonly key: string
  /** The validator's description of the problem. Never contains the value. */
  readonly message: string
}

/** Thrown when the environment doesn't match the schema. Lists every problem. */
export class EnvValidationError extends Error {
  readonly problems: readonly EnvProblem[]
  constructor(problems: readonly EnvProblem[]) {
    const lines = problems.map((p) => `  - ${p.key || '(root)'}: ${p.message}`)
    super(
      `Invalid environment: ${problems.length} problem(s)\n${lines.join('\n')}\n` +
        'Fix: set these keys in your .env file (see .env.example for every key and its meaning), then restart.',
    )
    this.name = 'EnvValidationError'
    this.problems = problems
  }
}

/** The environment source: by default `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>

function segmentKey(segment: PropertyKey | StandardSchemaV1PathSegment): string {
  const key = typeof segment === 'object' ? segment.key : segment
  return typeof key === 'symbol' ? key.toString() : String(key)
}

function toProblem(issue: StandardSchemaV1Issue): EnvProblem {
  const key = (issue.path ?? []).map(segmentKey).join('.')
  return { key, message: issue.message }
}

/**
 * Validate the environment once and return a deep-frozen, typed result.
 *
 * Synchronous on purpose: config is needed before anything else runs. An asynchronous validator
 * is rejected with a clear error instead of returning a Promise the caller might forget to await.
 *
 * @example
 * export const env = defineEnv(z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number().default(3000) }))
 */
export function defineEnv<S extends StandardSchemaV1>(
  schema: S,
  source: EnvSource = process.env,
): DeepReadonly<InferOutput<S>> {
  if (typeof schema !== 'object' || schema === null || !('~standard' in schema)) {
    throw new TypeError(
      'defineEnv(schema): schema must be a Standard Schema validator (e.g. a Zod schema)',
    )
  }
  // Pass a plain copy so the validator can't observe or mutate the live process.env.
  const result = schema['~standard'].validate({ ...source })
  if (result instanceof Promise) {
    // Don't leave the promise unhandled if it rejects later.
    result.catch(() => undefined)
    throw new TypeError('defineEnv(schema): asynchronous validators are not supported for env')
  }
  if (result.issues) {
    const problems = result.issues.map(toProblem)
    // Deterministic order makes the message stable and easy to scan.
    problems.sort((a, b) => a.key.localeCompare(b.key))
    throw new EnvValidationError(problems)
  }
  return deepFreeze(result.value as InferOutput<S>)
}
