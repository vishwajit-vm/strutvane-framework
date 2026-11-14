/**
 * `sv doctor`: diagnose the environment and the project (docs/09 §2).
 *
 * Each check is a small function returning `ok`, `warn` or `fail` with a hint. Failures exit 3
 * (needs attention), warnings do not, so `sv doctor` can gate CI. Database, migration and RLS
 * checks belong to `@strutvane/framework` and `@strutvane/auth`, which can contribute their own
 * diagnostics commands; the CLI checks what it can see statically.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasConflictMarkers, nodeIo, readLock } from '@strutvane/devkit'
import { type AnyCommand, defineCommand, type Project } from '../framework/command.ts'
import { CliError, toFailure } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { renderMessages } from '../framework/run.ts'
import { checkEnv } from '../project/env-check.ts'
import { loadPluginCommands } from '../project/plugin-commands.ts'
import { declaredRange, dependencyNames, readInstalledPackage } from '../project/project.ts'
import { parseVersion } from '../project/semver.ts'
import { RegistryCompiler } from '../registry/compiler.ts'
import { verifyContentHash } from '../registry/emit.ts'
import { isStrutvanePackage } from './about.ts'

/** The outcome of one check. */
export interface DoctorCheck {
  readonly id: string
  readonly status: 'ok' | 'warn' | 'fail'
  readonly message: string
  readonly hint?: string
}

const ok = (id: string, message: string): DoctorCheck => ({ id, status: 'ok', message })
const warn = (id: string, message: string, hint?: string): DoctorCheck =>
  hint === undefined ? { id, status: 'warn', message } : { id, status: 'warn', message, hint }
const fail = (id: string, message: string, hint?: string): DoctorCheck =>
  hint === undefined ? { id, status: 'fail', message } : { id, status: 'fail', message, hint }

/** The minimum supported Node.js major version (D-decision: Node 24+). */
export const MIN_NODE_MAJOR = 24

/** Node.js version check. */
export function checkNode(version: string): DoctorCheck {
  const major = parseVersion(version)?.major ?? 0
  return major >= MIN_NODE_MAJOR
    ? ok('node', `Node.js ${version}`)
    : fail('node', `Node.js ${version} is too old`, `Install Node.js ${MIN_NODE_MAJOR} or newer.`)
}

function checkPackageJson(project: Project): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  checks.push(
    project.packageJson['type'] === 'module'
      ? ok('esm', 'package.json has "type": "module"')
      : warn('esm', 'package.json is not ESM', 'Strutvane apps are ESM: add "type": "module".'),
  )
  checks.push(
    declaredRange(project.packageJson, '@strutvane/cli') !== undefined
      ? ok('cli-local', '@strutvane/cli is a project dependency')
      : warn(
          'cli-local',
          '@strutvane/cli is not in package.json',
          'Add it (pnpm add -D @strutvane/cli) so everyone runs the same CLI version.',
        ),
  )
  return checks
}

function checkPackages(project: Project): DoctorCheck[] {
  const names = dependencyNames(project.packageJson).filter(
    (n) => isStrutvanePackage(n) && n.startsWith('@strutvane/'),
  )
  const missing = names.filter((n) => readInstalledPackage(project.root, n) === undefined)
  const checks: DoctorCheck[] = []
  if (missing.length > 0) {
    checks.push(
      fail(
        'installed',
        `Not installed: ${missing.join(', ')}`,
        'Run your package manager install.',
      ),
    )
  } else if (names.length > 0) {
    checks.push(ok('installed', `${names.length} Strutvane package(s) installed`))
  }
  // Core packages share a release train (major.minor); mixing trains is a common upgrade mistake.
  const trains = new Map<string, string[]>()
  for (const name of names) {
    const version = readInstalledPackage(project.root, name)?.version
    const parsed = version === undefined ? undefined : parseVersion(version)
    if (parsed === undefined) continue
    const train = `${parsed.major}.${parsed.minor}`
    trains.set(train, [...(trains.get(train) ?? []), name])
  }
  if (trains.size > 1) {
    const detail = [...trains].map(([train, pkgs]) => `${train}.x: ${pkgs.join(', ')}`).join('; ')
    checks.push(
      warn(
        'release-train',
        `Strutvane packages are on different release trains (${detail})`,
        'Run `sv upgrade` to align them.',
      ),
    )
  }
  return checks
}

function checkEnvFiles(project: Project): DoctorCheck[] {
  const result = checkEnv(project.root)
  if (!result.exampleExists) {
    return [
      warn('env', 'No .env.example', 'Document every variable the app reads in .env.example.'),
    ]
  }
  const checks: DoctorCheck[] = []
  if (!existsSync(join(project.root, '.env'))) {
    checks.push(
      fail(
        'env',
        '.env is missing',
        'Copy .env.example to .env and fill it in, then run sv key:generate.',
      ),
    )
  } else {
    const errors = result.problems.filter((p) => p.severity === 'error')
    checks.push(
      errors.length === 0
        ? ok('env', '.env matches .env.example')
        : fail(
            'env',
            `${errors.length} env problem(s): ${errors.map((e) => e.key).join(', ')}`,
            'Run `sv env:check` for details.',
          ),
    )
  }
  const gitignore = join(project.root, '.gitignore')
  const ignored =
    existsSync(gitignore) &&
    readFileSync(gitignore, 'utf8')
      .split(/\r?\n/)
      .some((line) => ['.env', '/.env', '.env*', '.env.*'].includes(line.trim()))
  checks.push(
    ignored
      ? ok('env-ignored', '.env is git-ignored')
      : fail(
          'env-ignored',
          '.env is not in .gitignore',
          'Add ".env" to .gitignore: it holds secrets and must never be committed.',
        ),
  )
  return checks
}

function checkRegistry(project: Project): DoctorCheck[] {
  if (!existsSync(join(project.root, 'app')) && !existsSync(join(project.root, 'web'))) return []
  const compiler = new RegistryCompiler(project.root)
  const result = compiler.compile()
  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  if (errors.length > 0) {
    return [
      fail(
        'registry',
        `The registry has ${errors.length} error(s)`,
        'Run `sv registry:build` to see them.',
      ),
    ]
  }
  const current = existsSync(compiler.outputPath)
    ? readFileSync(compiler.outputPath, 'utf8')
    : undefined
  if (current === undefined) {
    return [
      warn('registry', '.strutvane/registry.gen.ts has not been built', 'Run `sv registry:build`.'),
    ]
  }
  if (!verifyContentHash(current)) {
    return [
      warn(
        'registry',
        '.strutvane/registry.gen.ts was edited by hand',
        'Run `sv registry:build` to regenerate it.',
      ),
    ]
  }
  if (current !== result.output) {
    return [
      warn('registry', '.strutvane/registry.gen.ts is out of date', 'Run `sv registry:build`.'),
    ]
  }
  return [ok('registry', 'The registry is up to date')]
}

async function checkOwnedFiles(project: Project): Promise<DoctorCheck[]> {
  const lock = await readLock(nodeIo, project.root)
  if (lock.status === 'missing') return []
  if (lock.status !== 'ok') {
    return [
      fail(
        'lock',
        '.strutvane/lock.json is unreadable',
        'Restore it from git; `sv upgrade` needs it to merge owned files.',
      ),
    ]
  }
  const conflicted = Object.entries(lock.lock.files)
    .filter(([path, entry]) => {
      if (entry.conflicted) return true
      const file = join(project.root, path)
      return existsSync(file) && hasConflictMarkers(readFileSync(file, 'utf8'))
    })
    .map(([path]) => path)
  return conflicted.length === 0
    ? [ok('lock', 'No unresolved upgrade conflicts')]
    : [
        fail(
          'lock',
          `Unresolved merge conflicts in: ${conflicted.join(', ')}`,
          'Resolve the conflict markers, then commit.',
        ),
      ]
}

async function checkPlugins(project: Project, version: string): Promise<DoctorCheck[]> {
  const { problems, commands } = await loadPluginCommands(project, version)
  const checks: DoctorCheck[] = []
  for (const p of problems) {
    if (p.kind === 'incompatible' && p.missing === true) {
      checks.push(
        fail(
          'plugins',
          `${p.name}@${p.version} declares no strutvane.compat range, so it is not loaded`,
          'Ask the plugin author to declare the Strutvane versions it supports.',
        ),
      )
    } else if (p.kind === 'incompatible') {
      checks.push(
        fail(
          'plugins',
          `${p.name}@${p.version} requires Strutvane ${p.range} (CLI is ${version})`,
          'Install matching versions, or run `sv upgrade`.',
        ),
      )
    } else if (p.kind === 'invalid-command') {
      checks.push(warn('plugins', `${p.name}: ${p.detail}`))
    } else {
      const detail = renderMessages(toFailure(p.error)).message
      checks.push(fail('plugins', `${p.name} could not be loaded: ${detail}`))
    }
  }
  if (checks.length === 0 && commands.length > 0) {
    checks.push(ok('plugins', `${commands.length} contributed command(s) loaded`))
  }
  return checks
}

export const doctorCommand: AnyCommand = defineCommand({
  name: 'doctor',
  description: 'Diagnose Node.js, the project, env files, the registry and plugins',
  requiresProject: false,
  flags: {
    global: { type: 'boolean', description: 'Only check the environment (no project needed)' },
  },
  examples: ['sv doctor', 'sv doctor --json', 'sv doctor --global'],
  async run(ctx) {
    const checks: DoctorCheck[] = [checkNode(process.versions.node)]
    const project = ctx.flags.global === true ? undefined : ctx.requireProject()
    if (project !== undefined) {
      checks.push(
        ...checkPackageJson(project),
        ...checkPackages(project),
        ...checkEnvFiles(project),
      )
      checks.push(...checkRegistry(project), ...(await checkOwnedFiles(project)))
      checks.push(...(await checkPlugins(project, ctx.version)))
    }
    const { out } = ctx
    for (const check of checks) {
      const icon =
        check.status === 'ok'
          ? out.style.green('✔')
          : check.status === 'warn'
            ? out.style.yellow('!')
            : out.style.red('✖')
      out.line(`${icon} ${check.message}`)
      if (check.hint !== undefined && check.status !== 'ok')
        out.line(`  ${out.style.dim(check.hint)}`)
    }
    const failed = checks.filter((c) => c.status === 'fail')
    const data = {
      checks,
      failed: failed.length,
      warnings: checks.filter((c) => c.status === 'warn').length,
    }
    if (failed.length > 0) {
      throw new CliError('DOCTOR_FAILED', {
        exitCode: EXIT.VALIDATION,
        params: { count: failed.length },
        data,
      })
    }
    out.success('Everything looks good.')
    return { data }
  },
})
