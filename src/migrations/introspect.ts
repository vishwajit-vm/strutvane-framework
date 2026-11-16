/**
 * Read a live database's schema and compare it with what the migrations say it should be.
 *
 * This is the safety net for the one thing replay can't see: someone changing the database by
 * hand, or with raw SQL. `node strut migrate` runs it after migrating, and `node strut doctor` on
 * demand. The tests also use it to prove that the SQL we generate produces exactly the schema the
 * recorder predicted, on SQLite, PostgreSQL, MySQL and MariaDB.
 *
 * @module
 */
import type { Connection } from '../database/db/connection.ts'
import type { Row } from '../database/db/driver.ts'
import { sql } from '../database/sql/fragment.ts'
import type { ColumnDef, ReferentialAction, SchemaState } from '../schema/columns.ts'
import { columnType } from '../schema/ddl/ddl.ts'
import type { Dialect } from '../schema/ddl/dialect.ts'
import { MIGRATIONS_TABLE } from './runner.ts'

/**
 * A column as the database reports it.
 *
 * @example
 * const column: LiveColumn = { name: 'title', type: 'character varying(200)', nullable: false }
 */
export interface LiveColumn {
  readonly name: string
  /** The engine's own type name, lower-cased. */
  readonly type: string
  readonly nullable: boolean
}

/**
 * An index as the database reports it (primary keys and engine-made indexes left out).
 *
 * @example
 * const index: LiveIndex = { name: 'posts_slug_unique', columns: ['slug'], unique: true }
 */
export interface LiveIndex {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

/**
 * A foreign key as the database reports it. Composite tenant keys (`(tenant_id, project_id)` →
 * `projects (tenant_id, id)`) have two columns on each side.
 *
 * @example
 * const key: LiveForeignKey = { columns: ['author_id'], table: 'users', references: ['id'], onDelete: 'cascade' }
 */
export interface LiveForeignKey {
  readonly columns: readonly string[]
  readonly table: string
  readonly references: readonly string[]
  readonly onDelete: ReferentialAction
}

/**
 * A table as the database reports it.
 *
 * @example
 * const live: LiveTable = { name: 'tags', columns: [], indexes: [], foreignKeys: [] }
 */
export interface LiveTable {
  readonly name: string
  readonly columns: readonly LiveColumn[]
  readonly indexes: readonly LiveIndex[]
  readonly foreignKeys: readonly LiveForeignKey[]
}

/**
 * Read every app table, sorted by name (the `migrations` table and engine internals are skipped).
 *
 * @example
 * const live = await introspect(connection)
 */
export async function introspect(connection: Connection): Promise<LiveTable[]> {
  switch (connection.grammar.dialect) {
    case 'sqlite':
      return introspectSqlite(connection)
    case 'postgres':
      return introspectPostgres(connection)
    case 'mysql':
    case 'mariadb':
      return introspectMysql(connection)
  }
}

/**
 * Compare the expected schema with the live one. Returns one plain-words sentence per difference,
 * or an empty list when they match.
 *
 * @example
 * schemaDrift(replay.state, await introspect(connection), 'sqlite') // []
 */
export function schemaDrift(
  expected: SchemaState,
  live: readonly LiveTable[],
  dialect: Dialect,
): string[] {
  const problems: string[] = []
  const liveByName = new Map(live.map((table) => [table.name, table]))
  for (const table of expected.tables) {
    const actual = liveByName.get(table.name)
    if (actual === undefined) {
      problems.push(`Table "${table.name}" is in the migrations but not in the database.`)
      continue
    }
    const expectedKeys: string[] = []
    for (const column of table.columns) {
      const where = `"${table.name}.${column.name}"`
      const liveColumn = actual.columns.find((candidate) => candidate.name === column.name)
      if (liveColumn === undefined) {
        problems.push(`Column ${where} is in the migrations but not in the database.`)
        continue
      }
      const wantedType = expectedLiveType(column, dialect)
      if (liveColumn.type !== wantedType)
        problems.push(
          `Column ${where} should be ${wantedType}, but the database says ${liveColumn.type}.`,
        )
      // A primary key is NOT NULL in the database even though "nullable" never applies to it.
      const wantedNullable =
        column.kind === 'id' || column.primary === true ? false : column.nullable
      if (liveColumn.nullable !== wantedNullable)
        problems.push(
          `Column ${where} should be ${wantedNullable ? 'nullable' : 'NOT NULL'}, but the database disagrees.`,
        )
      const wanted = column.references
      if (wanted === undefined) continue
      const columns =
        wanted.tenant === undefined ? [column.name] : [wanted.tenant.column, column.name]
      const references =
        wanted.tenant === undefined ? [wanted.column] : [wanted.tenant.parentColumn, wanted.column]
      expectedKeys.push(columns.join(','))
      const liveKey = actual.foreignKeys.find((key) => key.columns.join(',') === columns.join(','))
      if (
        liveKey?.table !== wanted.table ||
        liveKey.references.join(',') !== references.join(',') ||
        liveKey.onDelete !== wanted.onDelete
      )
        problems.push(
          `Column ${where} should reference ${wanted.table}.${wanted.column} (on delete ${wanted.onDelete}), but the database disagrees.`,
        )
    }
    for (const key of actual.foreignKeys) {
      if (!expectedKeys.includes(key.columns.join(',')))
        problems.push(
          `"${table.name}" has a foreign key on (${key.columns.join(', ')}) the migrations don't know about.`,
        )
    }
    for (const column of actual.columns) {
      if (!table.columns.some((candidate) => candidate.name === column.name))
        problems.push(
          `Column "${table.name}.${column.name}" is in the database but not in the migrations.`,
        )
    }
    for (const index of table.indexes) {
      const liveIndex = actual.indexes.find((candidate) => candidate.name === index.name)
      if (
        liveIndex === undefined ||
        liveIndex.unique !== index.unique ||
        liveIndex.columns.join(',') !== index.columns.join(',')
      )
        problems.push(`Index "${index.name}" on "${table.name}" doesn't match the migrations.`)
    }
    for (const index of actual.indexes) {
      if (!table.indexes.some((candidate) => candidate.name === index.name))
        problems.push(
          `Index "${index.name}" on "${table.name}" is in the database but not in the migrations.`,
        )
    }
  }
  for (const table of live) {
    if (!expected.tables.some((candidate) => candidate.name === table.name))
      problems.push(`Table "${table.name}" is in the database but not in the migrations.`)
  }
  return problems
}

/**
 * How the engine reports the type we asked for: PostgreSQL and MySQL normalise names, SQLite echoes
 * them. Collations are not part of the reported type.
 *
 * @example
 * expectedLiveType({ name: 'title', kind: 'string', nullable: false, length: 200 }, 'postgres') // 'character varying(200)'
 */
export function expectedLiveType(column: ColumnDef, dialect: Dialect): string {
  const declared = columnType(column, dialect).toLowerCase()
  switch (dialect) {
    case 'sqlite':
      return declared
    case 'postgres':
      return declared
        .replace(/^varchar\((\d+)\)$/, 'character varying($1)')
        .replace(/^numeric\((\d+), (\d+)\)$/, 'numeric($1,$2)')
    case 'mysql':
    case 'mariadb':
      if (column.kind === 'id') return 'bigint unsigned'
      return declared
        .replace(/ collate \w+$/, '')
        .replace(/^decimal\((\d+), (\d+)\)$/, 'decimal($1,$2)')
        .replace(/', '/g, "','")
  }
}

const text = (value: unknown): string => String(value)

function byTable(rows: readonly Row[], table: string): Row[] {
  return rows.filter((row) => row['table'] === table)
}

async function introspectSqlite(connection: Connection): Promise<LiveTable[]> {
  const { rows: tables } = await connection.run(
    sql`SELECT ${sql.id('name')} FROM ${sql.id('sqlite_master')} WHERE ${sql.id('type')} = ${'table'} AND ${sql.id('name')} NOT LIKE ${'sqlite_%'} AND ${sql.id('name')} <> ${MIGRATIONS_TABLE} ORDER BY ${sql.id('name')}`,
  )
  const result: LiveTable[] = []
  for (const { name } of tables) {
    const table = text(name)
    const columns = (await connection.run(sql`SELECT * FROM pragma_table_info(${table})`)).rows
    const indexList = (await connection.run(sql`SELECT * FROM pragma_index_list(${table})`)).rows
    const keys = (await connection.run(sql`SELECT * FROM pragma_foreign_key_list(${table})`)).rows
    const indexes: LiveIndex[] = []
    // origin 'c' = CREATE INDEX; 'pk' / 'u' are implicit and not part of the declared schema.
    for (const index of indexList.filter((row) => row['origin'] === 'c')) {
      const info = (
        await connection.run(sql`SELECT * FROM pragma_index_info(${text(index['name'])})`)
      ).rows
      indexes.push({
        name: text(index['name']),
        unique: Number(index['unique']) === 1,
        columns: [...info]
          .sort((a, b) => Number(a['seqno']) - Number(b['seqno']))
          .map((row) => text(row['name'])),
      })
    }
    const grouped = new Map<number, Row[]>()
    for (const row of keys) {
      const id = Number(row['id'])
      grouped.set(id, [...(grouped.get(id) ?? []), row])
    }
    result.push({
      name: table,
      columns: columns.map((row) => ({
        name: text(row['name']),
        type: text(row['type']).toLowerCase(),
        nullable: Number(row['notnull']) === 0 && Number(row['pk']) === 0,
      })),
      indexes,
      foreignKeys: [...grouped.values()].map((parts) => {
        const ordered = [...parts].sort((a, b) => Number(a['seq']) - Number(b['seq']))
        return {
          columns: ordered.map((row) => text(row['from'])),
          table: text(ordered[0]?.['table']),
          references: ordered.map((row) => text(row['to'])),
          onDelete: text(ordered[0]?.['on_delete']).toLowerCase() as ReferentialAction,
        }
      }),
    })
  }
  return result
}

const PG_DELETE_RULES: Readonly<Record<string, ReferentialAction>> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
}

async function introspectPostgres(connection: Connection): Promise<LiveTable[]> {
  const { rows: columns } = await connection.run(sql`
    SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS "type", NOT a.attnotnull AS "nullable"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> ${MIGRATIONS_TABLE}
    ORDER BY c.relname, a.attnum`)
  const { rows: indexes } = await connection.run(sql`
    SELECT t.relname AS "table", i.relname AS "name", ix.indisunique AS "unique",
           string_agg(a.attname, ',' ORDER BY k.ord) AS "columns"
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND NOT ix.indisprimary AND t.relname <> ${MIGRATIONS_TABLE}
    GROUP BY t.relname, i.relname, ix.indisunique
    ORDER BY t.relname, i.relname`)
  const { rows: keys } = await connection.run(sql`
    SELECT tc.relname AS "table", rt.relname AS "references_table", c.confdeltype AS "on_delete",
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "columns",
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS "references_columns"
    FROM pg_constraint c
    JOIN pg_class tc ON tc.oid = c.conrelid
    JOIN pg_class rt ON rt.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
    WHERE c.contype = 'f' AND n.nspname = current_schema()
    ORDER BY tc.relname, c.conname`)
  const tableNames = [...new Set(columns.map((row) => text(row['table'])))].sort()
  return tableNames.map((table) => ({
    name: table,
    columns: byTable(columns, table).map((row) => ({
      name: text(row['column']),
      type: text(row['type']).toLowerCase(),
      nullable: row['nullable'] === true,
    })),
    indexes: byTable(indexes, table).map((row) => ({
      name: text(row['name']),
      unique: row['unique'] === true,
      columns: text(row['columns']).split(','),
    })),
    foreignKeys: byTable(keys, table).map((row) => ({
      columns: text(row['columns']).split(','),
      table: text(row['references_table']),
      references: text(row['references_columns']).split(','),
      onDelete: PG_DELETE_RULES[text(row['on_delete'])] ?? 'no action',
    })),
  }))
}

async function introspectMysql(connection: Connection): Promise<LiveTable[]> {
  const { rows: columns } = await connection.run(sql`
    SELECT TABLE_NAME AS ${sql.id('table')}, COLUMN_NAME AS ${sql.id('column')}, COLUMN_TYPE AS ${sql.id('type')}, IS_NULLABLE AS ${sql.id('nullable')}
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> ${MIGRATIONS_TABLE}
    ORDER BY TABLE_NAME, ORDINAL_POSITION`)
  const { rows: statistics } = await connection.run(sql`
    SELECT TABLE_NAME AS ${sql.id('table')}, INDEX_NAME AS ${sql.id('name')}, NON_UNIQUE AS ${sql.id('non_unique')}, COLUMN_NAME AS ${sql.id('column')}
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY' AND TABLE_NAME <> ${MIGRATIONS_TABLE}
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)
  const { rows: keyColumns } = await connection.run(sql`
    SELECT k.TABLE_NAME AS ${sql.id('table')}, k.CONSTRAINT_NAME AS ${sql.id('name')}, k.COLUMN_NAME AS ${sql.id('column')},
           k.REFERENCED_TABLE_NAME AS ${sql.id('references_table')}, k.REFERENCED_COLUMN_NAME AS ${sql.id('references_column')},
           r.DELETE_RULE AS ${sql.id('on_delete')}
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`)
  const tableNames = [...new Set(columns.map((row) => text(row['table'])))].sort()
  return tableNames.map((table) => {
    const keys = new Map<string, Row[]>()
    for (const row of byTable(keyColumns, table)) {
      const name = text(row['name'])
      keys.set(name, [...(keys.get(name) ?? []), row])
    }
    const indexes = new Map<string, LiveIndex>()
    for (const row of byTable(statistics, table)) {
      const name = text(row['name'])
      // InnoDB creates an index named after a foreign key when none covers its columns: it is the
      // engine's, not part of the declared schema.
      if (keys.has(name)) continue
      const known = indexes.get(name)
      indexes.set(name, {
        name,
        unique: Number(row['non_unique']) === 0,
        columns: [...(known?.columns ?? []), text(row['column'])],
      })
    }
    return {
      name: table,
      columns: byTable(columns, table).map((row) => ({
        name: text(row['column']),
        // MariaDB (and MySQL before 8.0.19) report display widths, `bigint(20) unsigned`; they
        // carry no meaning (only `tinyint(1)` marks a boolean), so they are dropped.
        type: text(row['type'])
          .toLowerCase()
          .replace(/^(bigint|int|smallint|mediumint)\(\d+\)/, '$1'),
        nullable: text(row['nullable']) === 'YES',
      })),
      indexes: [...indexes.values()],
      foreignKeys: [...keys.values()].map((parts) => ({
        columns: parts.map((row) => text(row['column'])),
        table: text(parts[0]?.['references_table']),
        references: parts.map((row) => text(row['references_column'])),
        onDelete: text(parts[0]?.['on_delete']).toLowerCase() as ReferentialAction,
      })),
    }
  })
}
