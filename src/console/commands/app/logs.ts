/**
 * `node strut log:tail`, `log:list` and `log:clear` (ADR-0022 §8): the log files of the app's
 * file channels (`single` and `daily`), as `config/logging.ts` and `.env` describe them.
 *
 * ```
 * node strut log:tail [--level=warning] [--channel=payments] [--grep=text] [--since=15m] [-n 50] [--no-follow]
 * node strut log:list [--channel=payments]
 * node strut log:clear [--days=N] [--channel=payments] [--force]
 * ```
 *
 * Why they read the config without booting the app: logs are what you read when the app is
 * broken. The commands load `bootstrap/app.ts` and resolve `config/logging.ts` against `.env`
 * (`app.loggingConfig()`), but never run providers, connect to a database or compile routes.
 *
 * Safety:
 * - only files whose names a configured file channel writes are read or deleted, never other
 *   `*.log` files that share the directory;
 * - `log:clear` never deletes a file a running process is still writing, and asks first (in a
 *   terminal), unless `--force` or `--yes` is given; without a terminal it refuses;
 * - every printed record is re-sanitised and escaped, so a hostile record can't forge lines or
 *   send terminal escape codes (`formatTailEntry`).
 *
 * @module
 */

import { clearLogs, formatLogList, listLogs } from '../../../logging/commands/list.ts'
import { type LogSource, LogSourceError, sourcesFor } from '../../../logging/commands/sources.ts'
import {
  formatTailEntry,
  parseSince,
  type TailEntry,
  tailLogs,
} from '../../../logging/commands/tail.ts'
import { LEVELS, toLevel } from '../../../logging/levels.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import { type AppCommandDeps, appRoot, commandError, defineAppCommand } from './support.ts'

/** The `--channel` flag every log command takes. */
const CHANNEL_FLAG = {
  channel: {
    type: 'string',
    description: 'Only the files of this channel (a stack: all of its file channels)',
    valueName: 'name',
  },
} as const

/** The file sources of the app's channels (or of one channel), without booting the app. */
async function sources(
  ctx: Parameters<typeof appRoot>[0],
  deps: AppCommandDeps,
  channel: string | undefined,
): Promise<LogSource[]> {
  const app = await deps.load(appRoot(ctx))
  const { config } = app.loggingConfig()
  try {
    return sourcesFor(config, channel)
  } catch (error) {
    if (error instanceof LogSourceError)
      throw commandError(
        'unknown_log_channel',
        error.message,
        'Pass a single or daily channel from config/logging.ts, or leave out --channel.',
        EXIT.USAGE,
      )
    throw error
  }
}

function wholeNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d{1,6}$/.test(value))
    throw commandError(
      'invalid_number',
      `--${flag}="${value.slice(0, 40)}" is not a whole number.`,
      `Pass --${flag}=7 (0 to 999999).`,
      EXIT.USAGE,
    )
  return Number(value)
}

/**
 * The `log:tail`, `log:list` and `log:clear` commands.
 *
 * @example
 * logCommands(DEFAULT_APP_DEPS).map((command) => command.name) // ['log:tail', 'log:list', 'log:clear']
 */
export function logCommands(deps: AppCommandDeps): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'log:tail',
      description: 'Show the latest log records, then follow new ones (Ctrl+C stops)',
      details:
        'Reads the files of the file channels (single, daily) in config/logging.ts, merged across processes by timestamp. With --json it prints the latest records and exits.',
      requiresProject: false,
      flags: {
        level: {
          type: 'string',
          description: `Only this level and above (${LEVELS.join(', ')}; warn, fatal and trace work too)`,
          valueName: 'level',
        },
        ...CHANNEL_FLAG,
        grep: {
          type: 'string',
          description: 'Only records containing this text (case-insensitive)',
          valueName: 'text',
        },
        since: {
          type: 'string',
          description: 'Only records since a duration ago (30s, 15m, 2h, 7d) or a date/time',
          valueName: 'when',
        },
        lines: {
          type: 'string',
          short: 'n',
          description: 'Records to show first (default 20)',
          valueName: 'n',
        },
        follow: {
          type: 'boolean',
          short: 'f',
          default: true,
          description: 'Keep showing new records until Ctrl+C (--no-follow: print and exit)',
        },
      },
      examples: [
        'node strut log:tail',
        'node strut log:tail --level=error --since=1h --no-follow',
        'node strut log:tail --channel=payments --grep="card declined"',
      ],
      async run(ctx) {
        const since = ctx.flags.since === undefined ? undefined : parseSince(ctx.flags.since)
        if (ctx.flags.since !== undefined && since === undefined)
          throw commandError(
            'invalid_since',
            `--since="${ctx.flags.since.slice(0, 40)}" is not a duration or a date.`,
            'Use 30s, 15m, 2h or 7d, or a date such as 2026-11-15 or 2026-11-15T10:00:00Z.',
            EXIT.USAGE,
          )
        const level = ctx.flags.level === undefined ? undefined : toLevel(ctx.flags.level)
        if (ctx.flags.level !== undefined && level === undefined)
          throw commandError(
            'invalid_level',
            `"${ctx.flags.level.slice(0, 40)}" is not a log level.`,
            `Use one of ${LEVELS.join(', ')}.`,
            EXIT.USAGE,
          )
        const found = await sources(ctx, deps, ctx.flags.channel)
        // --json prints one envelope, so it can't follow forever.
        const follow = ctx.flags.follow && !ctx.out.json
        const printed: TailEntry['record'][] = []
        const entries = tailLogs({
          sources: found,
          lines: wholeNumber(ctx.flags.lines, 'lines', 20),
          follow,
          signal: ctx.services.signal,
          ...(level === undefined ? {} : { level }),
          ...(ctx.flags.grep === undefined ? {} : { text: ctx.flags.grep }),
          ...(since === undefined ? {} : { since }),
        })
        for await (const entry of entries) {
          ctx.out.line(formatTailEntry(entry))
          if (ctx.out.json) printed.push(entry.record)
        }
        return { data: { records: printed } }
      },
    }),
    defineAppCommand({
      name: 'log:list',
      description: 'List the log files with their sizes and days',
      requiresProject: false,
      flags: CHANNEL_FLAG,
      examples: ['node strut log:list', 'node strut log:list --channel=payments'],
      async run(ctx) {
        const listing = await listLogs(await sources(ctx, deps, ctx.flags.channel))
        for (const line of formatLogList(listing)) ctx.out.line(line)
        return { data: listing }
      },
    }),
    defineAppCommand({
      name: 'log:clear',
      description: 'Delete log files (never a file a running process is writing)',
      details:
        "Keeps the last --days days when given (today included). Deleting can't be undone: it asks first, or needs --force (or --yes) without a terminal.",
      requiresProject: false,
      flags: {
        days: {
          type: 'string',
          description: 'Keep the last N days (default: clear every day)',
          valueName: 'n',
        },
        ...CHANNEL_FLAG,
      },
      examples: [
        'node strut log:clear',
        'node strut log:clear --days=7',
        'node strut log:clear --channel=payments --force',
      ],
      async run(ctx) {
        const days = wholeNumber(ctx.flags.days, 'days', 0)
        const found = await sources(ctx, deps, ctx.flags.channel)
        if (!ctx.globals.force) {
          const what = `${ctx.flags.channel === undefined ? 'the log files' : `the "${ctx.flags.channel}" log files`}${days > 0 ? ` older than the last ${days} day(s)` : ''}`
          const yes = await ctx.prompt.confirm(
            `Delete ${what}? Files still being written are kept.`,
          )
          if (!yes) {
            ctx.out.line('Cancelled; nothing was deleted.')
            return { exitCode: EXIT.FAILURE, data: { deleted: [], live: [], cancelled: true } }
          }
        }
        const result = await clearLogs(found, { confirm: true, days })
        ctx.out.success(
          `Deleted ${result.deleted.length} file(s).${result.live.length > 0 ? ` Kept ${result.live.length} file(s) still being written: ${result.live.join(', ')}.` : ''}`,
        )
        return { data: result }
      },
    }),
  ]
}
