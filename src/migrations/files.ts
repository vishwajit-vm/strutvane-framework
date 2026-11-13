/**
 * Migration files: timestamped SQL with a header that records every decision that produced it.
 *
 * ```sql
 * -- strutvane:migration
 * -- name: rename_customer
 * -- dialect: postgres
 * -- created: 2026-11-14T12:00:00.000Z
 * -- rename: table customers -> clients
 * -- separate: column invoices.notes -> memo
 * -- destructive: [data-loss] dropColumn invoices.notes
 * ALTER TABLE "customers" RENAME TO "clients";
 * --> statement-breakpoint
 * ...
 * ```
 *
 * Recording rename answers makes a plan reproducible without prompting: CI can regenerate and
 * compare with {@link answersResolver}. Next to the SQL files lives `snapshot.json`, the model
 * definitions the latest migration brings the database to: the `previous` of the next plan.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database, Dialect } from '../database/types.ts'
import type { ModelDefinition } from '../model/define-model.ts'
import {
  describeRename,
  type MigrationPlan,
  type RenameCandidate,
  type RenameDecision,
  type RenameResolver,
} from './planner.ts'

/** The separator between statements (drizzle-kit's convention). */
export const BREAKPOINT = '--> statement-breakpoint'

/** A migration as loaded from disk (or defined in code). */
export interface MigrationSource {
  /** File name without `.sql`, e.g. `20261114120000_create_invoices`. Sort order = apply order. */
  readonly name: string
  /** The executable statements, in order. */
  readonly statements: readonly string[]
  /** sha256 of the normalised statements; detects edits to applied migrations. */
  readonly checksum: string
  /**
   * Code to run after `statements`, inside the same transaction (hand-written TypeScript
   * migrations). Its checksum covers the file text instead.
   */
  readonly run?: (db: Database) => Promise<void>
}

/** The snapshot stored next to the migrations. */
export interface Snapshot {
  readonly version: 1
  readonly dialect: Dialect
  readonly models: readonly ModelDefinition[]
}

/** File-system safe migration name: lower snake case, 1–64 characters. */
export function sanitizeMigrationName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  if (clean === '') throw new TypeError('Migration name must contain at least one letter or digit')
  return clean
}

/** `20261114120000_create_invoices`: UTC timestamp, so names sort in creation order everywhere. */
export function migrationFileName(name: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp}_${sanitizeMigrationName(name)}`
}

/** The checksum of a list of statements (line endings normalised, so git autocrlf is harmless). */
export function checksumOf(statements: readonly string[]): string {
  const normalised = statements.map((s) => s.replaceAll('\r\n', '\n').trim()).join('\n;\n')
  return createHash('sha256').update(normalised).digest('hex')
}

/** Render a plan as migration file text. */
export function renderMigration(
  plan: MigrationPlan,
  options: { name: string; createdAt: Date },
): string {
  const header = [
    '-- strutvane:migration',
    `-- name: ${sanitizeMigrationName(options.name)}`,
    `-- dialect: ${plan.dialect}`,
    `-- created: ${options.createdAt.toISOString()}`,
    ...plan.renames.map((r) => `-- rename: ${describeRename(r)}`),
    ...plan.separated.map((r) => `-- separate: ${describeRename(r)}`),
    ...plan.destructive.map(
      (c) => `-- destructive: [${c.risk}] ${c.kind} ${c.table}${c.column ? `.${c.column}` : ''}`,
    ),
  ]
  return `${header.join('\n')}\n${plan.statements.join(`\n${BREAKPOINT}\n`)}\n`
}

/** The decisions recorded in a migration file header. */
export interface MigrationHeader {
  readonly name?: string
  readonly dialect?: string
  readonly created?: string
  readonly renames: readonly string[]
  readonly separated: readonly string[]
  readonly destructive: readonly string[]
}

/** Parse migration file text into its header and statements. */
export function parseMigration(text: string): { header: MigrationHeader; statements: string[] } {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const fields = new Map<string, string>()
  const renames: string[] = []
  const separated: string[] = []
  const destructive: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith(BREAKPOINT) || !line.startsWith('-- ')) break
    const m = /^-- ([a-z]+): (.*)$/.exec(line)
    if (!m) continue
    const [, key = '', value = ''] = m
    if (key === 'rename') renames.push(value)
    else if (key === 'separate') separated.push(value)
    else if (key === 'destructive') destructive.push(value)
    else fields.set(key, value)
  }
  const statements = lines
    .slice(i)
    .join('\n')
    .split(BREAKPOINT)
    .map((s) => s.trim())
    // A chunk of only comments (e.g. a hand-written file's notes) is not a statement.
    .filter((s) => s.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('--')))
  return {
    header: {
      ...optional('name', fields.get('name')),
      ...optional('dialect', fields.get('dialect')),
      ...optional('created', fields.get('created')),
      renames,
      separated,
      destructive,
    },
    statements,
  }
}

/** `{ key: value }` when the value exists, `{}` otherwise (exactOptionalPropertyTypes-friendly). */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string }
}

/**
 * A resolver from recorded answers (`describeRename(candidate)` → decision). Unknown candidates
 * throw, so a changed model can never be resolved by a stale answer.
 */
export function answersResolver(answers: Readonly<Record<string, RenameDecision>>): RenameResolver {
  return (candidate: RenameCandidate) => {
    const answer = answers[describeRename(candidate)]
    if (answer === undefined)
      throw new Error(`No recorded answer for possible rename: ${describeRename(candidate)}`)
    return answer
  }
}

/** Write `text` atomically: write a temp file, then rename over the target. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Write a planned migration and the new snapshot into `dir`. Returns the migration's name, or
 * `undefined` (and writes nothing) when the plan is empty.
 */
export async function writeMigration(
  dir: string,
  plan: MigrationPlan,
  next: readonly ModelDefinition[],
  options: { name: string; createdAt?: Date },
): Promise<string | undefined> {
  if (plan.statements.length === 0) return undefined
  const createdAt = options.createdAt ?? new Date()
  const name = migrationFileName(options.name, createdAt)
  await mkdir(dir, { recursive: true })
  const existing = await readdir(dir)
  if (existing.includes(`${name}.sql`)) throw new Error(`Migration ${name}.sql already exists`)
  await writeAtomic(
    join(dir, `${name}.sql`),
    renderMigration(plan, { name: options.name, createdAt }),
  )
  const snapshot: Snapshot = { version: 1, dialect: plan.dialect, models: next }
  await writeAtomic(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
  return name
}

/** Read the snapshot in `dir`; an empty model list when there is none yet. */
export async function readSnapshot(dir: string, dialect: Dialect): Promise<Snapshot> {
  let text: string
  try {
    text = await readFile(join(dir, 'snapshot.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, dialect, models: [] }
    throw error
  }
  const parsed = JSON.parse(text) as Partial<Snapshot>
  if (parsed.version !== 1 || !Array.isArray(parsed.models))
    throw new Error(`Unsupported snapshot format in ${dir}`)
  if (parsed.dialect !== dialect) {
    throw new Error(`Snapshot in ${dir} is for ${String(parsed.dialect)}, not ${dialect}`)
  }
  return parsed as Snapshot
}

/** Load every `*.sql` migration in `dir`, sorted by name. A missing directory means none. */
export async function readMigrations(dir: string): Promise<MigrationSource[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: MigrationSource[] = []
  for (const file of files.filter((f) => f.endsWith('.sql')).sort()) {
    const { statements } = parseMigration(await readFile(join(dir, file), 'utf8'))
    out.push(migrationSource(file.slice(0, -4), statements))
  }
  return out
}

/** Build a {@link MigrationSource} from statements (for migrations defined in code or tests). */
export function migrationSource(name: string, statements: readonly string[]): MigrationSource {
  return { name, statements: [...statements], checksum: checksumOf(statements) }
}
