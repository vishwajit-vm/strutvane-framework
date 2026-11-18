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
  'cli.error.unknown_command': 'Unknown command "{name}".',
  'cli.hint.unknown_command': 'Run `node strut help` to see every command.',
  'cli.error.ambiguous_command': '"{name}" matches several commands: {matches}.',
  'cli.hint.ambiguous_command': 'Type more of the command name.',
  'cli.error.unknown_flag': '{detail}',
  'cli.hint.unknown_flag': 'Run `node strut help {command}` to see its flags.',
  'cli.error.invalid_flag_value': '{detail}',
  'cli.hint.invalid_flag_value': 'Run `node strut help {command}` to see its flags.',
  'cli.error.invalid_choice': '--{flag} must be one of: {choices} (got "{value}").',
  'cli.error.missing_argument': 'Missing required argument <{arg}>.',
  'cli.hint.missing_argument': 'Usage: {usage}',
  'cli.error.too_many_arguments': 'Unexpected argument "{value}".',
  'cli.hint.too_many_arguments': 'Usage: {usage}',
  'cli.error.invalid_argument': '{detail}',
  'cli.error.input_required': '{detail} needs an answer, but prompting is disabled.',
  'cli.hint.input_required': 'Pass it on the command line, or use --yes to accept defaults.',
  'cli.error.project_not_found': 'No Strutvane project found at or above {cwd}.',
  'cli.hint.project_not_found':
    'Run this inside a project (a folder with strutvane.config.ts, or whose package.json lists @strutvane/framework), or pass --cwd <path>. Drive roots, the temp folder and folders above your home directory never count. On Linux and macOS the project folder must also be owned by the user running the command (in a container, build and run as the same user, e.g. node).',
  'cli.error.cwd_not_found': 'The --cwd directory does not exist: {cwd}.',
  'cli.error.invalid_package_json': 'Could not read {path}: {detail}.',
  'cli.error.invalid_field': 'Invalid field "{spec}": {detail}',
  'cli.hint.invalid_field':
    'Field syntax: name:type[:modifier]…, arguments in [brackets] or (parentheses), e.g. status:enum[draft,paid]:default[draft]. On Windows use brackets: parentheses break inside the .cmd shims of npm and npx.',
  'cli.error.invalid_name': '{detail}',
  'cli.error.model_not_found': 'Model "{model}" does not exist ({path} is missing).',
  'cli.hint.model_not_found': 'Create it first: node strut make:model {model}',
  'cli.error.owned_file': '{path} is tracked in .strutvane/lock.json and is never overwritten.',
  'cli.hint.owned_file': 'Use `node strut upgrade` to merge template changes into owned files.',
  'cli.error.file_exists': '{detail}',
  'cli.hint.file_exists':
    'Pass --force to overwrite generated files, or --dry-run --diff to compare.',
  'cli.error.registry_errors':
    'The registry has {count, plural, one {# error} other {# errors}}; nothing was written.',
  'cli.hint.registry_errors':
    'Fix the files listed above, then run `node strut registry:build` again.',
  'cli.error.registry_stale': '{path} is out of date.',
  'cli.hint.registry_stale': 'Run `node strut registry:build` and commit the result.',
  'cli.error.env_problems': '{count, plural, one {# env problem} other {# env problems}} found.',
  'cli.error.env_invalid':
    'Invalid environment: {count, plural, one {# problem} other {# problems}}.',
  'cli.hint.env_invalid':
    'Fix: set these keys in your .env file (see .env.example for every key and its meaning), then run the command again. `node strut env:check` compares the two.',
  'cli.error.env_example_missing': '{path} does not exist, so there is nothing to compare with.',
  'cli.hint.env_example_missing': 'Create .env.example listing every variable the app reads.',
  'cli.error.key_exists': 'APP_KEY is already set in {path}.',
  'cli.hint.key_exists':
    'Pass --force to replace it. Replacing the key invalidates sessions and encrypted data.',
  'cli.error.doctor_failed': '{count, plural, one {# check} other {# checks}} failed.',
  'cli.error.invalid_package_name': '"{name}" is not a valid npm package name.',
  'cli.hint.invalid_package_name':
    'Use a registry package name such as "auth" or "@strutvane/auth". Paths and URLs are refused.',
  'cli.error.package_not_installed': '{name} is not installed in this project.',
  'cli.error.unsafe_contribution':
    '{name} declares strutvane.{key} = "{path}", which resolves outside its package in node_modules.',
  'cli.hint.unsafe_contribution': 'This is refused for safety. Report it to the package author.',
  'cli.error.invalid_contribution': '{name}: strutvane.{key} is invalid: {detail}',
  'cli.error.incompatible_package':
    '{name}@{version} requires Strutvane {range}, but this CLI is {cli}.',
  'cli.hint.incompatible_package':
    'Upgrade both together (node strut upgrade), or install a matching version.',
  'cli.error.missing_compat':
    '{name}@{version} does not declare which Strutvane versions it supports (strutvane.compat), so it is not loaded.',
  'cli.hint.missing_compat':
    'Ask the plugin author to add "strutvane": { "compat": "{suggested}" } (the supported range) to its package.json.',
  'cli.error.incompatible_plugins':
    'Unknown command "{name}". These plugins were refused as incompatible: {plugins}.',
  'cli.hint.incompatible_plugins': 'Run `node strut doctor` for details.',
  'cli.error.framework_required': '`node strut {command}` is provided by @strutvane/framework.',
  'cli.hint.framework_required': 'Install it with: node strut add framework',
  'cli.error.framework_command_missing':
    'The installed @strutvane/framework does not provide `node strut {command}`.',
  'cli.hint.framework_command_missing':
    'Run `node strut doctor` to see why its commands were not loaded (e.g. a version mismatch), then `node strut upgrade`.',
  'cli.error.production_guard':
    '`node strut {command}` is destructive and APP_ENV is {env}; it runs without confirmation only in local, test, testing or development.',
  'cli.hint.production_guard':
    'Set APP_ENV for this project, or pass --force --i-understand if you really mean it.',
  'cli.error.command_failed': '`{command}` failed with exit code {code}.',
  'cli.error.command_not_found': 'Could not find `{command}` on PATH.',
  'cli.hint.command_not_found':
    'Install it, or check PATH. Programs in the project folder itself are never run by name.',
  'cli.error.unsafe_argument': 'Refusing to pass "{value}" to a shell.',
  'cli.error.typecheck_failed': 'The project no longer type-checks after the upgrade.',
  'cli.hint.typecheck_failed': 'Fix the errors above. Your files were upgraded; see git diff.',
  'cli.error.merge_conflicts':
    'Upgrade wrote {count, plural, one {# file} other {# files}} with conflict markers: {files}.',
  'cli.hint.merge_conflicts': 'Resolve the conflict markers, then run your tests.',
  'cli.error.interrupted': 'Interrupted.',
  'cli.error.validation_failed': 'Validation failed.',
  'cli.error.devkit': '{detail}',
  'cli.hint.interrupted_transaction':
    'A previous run was interrupted. Run the command again; devkit recovers it first.',
  'cli.error.port_in_use': 'Port {port} on {host} is already in use.',
  'cli.hint.port_in_use':
    'Stop the other process, or choose another port: set APP_PORT in .env, or pass --port <number>.',
  'cli.error.port_access_denied': 'Not allowed to listen on {host}:{port}.',
  'cli.hint.port_access_denied':
    'Ports below 1024 usually need extra privileges: set a higher APP_PORT in .env, or pass --port <number>.',
  'cli.error.address_not_available':
    'Cannot listen on {host}:{port}: this machine has no such address.',
  'cli.hint.address_not_available':
    'Pass --host 127.0.0.1 (this machine only) or --host 0.0.0.0 (every interface).',
  'cli.error.project_invalid': '{detail}',
  'cli.hint.project_invalid': 'Fix the file named above, then run the command again.',
  'cli.error.boot_failed': '{detail}',
  'cli.hint.boot_failed':
    'A service the app needs at startup failed. Check that it is running and that its settings in .env and config/ are right.',
  'cli.error.boot_timeout': '{detail}',
  'cli.hint.boot_timeout':
    'Check that the database and other services in .env are reachable from this machine.',
  'cli.error.internal_error': 'Unexpected error: {detail}',
  'cli.hint.internal_error': 'Run again with --verbose for the stack trace, and report the bug.',
})

/** Create the resolver the CLI renders messages with (CLI catalog over core's built-ins). */
export function createCliMessages(): Messages {
  return createMessages({ package: [CLI_MESSAGES_EN] })
}
