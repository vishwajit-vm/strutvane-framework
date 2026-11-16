/**
 * The CLI's message catalog (RFC-0003 §2).
 *
 * Every user-facing error message and hint is looked up here by its stable code instead of being
 * written inline where the error is thrown. That keeps wording consistent across commands, lets
 * the docs list every message, and lets a later release add translations without touching command
 * code. Keys: `cli.error.<CODE>` for the message and `cli.hint.<CODE>` for the optional "how to
 * fix it" line. Placeholders use core's `{param}` syntax.
 *
 * @module
 */
import {
  createMessages,
  defineMessages,
  type MessageCatalog,
  type Messages,
} from '../../core/index.ts'

/** English messages for every CLI error code. */
export const CLI_MESSAGES_EN: MessageCatalog = defineMessages('en', {
  'cli.error.UNKNOWN_COMMAND': 'Unknown command "{name}".',
  'cli.hint.UNKNOWN_COMMAND': 'Run `sv help` to see every command.',
  'cli.error.AMBIGUOUS_COMMAND': '"{name}" matches several commands: {matches}.',
  'cli.hint.AMBIGUOUS_COMMAND': 'Type more of the command name.',
  'cli.error.UNKNOWN_FLAG': '{detail}',
  'cli.hint.UNKNOWN_FLAG': 'Run `sv help {command}` to see its flags.',
  'cli.error.INVALID_FLAG_VALUE': '{detail}',
  'cli.hint.INVALID_FLAG_VALUE': 'Run `sv help {command}` to see its flags.',
  'cli.error.INVALID_CHOICE': '--{flag} must be one of: {choices} (got "{value}").',
  'cli.error.MISSING_ARGUMENT': 'Missing required argument <{arg}>.',
  'cli.hint.MISSING_ARGUMENT': 'Usage: {usage}',
  'cli.error.TOO_MANY_ARGUMENTS': 'Unexpected argument "{value}".',
  'cli.hint.TOO_MANY_ARGUMENTS': 'Usage: {usage}',
  'cli.error.INVALID_ARGUMENT': '{detail}',
  'cli.error.INPUT_REQUIRED': '{detail} needs an answer, but prompting is disabled.',
  'cli.hint.INPUT_REQUIRED': 'Pass it on the command line, or use --yes to accept defaults.',
  'cli.error.PROJECT_NOT_FOUND': 'No Strutvane project found at or above {cwd}.',
  'cli.hint.PROJECT_NOT_FOUND':
    'Run this inside a project (a folder with strutvane.config.ts, or whose package.json lists @strutvane/framework), or pass --cwd <path>. Drive roots, the temp folder and folders above your home directory never count. On Linux and macOS the project folder must also be owned by the user running the command (in a container, build and run as the same user, e.g. node).',
  'cli.error.CWD_NOT_FOUND': 'The --cwd directory does not exist: {cwd}.',
  'cli.error.INVALID_PACKAGE_JSON': 'Could not read {path}: {detail}.',
  'cli.error.INVALID_FIELD': 'Invalid field "{spec}": {detail}',
  'cli.hint.INVALID_FIELD':
    'Field syntax: name:type[:modifier]…, arguments in [brackets] or (parentheses), e.g. status:enum[draft,paid]:default[draft]. On Windows use brackets: parentheses break inside the .cmd shims of npm and npx.',
  'cli.error.INVALID_NAME': '{detail}',
  'cli.error.MODEL_NOT_FOUND': 'Model "{model}" does not exist ({path} is missing).',
  'cli.hint.MODEL_NOT_FOUND': 'Create it first: sv make:model {model}',
  'cli.error.OWNED_FILE': '{path} is tracked in .strutvane/lock.json and is never overwritten.',
  'cli.hint.OWNED_FILE': 'Use `sv upgrade` to merge template changes into owned files.',
  'cli.error.FILE_EXISTS': '{detail}',
  'cli.hint.FILE_EXISTS':
    'Pass --force to overwrite generated files, or --dry-run --diff to compare.',
  'cli.error.REGISTRY_ERRORS':
    'The registry has {count, plural, one {# error} other {# errors}}; nothing was written.',
  'cli.hint.REGISTRY_ERRORS': 'Fix the files listed above, then run `sv registry:build` again.',
  'cli.error.REGISTRY_STALE': '{path} is out of date.',
  'cli.hint.REGISTRY_STALE': 'Run `sv registry:build` and commit the result.',
  'cli.error.ENV_PROBLEMS': '{count, plural, one {# env problem} other {# env problems}} found.',
  'cli.error.ENV_INVALID':
    'Invalid environment: {count, plural, one {# problem} other {# problems}}.',
  'cli.hint.ENV_INVALID':
    'Fix: set these keys in your .env file (see .env.example for every key and its meaning), then run the command again. `sv env:check` compares the two.',
  'cli.error.ENV_EXAMPLE_MISSING': '{path} does not exist, so there is nothing to compare with.',
  'cli.hint.ENV_EXAMPLE_MISSING': 'Create .env.example listing every variable the app reads.',
  'cli.error.KEY_EXISTS': 'APP_KEY is already set in {path}.',
  'cli.hint.KEY_EXISTS':
    'Pass --force to replace it. Replacing the key invalidates sessions and encrypted data.',
  'cli.error.DOCTOR_FAILED': '{count, plural, one {# check} other {# checks}} failed.',
  'cli.error.INVALID_PACKAGE_NAME': '"{name}" is not a valid npm package name.',
  'cli.hint.INVALID_PACKAGE_NAME':
    'Use a registry package name such as "auth" or "@strutvane/auth". Paths and URLs are refused.',
  'cli.error.PACKAGE_NOT_INSTALLED': '{name} is not installed in this project.',
  'cli.error.UNSAFE_CONTRIBUTION':
    '{name} declares strutvane.{key} = "{path}", which resolves outside its package in node_modules.',
  'cli.hint.UNSAFE_CONTRIBUTION': 'This is refused for safety. Report it to the package author.',
  'cli.error.INVALID_CONTRIBUTION': '{name}: strutvane.{key} is invalid: {detail}',
  'cli.error.INCOMPATIBLE_PACKAGE':
    '{name}@{version} requires Strutvane {range}, but this CLI is {cli}.',
  'cli.hint.INCOMPATIBLE_PACKAGE':
    'Upgrade both together (sv upgrade), or install a matching version.',
  'cli.error.MISSING_COMPAT':
    '{name}@{version} does not declare which Strutvane versions it supports (strutvane.compat), so it is not loaded.',
  'cli.hint.MISSING_COMPAT':
    'Ask the plugin author to add "strutvane": { "compat": "^0.1.0" } (the supported range) to its package.json.',
  'cli.error.INCOMPATIBLE_PLUGINS':
    'Unknown command "{name}". These plugins were refused as incompatible: {plugins}.',
  'cli.hint.INCOMPATIBLE_PLUGINS': 'Run `sv doctor` for details.',
  'cli.error.FRAMEWORK_REQUIRED': '`sv {command}` is provided by @strutvane/framework.',
  'cli.hint.FRAMEWORK_REQUIRED': 'Install it with: sv add framework',
  'cli.error.FRAMEWORK_COMMAND_MISSING':
    'The installed @strutvane/framework does not provide `sv {command}`.',
  'cli.hint.FRAMEWORK_COMMAND_MISSING':
    'Run `sv doctor` to see why its commands were not loaded (e.g. a version mismatch), then `sv upgrade`.',
  'cli.error.PRODUCTION_GUARD':
    '`sv {command}` is destructive and APP_ENV is {env}; it runs without confirmation only in local, test, testing or development.',
  'cli.hint.PRODUCTION_GUARD':
    'Set APP_ENV for this project, or pass --force --i-understand if you really mean it.',
  'cli.error.COMMAND_FAILED': '`{command}` failed with exit code {code}.',
  'cli.error.COMMAND_NOT_FOUND': 'Could not find `{command}` on PATH.',
  'cli.hint.COMMAND_NOT_FOUND':
    'Install it, or check PATH. Programs in the project folder itself are never run by name.',
  'cli.error.UNSAFE_ARGUMENT': 'Refusing to pass "{value}" to a shell.',
  'cli.error.TYPECHECK_FAILED': 'The project no longer type-checks after the upgrade.',
  'cli.hint.TYPECHECK_FAILED': 'Fix the errors above. Your files were upgraded; see git diff.',
  'cli.error.MERGE_CONFLICTS':
    'Upgrade wrote {count, plural, one {# file} other {# files}} with conflict markers: {files}.',
  'cli.hint.MERGE_CONFLICTS': 'Resolve the conflict markers, then run your tests.',
  'cli.error.INTERRUPTED': 'Interrupted.',
  'cli.error.VALIDATION_FAILED': 'Validation failed.',
  'cli.error.DEVKIT': '{detail}',
  'cli.hint.INTERRUPTED_TRANSACTION':
    'A previous run was interrupted. Run the command again; devkit recovers it first.',
  'cli.error.PORT_IN_USE': 'Port {port} on {host} is already in use.',
  'cli.hint.PORT_IN_USE':
    'Stop the other process, or choose another port: set APP_PORT in .env, or pass --port <number>.',
  'cli.error.PORT_ACCESS_DENIED': 'Not allowed to listen on {host}:{port}.',
  'cli.hint.PORT_ACCESS_DENIED':
    'Ports below 1024 usually need extra privileges: set a higher APP_PORT in .env, or pass --port <number>.',
  'cli.error.ADDRESS_NOT_AVAILABLE':
    'Cannot listen on {host}:{port}: this machine has no such address.',
  'cli.hint.ADDRESS_NOT_AVAILABLE':
    'Pass --host 127.0.0.1 (this machine only) or --host 0.0.0.0 (every interface).',
  'cli.error.PROJECT_INVALID': '{detail}',
  'cli.hint.PROJECT_INVALID': 'Fix the file named above, then run the command again.',
  'cli.error.BOOT_FAILED': '{detail}',
  'cli.hint.BOOT_FAILED':
    'A service the app needs at startup failed. Check that it is running and that its settings in .env and config/ are right.',
  'cli.error.BOOT_TIMEOUT': '{detail}',
  'cli.hint.BOOT_TIMEOUT':
    'Check that the database and other services in .env are reachable from this machine.',
  'cli.error.INTERNAL_ERROR': 'Unexpected error: {detail}',
  'cli.hint.INTERNAL_ERROR': 'Run again with --verbose for the stack trace, and report the bug.',
})

/** Create the resolver the CLI renders messages with (CLI catalog over core's built-ins). */
export function createCliMessages(): Messages {
  return createMessages({ package: [CLI_MESSAGES_EN] })
}
