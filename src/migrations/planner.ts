/**
 * Migration planner: (previous models, next models) → ordered SQL statements. Pure: it never
 * touches a database (ADR-0009).
 *
 * Why not just call drizzle-kit's `generateMigration(prev, next)`? In drizzle-kit 0.31, whenever
 * a diff contains both a removed and an added table (or column of one table) it opens an
 * interactive "is this a rename?" prompt. Without a TTY it rejects; with one it blocks on stdin.
 * Neither is acceptable for a framework, CI or an IDE, and the resolvers cannot be injected. So
 * the planner owns rename resolution and only hands drizzle-kit diffs that cannot prompt:
 *
 * 1. **Resolve**: find rename candidates at the model level and ask the injected `resolveRename`
 *    callback about each one. Never guess: candidates without a callback throw
 *    {@link RenameResolutionRequiredError}.
 * 2. **Classify**: detect destructive or risky changes; blocked unless `allowDestructive`.
 * 3. **Rename**: emit `ALTER TABLE … RENAME [COLUMN]` ourselves.
 * 4. **Diff**: two drizzle-kit diffs, each checked by {@link assertPromptFree} first:
 *    renamed-previous → intermediate (removals only), then intermediate → next (additions and
 *    alterations only).
 * 5. **Tenancy**: on Postgres, row-level security for tenant tables (ADR-0007).
 *
 * @module
 */
import type { Dialect } from '../database/types.ts'
import { columnName, type ModelDefinition } from '../model/define-model.ts'
import type { FieldDef } from '../model/field.ts'
import {
  compilePg,
  compileSqlite,
  defaultNaming,
  type Naming,
  tableColumns,
} from '../schema/compile.ts'
import { disableTenantRls, enableTenantRls } from './rls.ts'

/** A possible rename the planner will not guess about. */
export type RenameCandidate =
  | {
      readonly kind: 'table'
      readonly fromModel: string
      readonly toModel: string
      readonly fromTable: string
      readonly toTable: string
    }
  | {
      readonly kind: 'column'
      /** Model and table name *after* any table rename. */
      readonly model: string
      readonly table: string
      readonly fromField: string
      readonly toField: string
      readonly fromColumn: string
      readonly toColumn: string
    }

/** `rename` keeps the data; `separate` means "drop the old one, create the new one". */
export type RenameDecision = 'rename' | 'separate'

/** Answers rename questions (the CLI asks the developer; CI passes recorded answers). */
export type RenameResolver = (
  candidate: RenameCandidate,
) => RenameDecision | Promise<RenameDecision>

/** Kinds of change that can lose data or fail on existing rows. */
export type DestructiveKind =
  | 'dropTable'
  | 'dropColumn'
  | 'changeType'
  | 'narrowType'
  | 'removeEnumValues'
  | 'makeRequired'
  | 'addRequiredWithoutDefault'
  | 'addUnique'

/** One destructive or risky change. */
export interface DestructiveChange {
  readonly kind: DestructiveKind
  readonly table: string
  readonly column?: string
  /** `data-loss`: data is irreversibly removed. `may-fail`: fails if existing rows violate it. */
  readonly risk: 'data-loss' | 'may-fail'
  readonly detail: string
}

/**
 * Thrown when possible renames exist and no resolver was given.
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export class RenameResolutionRequiredError extends Error {
  override readonly name = 'RenameResolutionRequiredError'
  readonly candidates: readonly RenameCandidate[]
  constructor(candidates: readonly RenameCandidate[]) {
    super(
      `Possible renames need a decision (rename or separate): ${candidates.map(describeRename).join('; ')}`,
    )
    this.candidates = candidates
  }
}

/**
 * Thrown when a plan contains destructive changes and `allowDestructive` is not set.
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export class DestructiveChangeError extends Error {
  override readonly name = 'DestructiveChangeError'
  readonly changes: readonly DestructiveChange[]
  constructor(changes: readonly DestructiveChange[]) {
    super(
      `Migration contains ${changes.length} destructive or risky change(s); pass allowDestructive to proceed:\n${changes
        .map(
          (c) =>
            `  - [${c.risk}] ${c.kind} ${c.table}${c.column ? `.${c.column}` : ''}: ${c.detail}`,
        )
        .join('\n')}`,
    )
    this.changes = changes
  }
}

/**
 * A human description of a rename candidate (`table customers -> clients`).
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export function describeRename(c: RenameCandidate): string {
  return c.kind === 'table'
    ? `table ${c.fromTable} -> ${c.toTable}`
    : `column ${c.table}.${c.fromColumn} -> ${c.toColumn}`
}

/** Input to {@link planMigration}. */
export interface PlanInput {
  readonly dialect: Dialect
  /** The models the database currently has (from the last snapshot; empty for the first plan). */
  readonly previous: readonly ModelDefinition[]
  readonly next: readonly ModelDefinition[]
  readonly resolveRename?: RenameResolver
  readonly allowDestructive?: boolean
}

/** The result of planning. */
export interface MigrationPlan {
  readonly dialect: Dialect
  /** Ordered, executable SQL statements. Empty when nothing changed. */
  readonly statements: readonly string[]
  /** Renames confirmed by the resolver (recorded in the migration file header). */
  readonly renames: readonly RenameCandidate[]
  /** Candidates the resolver answered `separate` for (also recorded). */
  readonly separated: readonly RenameCandidate[]
  /** Destructive changes found (non-empty only when `allowDestructive` was set). */
  readonly destructive: readonly DestructiveChange[]
}

// ───────────────────────────── phase 1: renames ─────────────────────────────

const sameShape = (a: FieldDef, b: FieldDef): boolean =>
  a.kind === b.kind && (a.kind !== 'belongsTo' || a.target === b.target)

interface ColumnEntry {
  readonly key: string
  readonly column: string
  readonly def: FieldDef
}

const columnsOf = (m: ModelDefinition): ColumnEntry[] =>
  Object.entries(m.fields).map(([key, def]) => ({ key, column: columnName(key, def), def }))

interface ResolvedRenames {
  readonly confirmed: RenameCandidate[]
  readonly separated: RenameCandidate[]
  /** previous model name → next model name, for confirmed table renames */
  readonly modelRenames: Map<string, string>
  /** next model name → (previous field key → next field key) */
  readonly fieldRenames: Map<string, Map<string, string>>
}

async function resolveRenames(input: PlanInput): Promise<ResolvedRenames> {
  const prevByName = new Map(input.previous.map((m) => [m.name, m]))
  const nextByName = new Map(input.next.map((m) => [m.name, m]))
  const confirmed: RenameCandidate[] = []
  const separated: RenameCandidate[] = []
  const unresolved: RenameCandidate[] = []
  const modelRenames = new Map<string, string>()
  const fieldRenames = new Map<string, Map<string, string>>()

  const ask = async (c: RenameCandidate): Promise<RenameDecision | undefined> => {
    if (!input.resolveRename) {
      unresolved.push(c)
      return undefined
    }
    const decision = await input.resolveRename(c)
    if (decision !== 'rename' && decision !== 'separate') {
      throw new TypeError(
        `resolveRename must return 'rename' or 'separate', got ${String(decision)}`,
      )
    }
    if (decision === 'separate') separated.push(c)
    return decision
  }

  // Tables: every (removed, added) pair is a candidate; each removed model is renamed at most once.
  const pool = input.previous.filter((m) => !nextByName.has(m.name))
  for (const a of input.next.filter((m) => !prevByName.has(m.name))) {
    for (const r of [...pool]) {
      const c: RenameCandidate = {
        kind: 'table',
        fromModel: r.name,
        toModel: a.name,
        fromTable: r.table,
        toTable: a.table,
      }
      if ((await ask(c)) === 'rename') {
        confirmed.push(c)
        modelRenames.set(r.name, a.name)
        pool.splice(pool.indexOf(r), 1)
        break
      }
    }
  }

  // Columns: within each (previous, next) model pair, removed × added columns of the same shape.
  for (const p of input.previous) {
    const n = nextByName.get(modelRenames.get(p.name) ?? p.name)
    if (!n) continue
    const prevCols = columnsOf(p)
    const nextCols = columnsOf(n)
    const nextNames = new Set(nextCols.map((c) => c.column))
    const prevNames = new Set(prevCols.map((c) => c.column))
    const removed = prevCols.filter((c) => !nextNames.has(c.column))
    const map = new Map<string, string>()
    for (const a of nextCols.filter((c) => !prevNames.has(c.column))) {
      for (const r of removed.filter((x) => sameShape(x.def, a.def))) {
        const c: RenameCandidate = {
          kind: 'column',
          model: n.name,
          table: n.table,
          fromField: r.key,
          toField: a.key,
          fromColumn: r.column,
          toColumn: a.column,
        }
        if ((await ask(c)) === 'rename') {
          confirmed.push(c)
          map.set(r.key, a.key)
          removed.splice(removed.indexOf(r), 1)
          break
        }
      }
    }
    if (map.size > 0) fieldRenames.set(n.name, map)
  }

  if (unresolved.length > 0) throw new RenameResolutionRequiredError(unresolved)
  return { confirmed, separated, modelRenames, fieldRenames }
}

/** Apply confirmed renames to the previous models (definitions unchanged, identifiers renamed). */
function applyRenames(
  previous: readonly ModelDefinition[],
  next: readonly ModelDefinition[],
  r: ResolvedRenames,
): ModelDefinition[] {
  const nextByName = new Map(next.map((m) => [m.name, m]))
  return previous.map((p) => {
    const newName = r.modelRenames.get(p.name)
    const name = newName ?? p.name
    const table = (newName ? nextByName.get(newName)?.table : undefined) ?? p.table
    const fmap = r.fieldRenames.get(name)
    const fields: Record<string, FieldDef> = {}
    for (const [key, def] of Object.entries(p.fields)) {
      // belongsTo targets follow model renames
      const target =
        def.kind === 'belongsTo' ? (r.modelRenames.get(def.target ?? '') ?? def.target) : undefined
      fields[fmap?.get(key) ?? key] =
        target !== undefined && target !== def.target ? { ...def, target } : def
    }
    return { ...p, name, table, fields }
  })
}

/**
 * Naming that maps renamed identifiers back to the originals, so the compiled "renamed previous"
 * schema carries the constraint names that really exist in the database.
 */
function legacyNaming(
  previous: readonly ModelDefinition[],
  renamed: readonly ModelDefinition[],
  r: ResolvedRenames,
): Naming {
  const tableBack = new Map<string, string>()
  const colBack = new Map<string, string>()
  previous.forEach((p, i) => {
    const q = renamed[i] as ModelDefinition
    if (q.table !== p.table) tableBack.set(q.table, p.table)
    for (const [fromKey, toKey] of r.fieldRenames.get(q.name) ?? []) {
      const fromDef = p.fields[fromKey] as FieldDef
      const toDef = q.fields[toKey] as FieldDef
      colBack.set(`${q.table}.${columnName(toKey, toDef)}`, columnName(fromKey, fromDef))
    }
  })
  return (kind, table, column) =>
    defaultNaming(kind, tableBack.get(table) ?? table, colBack.get(`${table}.${column}`) ?? column)
}

// ───────────────────────────── phase 2: classify ─────────────────────────────

const textLength = (d: FieldDef): number => d.length ?? (d.kind === 'url' ? 2048 : 255)
const hasVarchar = (d: FieldDef): boolean =>
  d.kind === 'string' || d.kind === 'email' || d.kind === 'url'

/**
 * Detect every destructive or risky change between the renamed previous models and next.
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export function classifyChanges(
  renamedPrev: readonly ModelDefinition[],
  next: readonly ModelDefinition[],
  dialect: Dialect,
): DestructiveChange[] {
  const out: DestructiveChange[] = []
  const nextByName = new Map(next.map((m) => [m.name, m]))
  for (const p of renamedPrev) {
    const n = nextByName.get(p.name)
    if (!n) {
      out.push({
        kind: 'dropTable',
        table: p.table,
        risk: 'data-loss',
        detail: `model ${p.name} removed`,
      })
      continue
    }
    const prevCols = new Map(columnsOf(p).map((c) => [c.column, c]))
    const nextCols = new Map(columnsOf(n).map((c) => [c.column, c]))
    for (const col of prevCols.keys()) {
      if (!nextCols.has(col)) {
        out.push({
          kind: 'dropColumn',
          table: n.table,
          column: col,
          risk: 'data-loss',
          detail: 'column removed',
        })
      }
    }
    for (const [col, nc] of nextCols) {
      const a = nc.def
      const pc = prevCols.get(col)
      if (!pc) {
        if (a.required && a.default === undefined) {
          out.push({
            kind: 'addRequiredWithoutDefault',
            table: n.table,
            column: col,
            risk: 'may-fail',
            detail: 'NOT NULL column without a default; fails if the table has rows',
          })
        }
        if (a.unique)
          out.push({
            kind: 'addUnique',
            table: n.table,
            column: col,
            risk: 'may-fail',
            detail: 'new unique column',
          })
        continue
      }
      const b = pc.def
      if (b.kind !== a.kind) {
        out.push({
          kind: 'changeType',
          table: n.table,
          column: col,
          risk: 'data-loss',
          detail: `${b.kind} -> ${a.kind}`,
        })
        continue
      }
      if (hasVarchar(a) && textLength(a) < textLength(b)) {
        out.push({
          kind: 'narrowType',
          table: n.table,
          column: col,
          risk: 'may-fail',
          detail: `varchar(${textLength(b)}) -> varchar(${textLength(a)})`,
        })
      }
      if (
        a.kind === 'decimal' &&
        ((a.precision ?? 12) < (b.precision ?? 12) || (a.scale ?? 2) < (b.scale ?? 2))
      ) {
        out.push({
          kind: 'narrowType',
          table: n.table,
          column: col,
          risk: dialect === 'postgres' ? 'may-fail' : 'data-loss',
          detail: `decimal(${b.precision},${b.scale}) -> decimal(${a.precision},${a.scale})`,
        })
      }
      if (a.kind === 'enum') {
        const gone = (b.values ?? []).filter((v) => !(a.values ?? []).includes(v))
        if (gone.length > 0) {
          out.push({
            kind: 'removeEnumValues',
            table: n.table,
            column: col,
            risk: 'may-fail',
            detail: `removed values: ${gone.join(', ')}`,
          })
        }
      }
      if (a.required && !b.required) {
        out.push({
          kind: 'makeRequired',
          table: n.table,
          column: col,
          risk: 'may-fail',
          detail: 'optional -> required; fails if NULLs exist',
        })
      }
      if (a.unique && !b.unique) {
        out.push({
          kind: 'addUnique',
          table: n.table,
          column: col,
          risk: 'may-fail',
          detail: 'fails if duplicates exist',
        })
      }
    }
    const optionCols: readonly [keyof ModelDefinition['options'], readonly string[]][] = [
      ['timestamps', ['created_at', 'updated_at']],
      ['softDeletes', ['deleted_at']],
      ['tenant', ['tenant_id']],
    ]
    for (const [opt, cols] of optionCols) {
      if (p.options[opt] && !n.options[opt]) {
        for (const col of cols) {
          out.push({
            kind: 'dropColumn',
            table: n.table,
            column: col,
            risk: 'data-loss',
            detail: `${opt} disabled`,
          })
        }
      }
      if (!p.options[opt] && n.options[opt]) {
        const hasDefault = opt === 'softDeletes' || (opt === 'timestamps' && dialect === 'postgres')
        if (!hasDefault) {
          for (const col of cols) {
            out.push({
              kind: 'addRequiredWithoutDefault',
              table: n.table,
              column: col,
              risk: 'may-fail',
              detail: `${opt} enabled on an existing table`,
            })
          }
        }
      }
    }
  }
  return out
}

// ───────────────────────────── phases 3–5: SQL ─────────────────────────────

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`

function renameStatements(renames: readonly RenameCandidate[]): string[] {
  // Table renames first; column candidates already use the new table name.
  return [
    ...renames.flatMap((r) =>
      r.kind === 'table' ? [`ALTER TABLE ${q(r.fromTable)} RENAME TO ${q(r.toTable)};`] : [],
    ),
    ...renames.flatMap((r) =>
      r.kind === 'column'
        ? [`ALTER TABLE ${q(r.table)} RENAME COLUMN ${q(r.fromColumn)} TO ${q(r.toColumn)};`]
        : [],
    ),
  ]
}

/**
 * renamed-previous minus every column or option column that disappears or changes identity, and
 * (unless `keepTables`) minus every table that disappears. Columns are removed in a step of their
 * own before tables: Postgres' `DROP TABLE … CASCADE` would otherwise silently remove the foreign
 * keys that the column removals then try to drop.
 */
function intermediateOf(
  renamedPrev: readonly ModelDefinition[],
  next: readonly ModelDefinition[],
  keepTables: boolean,
): ModelDefinition[] {
  const nextByName = new Map(next.map((m) => [m.name, m]))
  const out: ModelDefinition[] = []
  for (const p of renamedPrev) {
    const n = nextByName.get(p.name)
    if (!n) {
      if (keepTables) out.push(p)
      continue
    }
    const fields: Record<string, FieldDef> = {}
    for (const [key, def] of Object.entries(p.fields)) {
      const nd = n.fields[key]
      // Keep only fields that survive with the same column; belongsTo to vanished models go too.
      const survives = nd !== undefined && columnName(key, nd) === columnName(key, def)
      if (survives && (def.kind !== 'belongsTo' || nextByName.has(def.target ?? '')))
        fields[key] = def
    }
    out.push({
      ...p,
      fields,
      options: {
        ...p.options,
        timestamps: p.options.timestamps && n.options.timestamps,
        softDeletes: p.options.softDeletes && n.options.softDeletes,
        tenant: p.options.tenant && n.options.tenant,
      },
    })
  }
  return out
}

/**
 * Invariant guard: a diff handed to drizzle-kit must not contain anything its prompts fire on
 * (a table both created and deleted, or a table both gaining and losing columns).
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export function assertPromptFree(
  from: readonly ModelDefinition[],
  to: readonly ModelDefinition[],
): void {
  const fromTables = new Set(from.map((m) => m.table))
  const toTables = new Set(to.map((m) => m.table))
  const created = [...toTables].filter((t) => !fromTables.has(t))
  const deleted = [...fromTables].filter((t) => !toTables.has(t))
  if (created.length > 0 && deleted.length > 0) {
    throw new Error(
      `Internal invariant violated: diff both creates [${created}] and deletes [${deleted}] tables`,
    )
  }
  const toByTable = new Map(to.map((m) => [m.table, m]))
  for (const f of from) {
    const t = toByTable.get(f.table)
    if (!t) continue
    const a = new Set(tableColumns(f))
    const b = new Set(tableColumns(t))
    const added = [...b].filter((c) => !a.has(c))
    const dropped = [...a].filter((c) => !b.has(c))
    if (added.length > 0 && dropped.length > 0) {
      throw new Error(
        `Internal invariant violated: ${f.table} both adds [${added}] and drops [${dropped}] columns`,
      )
    }
  }
}

async function drizzleDiff(
  dialect: Dialect,
  from: readonly ModelDefinition[],
  fromNaming: Naming,
  to: readonly ModelDefinition[],
  toNaming: Naming,
): Promise<string[]> {
  assertPromptFree(from, to)
  // Loaded on demand: drizzle-kit is large and only migration planning needs it, never a request.
  const kit = await import('drizzle-kit/api')
  if (dialect === 'postgres') {
    const a = kit.generateDrizzleJson(compilePg(from, { naming: fromNaming }))
    const b = kit.generateDrizzleJson(compilePg(to, { naming: toNaming }))
    return kit.generateMigration(a, b)
  }
  const a = await kit.generateSQLiteDrizzleJson(compileSqlite(from, { naming: fromNaming }))
  const b = await kit.generateSQLiteDrizzleJson(compileSqlite(to, { naming: toNaming }))
  return kit.generateSQLiteMigration(a, b)
}

/**
 * Row-level-security changes for tenant tables (Postgres only). Disabling runs before the
 * removals (the policies depend on `tenant_id`); enabling runs after the additions.
 */
function tenancyStatements(
  dialect: Dialect,
  renamedPrev: readonly ModelDefinition[],
  next: readonly ModelDefinition[],
): { disable: string[]; enable: string[] } {
  const out = { disable: [] as string[], enable: [] as string[] }
  if (dialect !== 'postgres') return out
  const prevByName = new Map(renamedPrev.map((m) => [m.name, m]))
  for (const n of next) {
    const was = prevByName.get(n.name)?.options.tenant ?? false
    if (n.options.tenant && !was) out.enable.push(...enableTenantRls(n.table))
    if (!n.options.tenant && was) out.disable.push(...disableTenantRls(n.table))
  }
  return out
}

/**
 * Plan a migration from `previous` to `next`. Pure: never touches a database.
 *
 * @deprecated Drizzle-based v1 (model-first) migration planning. Migration-first apps write
 * migrations with the Schema builder (`@strutvane/framework/schema`) and run `node strut migrate`
 * (`runMigrations` in `@strutvane/framework/database`). Kept working in 0.2; removed in 0.3.
 */
export async function planMigration(input: PlanInput): Promise<MigrationPlan> {
  const renames = await resolveRenames(input)
  const renamedPrev = applyRenames(input.previous, input.next, renames)
  const legacy = legacyNaming(input.previous, renamedPrev, renames)

  const destructive = classifyChanges(renamedPrev, input.next, input.dialect)
  if (destructive.length > 0 && !input.allowDestructive)
    throw new DestructiveChangeError(destructive)

  const withoutColumns = intermediateOf(renamedPrev, input.next, true)
  const intermediate = intermediateOf(renamedPrev, input.next, false)
  const columnRemovals = await drizzleDiff(
    input.dialect,
    renamedPrev,
    legacy,
    withoutColumns,
    legacy,
  )
  const tableRemovals = await drizzleDiff(
    input.dialect,
    withoutColumns,
    legacy,
    intermediate,
    legacy,
  )
  const additions = await drizzleDiff(
    input.dialect,
    intermediate,
    legacy,
    input.next,
    defaultNaming,
  )
  const tenancy = tenancyStatements(input.dialect, renamedPrev, input.next)

  return {
    dialect: input.dialect,
    statements: [
      ...renameStatements(renames.confirmed),
      ...tenancy.disable,
      ...columnRemovals,
      ...tableRemovals,
      ...additions,
      ...tenancy.enable,
    ]
      .map((s) => s.trim())
      .filter(Boolean),
    renames: renames.confirmed,
    separated: renames.separated,
    destructive,
  }
}
