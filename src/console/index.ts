/**
 * `@strutvane/framework/console`: the Strutvane command line, as a library.
 *
 * Most people run it as the `strutvane` bin of `@strutvane/framework` (`sv` in an app). The exports here
 * are for plugin authors (`defineCommand` and the command types), for tools that embed the CLI
 * (`runCli`, `main`), and for tools that want the same building blocks (the field mini-language,
 * the generators, the registry compiler).
 *
 * @packageDocumentation
 */
export { BUILTIN_COMMANDS } from './commands/builtins.ts'
export type { DoctorCheck } from './commands/doctor.ts'
export { type RouteRow, routeTable } from './commands/inspect.ts'
export type {
  AnyCommand,
  ArgDefinition,
  ArgMap,
  ArgValues,
  CommandContext,
  CommandDefinition,
  CommandOutcome,
  FlagDefinition,
  FlagMap,
  FlagValues,
  GlobalOptions,
  Project,
} from './framework/command.ts'
export { COMMAND_NAME, commandProblems, defineCommand } from './framework/command.ts'
export { CliError, type CliErrorOptions, type CliIssue, toFailure } from './framework/errors.ts'
export { EXIT, type ExitCode } from './framework/exit-codes.ts'
export { CLI_MESSAGES_EN } from './framework/messages.ts'
export type { Output, OutputStreams, Style } from './framework/output.ts'
export type { Prompter, SelectOption } from './framework/prompter.ts'
export { JSON_SCHEMA_VERSION, type JsonEnvelope, type RunOptions, runCli } from './framework/run.ts'
export type { CliServices, Spawner, SpawnOptions, SpawnResult } from './framework/services.ts'
export { main } from './main.ts'
export {
  FIELD_MODIFIERS,
  FIELD_TYPES,
  type FieldModifier,
  type FieldSpec,
  FieldSpecError,
  formatFieldSpec,
  parseFieldSpec,
  parseFieldSpecs,
} from './make/fields.ts'
export {
  factoryGenerator,
  migrationGenerator,
  modelGenerator,
  policyGenerator,
  resourceGenerator,
  seederGenerator,
  testGenerator,
} from './make/generators.ts'
export { satisfies } from './project/semver.ts'
export { compileProject, RegistryCompiler } from './registry/compiler.ts'
export { OUTPUT_FILE } from './registry/conventions.ts'
export { emitRegistry, verifyContentHash } from './registry/emit.ts'
export { type Diagnostic, formatDiagnostic } from './registry/errors.ts'
export type { Registry } from './registry/registry.ts'
export { watchProject } from './registry/watch.ts'
export { CLI_PACKAGE, CLI_VERSION } from './version.ts'
