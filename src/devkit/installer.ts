/**
 * The installer runtime behind `node strut add <package>` / `node strut remove <package>` (docs/04 §7).
 *
 * `runInstaller` gives an installer a context whose `fs`, `env`, `deps` and `config` all write to
 * ONE staged file system. That makes every installer:
 * - **transactional:** if the installer throws, nothing is written; if it succeeds, all its
 *   changes are committed together (or rolled back together on an I/O failure),
 * - **previewable:** `dryRun: true` returns the diff and writes nothing,
 * - **idempotency-checkable:** {@link checkIdempotent} runs it twice and reports anything the
 *   second run would still change.
 *
 * @module
 */
import type { InstallContext, Installer, InstallLogger } from '../contracts/index.ts'
import { type ConfigPatcher, createConfigPatcher } from './config-patcher.ts'
import { createDepsEditor, type DepsEditor } from './deps-editor.ts'
import { createEnvEditor, type EnvEditor } from './env-editor.ts'
import { DevkitError, describeError } from './errors.ts'
import type { DevkitIo } from './io.ts'
import { createStagedFs, type FileChange, type StagedFs } from './staged-fs.ts'

/**
 * The context devkit hands to installers: the contracts' `InstallContext`, with editors that also
 * support removal (for `uninstall`).
 */
export interface DevkitInstallContext extends InstallContext {
  readonly fs: StagedFs
  readonly env: EnvEditor
  readonly deps: DepsEditor
  readonly config: ConfigPatcher
}

/** An installer written against devkit (its hooks receive the richer context). */
export interface DevkitInstaller extends Installer {
  install(context: DevkitInstallContext): Promise<void>
  uninstall?(context: DevkitInstallContext): Promise<void>
}

/** A message an installer logged. */
export interface LogMessage {
  readonly level: 'info' | 'warn'
  readonly message: string
}

/** Options for {@link runInstaller}. */
export interface RunInstallerOptions {
  readonly projectRoot: string
  /** Answers to the installer's prompts (or flags). Default `{}`. */
  readonly answers?: Readonly<Record<string, unknown>>
  /** Preview only: compute changes and a diff, write nothing. Default `false`. */
  readonly dryRun?: boolean
  /** Packages already installed in the project (drives `context.has()`). */
  readonly installedPackages?: readonly string[]
  /** `install` (default) or `uninstall`. */
  readonly mode?: 'install' | 'uninstall'
  /** Receives log messages as they happen (they are also returned). */
  readonly logger?: InstallLogger
  /** File-system implementation (tests inject failures). */
  readonly io?: DevkitIo
}

/** What an installer run did (or would do, for a dry run). */
export interface InstallResult {
  readonly installer: string
  readonly mode: 'install' | 'uninstall'
  readonly dryRun: boolean
  readonly committed: boolean
  readonly changes: readonly FileChange[]
  /** Unified diff of the changes (empty when nothing changes). */
  readonly diff: string
  readonly messages: readonly LogMessage[]
}

const NAME = /^[a-z][a-z0-9-]*$/

/**
 * Declare an installer. Validates its shape early, so a broken installer fails when its package
 * loads, not halfway through a user's `node strut add`.
 */
export function defineInstaller<T extends DevkitInstaller>(installer: T): T {
  if (typeof installer !== 'object' || installer === null) {
    throw new DevkitError('invalid_installer', 'an installer must be an object')
  }
  if (typeof installer.name !== 'string' || !NAME.test(installer.name)) {
    throw new DevkitError(
      'invalid_installer',
      `installer name "${String(installer.name)}" must be lowercase kebab-case`,
    )
  }
  if (typeof installer.install !== 'function') {
    throw new DevkitError(
      'invalid_installer',
      `installer "${installer.name}" needs an install() function`,
    )
  }
  if (installer.uninstall !== undefined && typeof installer.uninstall !== 'function') {
    throw new DevkitError(
      'invalid_installer',
      `installer "${installer.name}": uninstall must be a function`,
    )
  }
  if (
    installer.enhances !== undefined &&
    (!Array.isArray(installer.enhances) || installer.enhances.some((e) => typeof e !== 'string'))
  ) {
    throw new DevkitError(
      'invalid_installer',
      `installer "${installer.name}": enhances must be a list of package names`,
    )
  }
  return Object.freeze(installer)
}

/** Run an installer (or uninstaller) against a project. */
export async function runInstaller(
  installer: DevkitInstaller,
  options: RunInstallerOptions,
): Promise<InstallResult> {
  const mode = options.mode ?? 'install'
  const dryRun = options.dryRun ?? false
  const messages: LogMessage[] = []
  const log: InstallLogger = {
    info(message) {
      messages.push({ level: 'info', message })
      options.logger?.info(message)
    },
    warn(message) {
      messages.push({ level: 'warn', message })
      options.logger?.warn(message)
    },
  }
  const fs = createStagedFs(options.projectRoot, options.io === undefined ? {} : { io: options.io })
  const installed = new Set(options.installedPackages ?? [])
  const context: DevkitInstallContext = {
    projectRoot: options.projectRoot,
    answers: options.answers ?? {},
    dryRun,
    has: (name) => installed.has(name),
    fs,
    env: createEnvEditor(fs),
    deps: createDepsEditor(fs),
    config: createConfigPatcher(fs),
    log,
  }

  const hook = mode === 'install' ? installer.install : installer.uninstall
  if (hook === undefined) {
    throw new DevkitError(
      'uninstall_not_supported',
      `installer "${installer.name}" has no uninstall()`,
    )
  }
  try {
    await hook.call(installer, context)
  } catch (error) {
    fs.discard()
    if (error instanceof DevkitError) throw error
    throw new DevkitError(
      'installer_failed',
      `installer "${installer.name}" failed during ${mode} (nothing was changed): ${describeError(error)}`,
      { cause: error },
    )
  }

  const changes = await fs.changes()
  const diff = await fs.diff()
  if (dryRun) {
    fs.discard()
    return { installer: installer.name, mode, dryRun, committed: false, changes, diff, messages }
  }
  await fs.commit()
  return {
    installer: installer.name,
    mode,
    dryRun,
    committed: changes.length > 0,
    changes,
    diff,
    messages,
  }
}

/**
 * Check that an installer is idempotent: run it (committing), then preview a second run. Returns
 * the changes the second run would still make. An empty list means the installer is idempotent,
 * which the installer protocol requires.
 */
export async function checkIdempotent(
  installer: DevkitInstaller,
  options: Omit<RunInstallerOptions, 'dryRun' | 'mode'>,
): Promise<readonly FileChange[]> {
  await runInstaller(installer, { ...options, mode: 'install' })
  const second = await runInstaller(installer, { ...options, mode: 'install', dryRun: true })
  return second.changes
}
