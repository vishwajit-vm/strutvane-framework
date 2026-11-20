/**
 * `@strutvane/framework/log`: Laravel-style logging, built into the framework (ADR-0022, keeping
 * ADR-0015's pipeline guarantees).
 *
 * ```ts
 * import { Log, logger, report } from '@strutvane/framework/log'
 *
 * Log.info('Invoice sent', { invoiceId: invoice.id })
 * Log.channel('payments').warning('Card declined', { orderId })
 * Log.stack(['daily', 'slack']).critical('Ledger out of balance')
 * Log.withContext({ orderId }) // every record of this request
 * logger('Cache warmed')       // debug, default channel
 * report(error)                // through the exception handler (dontReport, throttling) to the log
 * ```
 *
 * - **Channels** (`single`, `daily`, `stack`, `stderr`, `stdout`, `slack`, `null`, `custom`, and
 *   any name you give one) come from `config/logging.ts` and `.env` (`LOG_CHANNEL`, `LOG_STACK`,
 *   `LOG_LEVEL`, `LOG_DAILY_DAYS`, `LOG_FORMAT`, `LOG_MAX_FILE_SIZE`, `LOG_PATH`,
 *   `LOG_SLACK_WEBHOOK_URL`, `LOG_DEPRECATIONS_CHANNEL`).
 * - **Files** live in `storage/logs/`: `strutvane.log`, `strutvane-YYYY-MM-DD.log`, one file per
 *   additional process (`…worker-2.log`), a new part when the size cap is reached (`…-2.log`).
 * - **Always on:** redaction (keys and secret patterns), one record per line (newlines, ANSI and
 *   bidirectional controls escaped), a bounded queue that drops debug before errors, a stderr
 *   fallback, and a bounded flush when the app shuts down.
 * - **Commands:** `node strut log:tail`, `log:list`, `log:clear`.
 *
 * The building blocks below (file naming and ordering, parsing both formats, reading files) are
 * exported for the log viewer (`@strutvane/log-viewer`) and other tools that read log files.
 *
 * @module
 */
export type { LogError, LogFields, Logger, LogRecord } from '../contracts/logger.ts'
export { report } from '../exceptions/report.ts'
export {
  Log,
  type LogChannel,
  type LogFacade,
  type LogFacadeMethod,
  logger,
} from '../facades/log.ts'
export {
  type AppLogManagerOptions,
  appLoggingConfig,
  createAppLogManager,
} from './app.ts'
export {
  type ClearLogsOptions,
  type ClearLogsResult,
  ClearNotConfirmedError,
  clearLogs,
  formatLogList,
  humanSize,
  type ListedFile,
  type LogListing,
  listLogs,
} from './commands/list.ts'
export { type LogSource, LogSourceError, sourcesFor } from './commands/sources.ts'
export {
  formatTailEntry,
  matchesTail,
  mergeByTime,
  parseSince,
  type TailEntry,
  type TailFilter,
  type TailLogsOptions,
  tailLogs,
} from './commands/tail.ts'
export {
  BUILT_IN_CHANNELS,
  type BuiltInChannel,
  type ChannelConfig,
  type ChannelName,
  type CustomChannelConfig,
  type CustomChannelContext,
  DRIVERS,
  type Driver,
  defineLoggingConfig,
  type Env,
  type FileChannelConfig,
  type LoggingConfig,
  LoggingConfigError,
  type LoggingConfigResult,
  type LoggingIssue,
  logDirectory,
  MIN_FILE_BYTES,
  type NullChannelConfig,
  parseSize,
  type ResolvedChannel,
  type ResolvedFileChannel,
  type ResolvedLoggingConfig,
  type ResolveOptions,
  resolveChannelConfig,
  resolveLoggingConfig,
  resolveLogPath,
  type SlackChannelConfig,
  type StackChannelConfig,
  type StreamChannelConfig,
} from './config.ts'
export {
  addToLogContext,
  type ContextGetter,
  getLogContext,
  type LogContext,
  removeFromLogContext,
  requestIds,
  runWithLogContext,
} from './context.ts'
export {
  applyRetention,
  type ClearOptions,
  type ClearResult,
  clearLogFiles,
  compareLogFiles,
  DEFAULT_BASES,
  DEFAULT_LOG_BASE,
  dayKeyOf,
  fileDay,
  isDayKey,
  isLogBaseName,
  isWorkerId,
  LOG_FILE_PATTERN,
  type LogFileKind,
  type LogFileName,
  type LogFileNameParts,
  listLogFiles,
  logFileName,
  newestPerStream,
  parseLogFileName,
  type RetentionOptions,
  shiftDay,
  streamKey,
} from './files.ts'
export {
  createFormatter,
  type Formatter,
  isLogFormat,
  LOG_FORMATS,
  type LogFormat,
} from './format/formatter.ts'
export {
  envLabel,
  escapeMessage,
  formatLine,
  LINE_RESERVED_KEYS,
  unescapeMessage,
} from './format/line.ts'
export { type ParsedRecord, parseLogLine } from './format/parse.ts'
export {
  IMPORTANT_PRIORITY,
  isLevel,
  isLevelName,
  LEVEL_ALIASES,
  LEVEL_PRIORITY,
  LEVELS,
  type Level,
  type LevelAlias,
  type LevelName,
  priorityOf,
  RFC5424_CODE,
  toLevel,
} from './levels.ts'
export {
  createEmitter,
  createPipelineLogger,
  type EmitterOptions,
  type FlushResult,
  type LevelMethods,
  type LoggerStats,
  type LogMethod,
  type PipelineOptions,
  type StrutvaneLogger,
} from './logger.ts'
export {
  automaticWorkerId,
  createLogManager,
  type LogManager,
  type LogManagerOptions,
} from './manager.ts'
export { checkWebhookUrl, postWebhook, type WebhookPostOptions } from './net/webhook.ts'
export { createNoopLogger } from './noop.ts'
export {
  BoundedQueue,
  DEFAULT_QUEUE_LIMITS,
  type PushResult,
  type QueueItem,
  type QueueLimits,
} from './queue.ts'
export {
  describeFiles,
  type FileLine,
  type LogFileInfo,
  readLinesBackward,
  readRange,
} from './read.ts'
export {
  createSanitizer,
  DEFAULT_SANITIZE,
  looksLikeCardNumber,
  luhnValid,
  normaliseKey,
  type PatternRule,
  REDACTED,
  redactString,
  registerSensitiveKeys,
  type SanitizeOptions,
  type Sanitizer,
} from './redact.ts'
export {
  DEFAULT_MAX_RECORD_BYTES,
  escapeLineSeparators,
  MIN_RECORD_BYTES,
  type SerializableRecord,
  serializeRecord,
} from './serialize.ts'
export { registerShutdownFlush, type ShutdownOptions } from './shutdown.ts'
export { createSink, type Sink, type SinkOptions } from './sink.ts'
export { LogManagerToken } from './token.ts'
export { stderrTransport, stdoutTransport, streamTransport } from './transports/console.ts'
export {
  appendFileWriter,
  DEFAULT_MAX_FILE_BYTES,
  type FileTransport,
  type FileTransportOptions,
  fileTransport,
} from './transports/file.ts'
export {
  type SlackTransportOptions,
  slackEscape,
  slackTransport,
  type WebhookPost,
} from './transports/slack.ts'
export type {
  Batch,
  FileWriter,
  FileWriterFactory,
  Transport,
  WritableLike,
} from './transports/types.ts'
