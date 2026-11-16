/**
 * `@strutvane/framework/core`: the Strutvane kernel.
 *
 * A typed container, service providers and the application lifecycle, plus:
 * - validated config and env
 * - request context
 * - hooks and events
 * - the RFC-0003 error model and message catalogs
 * - a default logger
 * - clock and UUIDv7 ids
 *
 * Depends only on the contracts (`@strutvane/framework/contracts`).
 *
 * @packageDocumentation
 */
export {
  type AppConfigPath,
  type AppConfigValue,
  type Application,
  type AppState,
  type CreateAppOptions,
  createApp,
  defineProvider,
  type Provider,
  ProviderError,
  type ShutdownReport,
} from './application.ts'
export { type Clock, createTestClock, isoNow, systemClock, type TestClock } from './clock.ts'
export {
  type ConfigPath,
  type ConfigValue,
  type DeepReadonly,
  deepFreeze,
  defineConfig,
  getConfigValue,
} from './config.ts'
export {
  type Container,
  ContainerError,
  type ContainerErrorCode,
  createContainer,
  type Disposer,
  type Factory,
  type LifetimeOptions,
  type Resolver,
  type Token,
  token,
} from './container.ts'
export { currentContext, type RequestContext, runWithContext } from './context.ts'
export { defineEnv, type EnvProblem, type EnvSource, EnvValidationError } from './env.ts'
export {
  ConflictError,
  DomainError,
  type ErrorParams,
  ForbiddenError,
  type IssueInput,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  StrutvaneError,
  type StrutvaneErrorOptions,
  UnauthenticatedError,
  ValidationError,
} from './errors/errors.ts'
export {
  fieldErrorsFrom,
  humanize,
  issuePathKey,
  renderIssues,
  type ToProblemOptions,
  toProblem,
} from './errors/problem.ts'
export {
  BUILTIN_ERRORS,
  createErrorRegistry,
  type ErrorDefinition,
  type ErrorRegistry,
} from './errors/registry.ts'
export {
  createEventBus,
  type EmitOptions,
  type EmitResult,
  type EventBus,
  type EventBusOptions,
  type EventListener,
} from './events.ts'
export {
  createHooks,
  type HookControl,
  HookError,
  type HookHandler,
  type HookOptions,
  type HookRegistry,
} from './hooks.ts'
export { type CoreLogger, createLogger, type LoggerOptions, type LogSink } from './logger/logger.ts'
export {
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_SENSITIVE_WORDS,
  normalizeSensitiveKey,
  REDACTED,
  registerSensitiveKeys,
  type SensitiveKeyMatcherOptions,
  sensitiveKeyMatcher,
  serializeError,
  toLoggable,
} from './logger/serialize.ts'
export { BUILTIN_EN } from './messages/builtin-en.ts'
export {
  createMessages,
  defineMessages,
  type LocalizedMessages,
  type MessageCatalog,
  type MessageDictionary,
  type MessageLayer,
  type MessageLookup,
  type MessageOverrides,
  type Messages,
  type MessagesOptions,
} from './messages/catalog.ts'
export { type FormatResult, formatMessage, type MessageParam } from './messages/format.ts'
export { baseLanguage, canonicalLocale, localeChain, negotiateLocale } from './messages/locale.ts'
export { detectPackageManager, installCommand, type PackageManager } from './package-manager.ts'
export {
  ClockToken,
  ErrorRegistryToken,
  EventBusToken,
  HooksToken,
  IdGeneratorToken,
  LoggerToken,
  MessagesToken,
  PermissionProviderToken,
} from './tokens.ts'
export {
  createUuidV7Generator,
  isUuidV7,
  type RandomSource,
  type UuidGenerator,
  uuidV7Timestamp,
  uuidv7,
} from './uuid.ts'
