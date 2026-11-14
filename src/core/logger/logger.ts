/**
 * The default logger shipped by core (RFC-0004 §2): structured JSON lines, level filtering, child
 * bindings, request-context enrichment, redaction and control-character safety.
 *
 * It exists so every package can **always** log, even when `@strutvane/logs` isn't installed.
 * `@strutvane/logs` replaces it (same `Logger` contract) with files, retention and the viewer.
 *
 * Guarantees:
 * - **Never throws into the caller.** If the sink fails, one warning goes to stderr, the record is
 *   counted as dropped, and the app continues.
 * - **One call = one line.** `JSON.stringify` escapes CR/LF and control characters; U+2028/U+2029
 *   (line separators in some readers) are escaped too.
 * - **No secrets.** Sensitive keys are redacted at any depth before a line is built.
 *
 * @module
 */
import {
  LOG_LEVEL_SEVERITY,
  type LogError,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogRecord,
} from '../../contracts/index.ts'
import { type Clock, systemClock } from '../clock.ts'
import { currentContext, type RequestContext } from '../context.ts'
import {
  DEFAULT_SENSITIVE_KEYS,
  sensitiveKeyMatcher,
  serializeError,
  toLoggable,
} from './serialize.ts'

/** Receives one complete JSON line (without the trailing newline). */
export type LogSink = (line: string) => void

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Default `info`. */
  readonly level?: LogLevel
  /** Where lines go. Default: `process.stdout`. */
  readonly sink?: LogSink
  /** Fields added to every record (e.g. `{ service: 'api' }`). */
  readonly bindings?: LogFields
  readonly clock?: Clock
  /** Supplies request correlation. Default: core's AsyncLocalStorage context. */
  readonly context?: () => RequestContext | undefined
  /** Extra sensitive key fragments, added to the defaults. */
  readonly redactKeys?: readonly string[]
  /** Flushes an asynchronous sink, if it buffers. */
  readonly flush?: () => Promise<void>
  /** Upper bound for {@link Logger.flush}. Default 2000 ms. */
  readonly flushTimeoutMs?: number
  /** Where the one-time "sink failed" warning goes. Default: `process.stderr`. */
  readonly warn?: (message: string) => void
}

/** The core logger: the `Logger` contract plus a dropped-record counter. */
export interface CoreLogger extends Logger {
  /** Records that could not be written because the sink failed. */
  readonly dropped: number
  child(bindings: LogFields): CoreLogger
}

/** U+2028/U+2029 are valid in JSON but act as line breaks in some log readers: escape them. */
const LINE_SEPARATORS = new RegExp(
  `[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)
const escapeSeparator = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16)}`

interface SharedState {
  dropped: number
  warned: boolean
}

/**
 * Write errors on the process's own streams (EPIPE when the reader of a pipe goes away, EBADF on a
 * closed terminal) arrive as an asynchronous `error` event, not a thrown exception. With no
 * listener, Node turns that event into an uncaught exception and the whole app dies because its
 * log reader did. So the default sinks listen once per stream and remember the failure; the next
 * write throws it, which `write()` below turns into a dropped record and one warning.
 */
const streamFailures = new WeakMap<NodeJS.WriteStream, Error>()
const guarded = new WeakSet<NodeJS.WriteStream>()

function writeGuarded(stream: NodeJS.WriteStream, text: string): void {
  if (!guarded.has(stream)) {
    guarded.add(stream)
    stream.on('error', (error: Error) => {
      streamFailures.set(stream, error)
    })
  }
  const failure = streamFailures.get(stream)
  if (failure) throw failure
  stream.write(text)
}

const defaultSink: LogSink = (line) => {
  writeGuarded(process.stdout, `${line}\n`)
}

const defaultWarn = (message: string): void => {
  writeGuarded(process.stderr, `${message}\n`)
}

function extractError(fields: Record<string, unknown>): LogError | undefined {
  for (const key of ['err', 'error']) {
    const value = fields[key]
    if (value instanceof Error) {
      delete fields[key]
      return serializeError(value)
    }
  }
  return undefined
}

/** Create the default logger. */
export function createLogger(options: LoggerOptions = {}): CoreLogger {
  const minimum = LOG_LEVEL_SEVERITY[options.level ?? 'info']
  if (minimum === undefined) throw new RangeError(`Unknown log level "${String(options.level)}"`)
  const sink = options.sink ?? defaultSink
  const clock = options.clock ?? systemClock
  const context = options.context ?? currentContext
  const isSensitive = sensitiveKeyMatcher([
    ...DEFAULT_SENSITIVE_KEYS,
    ...(options.redactKeys ?? []),
  ])
  const warn = options.warn ?? defaultWarn
  const flushTimeoutMs = options.flushTimeoutMs ?? 2000
  const state: SharedState = { dropped: 0, warned: false }

  const make = (bindings: LogFields): CoreLogger => {
    const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
      try {
        if (LOG_LEVEL_SEVERITY[level] < minimum) return
        let ctx: RequestContext | undefined
        try {
          ctx = context()
        } catch {
          ctx = undefined
        }
        const merged: Record<string, unknown> = { ...bindings, ...fields }
        const err = extractError(merged)
        const safeFields = toLoggable(merged, isSensitive) as Record<string, unknown>
        const record: LogRecord = {
          time: new Date(clock.now()).toISOString(),
          level,
          msg: typeof msg === 'string' ? msg : String(msg),
          ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
          ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx?.tenant ? { tenantId: ctx.tenant.id } : {}),
          ...(ctx?.actor ? { actorId: ctx.actor.id } : {}),
          ...(Object.keys(safeFields).length > 0 ? { fields: safeFields } : {}),
          ...(err ? { err } : {}),
        }
        const line = JSON.stringify(record).replace(LINE_SEPARATORS, escapeSeparator)
        sink(line)
      } catch (error) {
        state.dropped++
        if (!state.warned) {
          state.warned = true
          try {
            warn(
              `[strutvane] logger sink failed; further records are dropped and counted (${error instanceof Error ? error.message : String(error)})`,
            )
          } catch {
            // Even the warning channel failed: there is nothing safe left to do but continue.
          }
        }
      }
    }

    return {
      get dropped() {
        return state.dropped
      },
      trace: (msg, fields) => write('trace', msg, fields),
      debug: (msg, fields) => write('debug', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      error: (msg, fields) => write('error', msg, fields),
      fatal: (msg, fields) => write('fatal', msg, fields),
      child: (extra) => make({ ...bindings, ...extra }),
      isLevelEnabled: (level) => (LOG_LEVEL_SEVERITY[level] ?? Number.POSITIVE_INFINITY) >= minimum,
      async flush() {
        if (!options.flush) return
        let timer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            options.flush().catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, flushTimeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
    }
  }

  return make(options.bindings ?? {})
}
