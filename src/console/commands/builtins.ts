/**
 * The built-in command set.
 *
 * @module
 */
import type { AnyCommand } from '../framework/command.ts'
import { aboutCommand } from './about.ts'
import { APP_COMMANDS } from './app/index.ts'
import { doctorCommand } from './doctor.ts'
import { envCheckCommand, keyGenerateCommand } from './env.ts'
import { frameworkPlaceholders } from './framework.ts'
import { modelsCommand, permissionsCommand, routesCommand } from './inspect.ts'
import {
  makeFactoryCommand,
  makeMigrationCommand,
  makeModelCommand,
  makePolicyCommand,
  makeResourceCommand,
  makeSeederCommand,
  makeTestCommand,
} from './make.ts'
import { addCommand, removeCommand } from './packages.ts'
import { registryBuildCommand, registryWatchCommand } from './registry.ts'
import { upgradeCommand } from './upgrade.ts'

/** Every command the CLI ships with (contributed commands are merged in at runtime). */
export const BUILTIN_COMMANDS: readonly AnyCommand[] = [
  aboutCommand,
  doctorCommand,
  envCheckCommand,
  keyGenerateCommand,
  makeModelCommand,
  makeResourceCommand,
  makePolicyCommand,
  makeMigrationCommand,
  makeSeederCommand,
  makeFactoryCommand,
  makeTestCommand,
  registryBuildCommand,
  registryWatchCommand,
  routesCommand,
  modelsCommand,
  permissionsCommand,
  addCommand,
  removeCommand,
  upgradeCommand,
  ...APP_COMMANDS,
  ...frameworkPlaceholders,
]
