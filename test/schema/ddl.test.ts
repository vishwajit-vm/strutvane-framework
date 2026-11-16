/**
 * SQL generation details that differ per engine, checked as text. Running the SQL for real is in
 * `database.test.ts`; MySQL can only be checked here (no engine in the spike, so *(unverified)*).
 */
import { describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import { type ColumnDef, EMPTY_SCHEMA, type SchemaState } from '../../src/schema/columns.ts'
import {
  columnSql,
  columnType,
  compileOperations,
  createSchemaSql,
} from '../../src/schema/ddl/ddl.ts'
import { type Dialect, SqlParams, sqlLiteral } from '../../src/schema/ddl/dialect.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { recordOperations, type SchemaBuilder } from '../../src/schema/migration.ts'

function state(up: (schema: SchemaBuilder) => void, from: SchemaState = EMPTY_SCHEMA): SchemaState {
  return applyOperations(from, recordOperations(up, from))
}

function compile(
  from: SchemaState,
  up: (schema: SchemaBuilder) => void,
  dialect: Dialect,
): string[] {
  return compileOperations(from, recordOperations(up, from), dialect)
}

const base = state((schema) => {
  schema.create('users', (t) => t.id())
  schema.create('posts', (t) => {
    t.id()
    t.string('title')
    t.string('code').nullable().index()
    t.foreignId('author_id').nullable().constrained('users').nullOnDelete()
  })
})

describe('column types per engine', () => {
  test.each([
    ['sqlite', '"price" NUMERIC NOT NULL DEFAULT 0 CHECK (abs("price") < 10000000000)'],
    ['postgres', '"price" NUMERIC(12, 2) NOT NULL DEFAULT 0'],
    ['mysql', '`price` DECIMAL(12, 2) NOT NULL DEFAULT 0'],
  ] as const)('decimal on %s', (dialect, sql) => {
    expect(
      columnSql(
        { name: 'price', kind: 'decimal', nullable: false, precision: 12, scale: 2, default: 0 },
        dialect,
      ),
    ).toBe(sql)
  })

  test.each([
    [
      'sqlite',
      "\"status\" VARCHAR(255) NOT NULL DEFAULT 'draft' CHECK (\"status\" IN ('draft', 'published'))",
    ],
    [
      'postgres',
      "\"status\" VARCHAR(255) NOT NULL DEFAULT 'draft' CHECK (\"status\" IN ('draft', 'published'))",
    ],
    ['mysql', "`status` ENUM('draft', 'published') NOT NULL DEFAULT 'draft'"],
  ] as const)('enum on %s', (dialect, sql) => {
    expect(
      columnSql(
        {
          name: 'status',
          kind: 'enum',
          nullable: false,
          values: ['draft', 'published'],
          default: 'draft',
        },
        dialect,
      ),
    ).toBe(sql)
  })

  test('booleans: native in PostgreSQL, 0/1 elsewhere', () => {
    const column = { name: 'featured', kind: 'boolean', nullable: false, default: false } as const
    expect(columnSql(column, 'postgres')).toBe('"featured" BOOLEAN NOT NULL DEFAULT FALSE')
    expect(columnSql(column, 'sqlite')).toBe('"featured" INTEGER NOT NULL DEFAULT 0')
    expect(columnSql(column, 'mysql')).toBe('`featured` TINYINT(1) NOT NULL DEFAULT 0')
  })

  test('MySQL timestamps are DATETIME(3): TIMESTAMP stops at 2038-01-19 and shifts with the session zone', () => {
    // Checked on MySQL 8.4.13 (2026-11-15): inserting 2040-01-01 into TIMESTAMP(3) is
    // "Incorrect datetime value" under the strict sql_mode the ORM pins; DATETIME(3) stores it.
    // Spike 11's ORM writes UTC text into DATETIME(3) and reads it back as UTC.
    const column: ColumnDef = { name: 'expires_at', kind: 'timestamp', nullable: true }
    expect(columnSql(column, 'mysql')).toBe('`expires_at` DATETIME(3) NULL')
    expect(columnType(column, 'postgres')).toBe('TIMESTAMP(3) WITH TIME ZONE')
  })

  test('literals are escaped for each engine', () => {
    expect(sqlLiteral("it's", 'postgres')).toBe("'it''s'")
    expect(sqlLiteral('a\\b', 'postgres')).toBe("'a\\b'")
    // A backslash means different things in MySQL depending on sql_mode: doubled it is one
    // backslash by default but two under NO_BACKSLASH_ESCAPES, which the ORM pins (checked on
    // MySQL 8.4.13 and MariaDB 11.4.13). Values that contain one are written as hex literals,
    // which mean the same bytes in every mode; quotes-only strings stay readable.
    expect(sqlLiteral('a\\b', 'mysql')).toBe("X'615c62'")
    expect(sqlLiteral('x\\', 'mariadb')).toBe("X'785c'")
    expect(sqlLiteral("it's", 'mysql')).toBe("'it''s'")
    expect(
      columnSql({ name: 'path', kind: 'string', nullable: false, default: 'C:\\temp' }, 'mysql'),
    ).toBe("`path` VARCHAR(255) NOT NULL DEFAULT X'433a5c74656d70'")
    expect(
      columnSql({ name: 'kind', kind: 'enum', nullable: false, values: ['a\\b', 'c'] }, 'mysql'),
    ).toBe("`kind` ENUM(X'615c62', 'c') NOT NULL")
    // COMMENT takes no hex literal: the backslash is doubled, which is valid SQL in both modes
    // (a comment can never end the string early); under NO_BACKSLASH_ESCAPES it shows doubled.
    expect(sqlLiteral('a\\b', 'mysql', 'comment')).toBe("'a\\\\b'")
    expect(() => sqlLiteral(Number.NaN, 'sqlite')).toThrow(/finite/)
  })

  test('placeholders: $n for PostgreSQL, ?n for SQLite, ? for MySQL', () => {
    const pg = new SqlParams('postgres')
    expect([pg.add(1), pg.add('a')]).toEqual(['$1', '$2'])
    const lite = new SqlParams('sqlite')
    expect([lite.add(1), lite.add('a')]).toEqual(['?1', '?2'])
    expect(lite.values).toEqual([1, 'a'])
    const mysql = new SqlParams('mysql')
    expect([mysql.add(1), mysql.add('a')]).toEqual(['?', '?'])
  })

  test('comments: PostgreSQL uses COMMENT ON, MySQL inline, SQLite drops them', () => {
    const commented = state((schema) =>
      schema.create('notes', (t) => {
        t.id()
        t.text('body').comment("Owner's notes")
      }),
    )
    expect(createSchemaSql(commented, 'postgres')).toContain(
      `COMMENT ON COLUMN "notes"."body" IS 'Owner''s notes'`,
    )
    expect(createSchemaSql(commented, 'mysql').join('\n')).toContain(
      "`body` TEXT NOT NULL COMMENT 'Owner''s notes'",
    )
    expect(createSchemaSql(commented, 'sqlite').join('\n')).not.toContain('Owner')
  })
})

describe('engine-specific ALTER handling', () => {
  test('MySQL foreign keys are separate constraints (inline REFERENCES is silently ignored there)', () => {
    const sql = createSchemaSql(base, 'mysql').join('\n')
    expect(sql).toContain(
      'CONSTRAINT `posts_author_id_foreign` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE SET NULL',
    )
    expect(sql).not.toMatch(/`author_id` BIGINT UNSIGNED NULL REFERENCES/)
  })

  test('dropping an indexed column: SQLite drops the index first, PostgreSQL lets the engine do it', () => {
    const drop = (schema: SchemaBuilder): void => schema.table('posts', (t) => t.dropColumn('code'))
    expect(compile(base, drop, 'sqlite')).toEqual([
      'DROP INDEX "posts_code_index"',
      'ALTER TABLE "posts" DROP COLUMN "code"',
    ])
    expect(compile(base, drop, 'postgres')).toEqual(['ALTER TABLE "posts" DROP COLUMN "code"'])
  })

  test('dropping a foreign key column: MySQL drops the constraint first, SQLite rebuilds the table', () => {
    const drop = (schema: SchemaBuilder): void =>
      schema.table('posts', (t) => t.dropConstrainedForeignId('author_id'))
    expect(compile(base, drop, 'mysql')).toEqual([
      'ALTER TABLE `posts` DROP FOREIGN KEY `posts_author_id_foreign`',
      'ALTER TABLE `posts` DROP COLUMN `author_id`',
    ])
    const sqlite = compile(base, drop, 'sqlite')
    expect(sqlite[0]).toMatch(/^CREATE TABLE "__strutvane_rebuild_posts"/)
    expect(sqlite.slice(1)).toEqual([
      'INSERT INTO "__strutvane_rebuild_posts" ("id", "title", "code") SELECT "id", "title", "code" FROM "posts"',
      'DROP TABLE "posts"',
      'ALTER TABLE "__strutvane_rebuild_posts" RENAME TO "posts"',
      'CREATE INDEX "posts_code_index" ON "posts" ("code")',
    ])
  })

  test('SQLite refuses a rebuild that could cascade into child tables (fail closed)', () => {
    const withChildren = state((schema) => {
      schema.create('comments', (t) => {
        t.id()
        t.foreignId('post_id').constrained('posts').cascadeOnDelete()
      })
    }, base)
    const drop = (schema: SchemaBuilder): void =>
      schema.table('posts', (t) => t.dropConstrainedForeignId('author_id'))
    expect(() => compile(withChildren, drop, 'sqlite')).toThrow(SchemaError)
    expect(() => compile(withChildren, drop, 'sqlite')).toThrow(/"comments" points at it/)
    // PostgreSQL drops the column in place, so there is nothing to refuse.
    expect(compile(withChildren, drop, 'postgres')).toEqual([
      'ALTER TABLE "posts" DROP COLUMN "author_id"',
    ])
  })

  test('MariaDB: MySQL DDL with explicit JSON checks, NO PAD binary slugs and CHANGE COLUMN renames', () => {
    // Checked on MariaDB 11.4.13 (2026-11-15): JSON is only an alias of LONGTEXT; the default
    // collation (utf8mb4_uca1400_ai_ci) folds case and accents, and utf8mb4_bin is PAD SPACE
    // ('resume ' = 'resume'); RENAME COLUMN needs 10.5.2, but XAMPP 8.2 ships 10.4.
    const json: ColumnDef = { name: 'meta', kind: 'json', nullable: true }
    expect(columnSql(json, 'mariadb')).toBe(
      '`meta` LONGTEXT COLLATE utf8mb4_nopad_bin NULL CHECK (JSON_VALID(`meta`))',
    )
    expect(columnSql({ name: 'slug', kind: 'slug', nullable: false }, 'mariadb')).toBe(
      '`slug` VARCHAR(255) COLLATE utf8mb4_nopad_bin NOT NULL',
    )
    expect(columnSql({ name: 'expires_at', kind: 'timestamp', nullable: true }, 'mariadb')).toBe(
      '`expires_at` DATETIME(3) NULL',
    )
    const rename = (schema: SchemaBuilder): void =>
      schema.table('posts', (t) => t.renameColumn('title', 'headline'))
    expect(compile(base, rename, 'mariadb')).toEqual([
      'ALTER TABLE `posts` CHANGE COLUMN `title` `headline` VARCHAR(255) NOT NULL',
    ])
    expect(compile(base, rename, 'mysql')).toEqual([
      'ALTER TABLE `posts` RENAME COLUMN `title` TO `headline`',
    ])
    // Foreign keys are named constraints, exactly as on MySQL.
    expect(createSchemaSql(base, 'mariadb').join('\n')).toContain(
      'CONSTRAINT `posts_author_id_foreign` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`)',
    )
  })

  test('MySQL drops a foreign key by the name it was created with, after table and column renames', () => {
    // MySQL keeps a constraint's name when its table or column is renamed. The name used to be
    // derived from the *current* names at drop time, so after labels → tags the migration ran
    // DROP FOREIGN KEY tags_owner_id_foreign: "Can't DROP … check that column/key exists"
    // (checked on MySQL 8.4.13), leaving a half-applied migration (MySQL DDL isn't transactional).
    const withOwner = state((schema) => {
      schema.create('labels', (t) => {
        t.id()
        t.foreignId('owner_id').nullable().constrained('users').nullOnDelete()
      })
      schema.rename('labels', 'tags')
    }, base)
    const drop = (schema: SchemaBuilder): void =>
      schema.table('tags', (t) => t.dropConstrainedForeignId('owner_id'))
    expect(compile(withOwner, drop, 'mysql')).toEqual([
      'ALTER TABLE `tags` DROP FOREIGN KEY `labels_owner_id_foreign`',
      'ALTER TABLE `tags` DROP COLUMN `owner_id`',
    ])
    const renamedColumn = state(
      (schema) => schema.table('posts', (t) => t.renameColumn('author_id', 'writer_id')),
      base,
    )
    const dropWriter = (schema: SchemaBuilder): void =>
      schema.table('posts', (t) => t.dropConstrainedForeignId('writer_id'))
    expect(compile(renamedColumn, dropWriter, 'mariadb')[0]).toBe(
      'ALTER TABLE `posts` DROP FOREIGN KEY `posts_author_id_foreign`',
    )
  })

  test('MySQL and MariaDB compare identifier-like columns byte for byte (security review F-08)', () => {
    // The defaults (MySQL utf8mb4_0900_ai_ci, MariaDB utf8mb4_uca1400_ai_ci) fold case and accents:
    // a reset request for 'JÖHN@x' matched 'john@x', and '/posts/RESUME' found 'resume'. Slugs,
    // UUIDs, emails, usernames and tokens get a binary NO PAD collation (MariaDB's utf8mb4_bin pads).
    const cases: readonly [ColumnDef, string, string][] = [
      [
        { name: 'slug', kind: 'slug', nullable: false },
        '`slug` VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL',
        '`slug` VARCHAR(255) COLLATE utf8mb4_nopad_bin NOT NULL',
      ],
      [
        { name: 'public_id', kind: 'uuid', nullable: false },
        '`public_id` CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL',
        '`public_id` CHAR(36) COLLATE utf8mb4_nopad_bin NOT NULL',
      ],
      [
        { name: 'email', kind: 'string', nullable: false },
        '`email` VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL',
        '`email` VARCHAR(255) COLLATE utf8mb4_nopad_bin NOT NULL',
      ],
      [
        { name: 'username', kind: 'string', nullable: false, length: 50 },
        '`username` VARCHAR(50) COLLATE utf8mb4_0900_bin NOT NULL',
        '`username` VARCHAR(50) COLLATE utf8mb4_nopad_bin NOT NULL',
      ],
      [
        { name: 'reset_token', kind: 'string', nullable: true },
        '`reset_token` VARCHAR(255) COLLATE utf8mb4_0900_bin NULL',
        '`reset_token` VARCHAR(255) COLLATE utf8mb4_nopad_bin NULL',
      ],
    ]
    for (const [column, mysql, mariadb] of cases) {
      expect(columnSql(column, 'mysql')).toBe(mysql)
      expect(columnSql(column, 'mariadb')).toBe(mariadb)
      expect(columnSql(column, 'postgres')).not.toContain('COLLATE')
    }
    // Ordinary text keeps the server's friendly, case-insensitive collation.
    expect(columnSql({ name: 'title', kind: 'string', nullable: false }, 'mysql')).toBe(
      '`title` VARCHAR(255) NOT NULL',
    )
  })

  test('offline lint: indexes MySQL and MariaDB would refuse at migrate time are a SchemaError with a fix', () => {
    // Checked on MySQL 8.4.13: an index on TEXT is "BLOB/TEXT column used in key specification
    // without a key length", and a unique VARCHAR(1000) is "Specified key was too long; max key
    // length is 3072 bytes" (utf8mb4 = 4 bytes per character). MySQL DDL isn't transactional, so
    // that used to fail half-way through a migration instead of offline.
    const textIndex = (schema: SchemaBuilder): void =>
      schema.create('notes', (t) => {
        t.id()
        t.text('body').index()
      })
    const longUnique = (schema: SchemaBuilder): void =>
      schema.create('links', (t) => {
        t.id()
        t.string('url', 1000).unique()
      })
    for (const dialect of ['mysql', 'mariadb'] as const) {
      for (const up of [textIndex, longUnique]) {
        let thrown: unknown
        try {
          compile(base, up, dialect)
        } catch (error) {
          thrown = error
        }
        expect(thrown, dialect).toBeInstanceOf(SchemaError)
        expect((thrown as SchemaError).code).toBe('INDEX_NOT_PORTABLE')
        expect((thrown as SchemaError).hint).toMatch(/VARCHAR\(768\)|shorter/)
      }
      // Within the limit, and on other engines, the same indexes are fine.
      expect(() =>
        compile(
          base,
          (schema) =>
            schema.create('links', (t) => {
              t.id()
              t.string('url', 768).unique()
            }),
          dialect,
        ),
      ).not.toThrow()
    }
    expect(() => compile(base, textIndex, 'postgres')).not.toThrow()
    expect(() => compile(base, longUnique, 'sqlite')).not.toThrow()
    // Added later with schema.table(): the same check.
    const later = state(
      (schema) =>
        schema.create('notes', (t) => {
          t.id()
          t.text('body').nullable()
        }),
      base,
    )
    expect(() =>
      compile(later, (schema) => schema.table('notes', (t) => t.index(['body'])), 'mysql'),
    ).toThrow(SchemaError)
  })

  test("table renames: ALTER … RENAME TO, except MySQL's RENAME TABLE", () => {
    const rename = (schema: SchemaBuilder): void => schema.rename('posts', 'articles')
    expect(compile(base, rename, 'postgres')).toEqual(['ALTER TABLE "posts" RENAME TO "articles"'])
    expect(compile(base, rename, 'mysql')).toEqual(['RENAME TABLE `posts` TO `articles`'])
  })

  test('schema dumps put parents first, even when the key was added by a later migration', () => {
    const later = state((schema) => {
      schema.create('categories', (t) => t.id())
      schema.table('posts', (t) => t.foreignId('category_id').nullable().constrained())
    }, base)
    // categories was created *after* posts, but posts now points at it.
    const order = createSchemaSql(later, 'postgres')
      .filter((sql) => sql.startsWith('CREATE TABLE'))
      .map((sql) => sql.split('"')[1])
    expect(order).toEqual(['users', 'categories', 'posts'])
  })

  test('a dump with a foreign key cycle explains how to break it', () => {
    const cycle = state((schema) => {
      schema.create('teams', (t) => t.id())
      schema.create('people', (t) => {
        t.id()
        t.foreignId('team_id').constrained()
      })
      schema.table('teams', (t) => t.foreignId('owner_id').nullable().constrained('people'))
    })
    expect(() => createSchemaSql(cycle, 'postgres')).toThrow(/point at each other in a circle/)
  })
})
