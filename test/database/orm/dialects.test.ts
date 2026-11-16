/**
 * Engine differences the ORM hides, and the MySQL traps it defends against (security review F-08).
 * The "evidence" tests record what the raw engine does, so the README's claims are checked on
 * every run rather than remembered.
 */
import { describe, expect, test } from 'vitest'
import { CastError, type Connection, detectMysqlServer, sql } from '../../../src/database/index.ts'
import { grammarFor } from '../../../src/database/sql/grammar.ts'
import { Post } from './fixtures/app/models/post.ts'
import { Tag } from './fixtures/app/models/tag.ts'
import { User } from './fixtures/app/models/user.ts'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeUser } from './support/seed.ts'

/** Count statements sent while `fn` runs. */
async function statementsDuring(
  connection: Connection,
  fn: () => Promise<unknown>,
): Promise<number> {
  let count = 0
  const stop = connection.onQuery(() => {
    count += 1
  })
  try {
    await fn().catch(() => undefined)
  } finally {
    stop()
  }
  return count
}

function suite(engine: Engine): void {
  const connection = useEngine(engine)

  test('typed binds: wrong-typed values are refused before any SQL is sent', async () => {
    await makeUser('Ada')
    const db = connection()
    // MySQL would compare '1abc' = 1 and 0 = 'abc' as true; we never let it get that far.
    const attempts: readonly (() => Promise<unknown>)[] = [
      async () => Post.query().filter('id', 'eq', '1abc').get(),
      async () => User.query().filter('email', 'eq', 0).get(),
      async () => User.query().filter('email', 'eq', { $ne: null }).get(),
      async () =>
        User.query()
          .filter('email', 'in', [['a']])
          .get(),
      async () => Post.query().filter('author_id', 'eq', true).get(),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(CastError)
      expect(await statementsDuring(db, attempt)).toBe(0)
    }
    // Digits from a URL are fine: '/posts/7' is a real id.
    expect(await Post.query().filter('id', 'eq', '7').count()).toBe(0)
  })

  test('identifier-like values match exactly: case, accents and padding never find another row', async () => {
    const ada = await makeUser('Ada')
    const post = await makePost(ada, 'Resume')
    expect(post.slug).toBe('resume')
    for (const lookalike of ['RESUME', 'résumé', 'resume ', 'Resume']) {
      expect(await Post.query().where('slug', lookalike).count()).toBe(0)
    }
    // Emails are normalised by the model cast on write *and* on lookup, so the real one is found.
    expect((await User.query().where('email', '  ADA@Example.TEST ').firstOrFail()).id).toBe(ada.id)
    expect(await User.query().where('email', 'ada@example.test ').count()).toBe(1)
    expect(await User.query().where('email', 'adà@example.test').count()).toBe(0)
  })

  test('timestamps are stored and read back as the same UTC instant', async () => {
    const ada = await makeUser('Ada')
    const instant = new Date('2026-03-29T01:30:00.123Z') // a DST switch night in Europe
    ada.created_at = instant
    await ada.save()
    expect((await User.findOrFail(ada.id)).created_at?.toISOString()).toBe(
      '2026-03-29T01:30:00.123Z',
    )
  })

  if (engine.dialect === 'mysql') {
    test('MySQL evidence: no RETURNING, implicit conversion, and the session the driver pins', async () => {
      const db = connection()
      await expect(
        db.run(sql`INSERT INTO ${sql.id('tags')} (${sql.id('name')}) VALUES (${'x'}) RETURNING *`),
      ).rejects.toThrow(/syntax/i)
      const { rows } = await db.run(sql`SELECT ${'1abc'} = 1 AS loose, ${'abc'} = 0 AS zero`)
      expect([Number(rows[0]?.['loose']), Number(rows[0]?.['zero'])]).toEqual([1, 1])
      const session = await db.run(
        sql`SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS tz, @@VERSION AS version`,
      )
      expect(String(session.rows[0]?.['mode'])).toContain('STRICT_ALL_TABLES')
      expect(session.rows[0]?.['tz']).toBe('+00:00')
      expect(String(session.rows[0]?.['version'])).toMatch(/^8\.4\./)
    })

    test('MySQL: the default collation is the trap the binary columns avoid', async () => {
      const { rows } = await connection().run(
        sql`SELECT ${'ADMIN@x'} = ${'admin@x'} COLLATE utf8mb4_0900_ai_ci AS case_folded, ${'résumé'} = ${'resume'} COLLATE utf8mb4_0900_ai_ci AS accent_folded`,
      )
      expect([Number(rows[0]?.['case_folded']), Number(rows[0]?.['accent_folded'])]).toEqual([1, 1])
    })
  }

  if (engine.dialect === 'mysql' || engine.dialect === 'mariadb') {
    test('MySQL family: strict sql_mode turns truncation into an error instead of silent data loss', async () => {
      await expect(
        connection().run(
          sql`INSERT INTO ${sql.id('tags')} (${sql.id('name')}) VALUES (${'x'.repeat(51)})`,
        ),
      ).rejects.toThrow(/too long/i)
    })

    test('MySQL family: LIMIT and OFFSET work as bound integers in server-side prepared statements', async () => {
      const ada = await makeUser('Ada')
      for (const title of ['a', 'b', 'c']) await makePost(ada, title)
      expect(
        (await Post.query().orderBy('title').limit(1).offset(1).get()).map((post) => post.title),
      ).toEqual(['b'])
      expect(Post.query().limit(1).toSql().sql).toMatch(/LIMIT \?/)
    })
  }

  if (engine.dialect === 'mariadb') {
    test('MariaDB evidence: detected from VERSION(), INSERT RETURNING yes, UPDATE RETURNING no, the pinned session', async () => {
      const db = connection()
      expect(db.grammar.dialect).toBe('mariadb')
      const session = await db.run(
        sql`SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS tz, @@VERSION AS version, @@collation_server AS server_collation`,
      )
      expect(String(session.rows[0]?.['version'])).toMatch(/^11\.4\..*MariaDB/i)
      expect(String(session.rows[0]?.['mode'])).toContain('STRICT_ALL_TABLES')
      expect(session.rows[0]?.['tz']).toBe('+00:00')
      // The server default folds case and accents, like MySQL's ai_ci: identifier columns need utf8mb4_nopad_bin.
      expect(session.rows[0]?.['server_collation']).toBe('utf8mb4_uca1400_ai_ci')
      const inserted = await db.run(
        sql`INSERT INTO ${sql.id('tags')} (${sql.id('name')}) VALUES (${'returned'}) RETURNING ${sql.id('id')}`,
      )
      expect(Number(inserted.rows[0]?.['id'])).toBeGreaterThan(0)
      await expect(
        db.run(
          sql`UPDATE ${sql.id('tags')} SET ${sql.id('name')} = ${'x'} RETURNING ${sql.id('id')}`,
        ),
      ).rejects.toThrow(/syntax/i)
      // So the ORM inserts with RETURNING (one statement) and updates with a re-select.
      let statements = 0
      const stop = db.onQuery(() => {
        statements += 1
      })
      try {
        const tag = await Tag.create({ name: 'one statement' })
        expect(statements).toBe(1)
        tag.name = 'renamed'
        await tag.save()
        expect(statements).toBe(3)
        expect((await Tag.findOrFail(tag.id)).name).toBe('renamed')
      } finally {
        stop()
      }
    })

    test('MariaDB evidence: JSON is LONGTEXT with a JSON_VALID check, and the ORM reads it like MySQL JSON', async () => {
      const db = connection()
      const type = await db.run(
        sql`SELECT DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${'posts'} AND COLUMN_NAME = ${'meta'}`,
      )
      expect(String(type.rows[0]?.['type']).toLowerCase()).toBe('longtext')
      const ada = await makeUser('Ada')
      await expect(
        db.run(
          sql`INSERT INTO ${sql.id('posts')} (${sql.id('title')}, ${sql.id('slug')}, ${sql.id('author_id')}, ${sql.id('meta')}) VALUES (${'Bad'}, ${'bad'}, ${ada.id}, ${'{not json'})`,
        ),
      ).rejects.toThrow()
      const post = await makePost(ada, 'Meta')
      post.fill({ meta: { tags: ['maria'], pinned: true } })
      await post.save()
      expect((await Post.findOrFail(post.id)).meta).toEqual({ tags: ['maria'], pinned: true })
    })
  }
}

describe('the MySQL-family version-detection hook', () => {
  test('tells MySQL from MariaDB, and old MariaDB without RETURNING from new', () => {
    expect(detectMysqlServer('8.4.13')).toEqual({ dialect: 'mysql' })
    expect(detectMysqlServer('11.4.13-MariaDB-ubu2404')).toEqual({
      dialect: 'mariadb',
      insertReturning: true,
    })
    expect(detectMysqlServer('10.5.0-MariaDB')).toEqual({
      dialect: 'mariadb',
      insertReturning: true,
    })
    // XAMPP 8.2 ships MariaDB 10.4; old handshakes prefix "5.5.5-".
    expect(detectMysqlServer('10.4.32-MariaDB')).toEqual({
      dialect: 'mariadb',
      insertReturning: false,
    })
    expect(detectMysqlServer('5.5.5-10.4.32-MariaDB')).toEqual({
      dialect: 'mariadb',
      insertReturning: false,
    })
    expect(grammarFor('mariadb', { insertReturning: false }).supportsReturning).toBe(false)
    expect(grammarFor('mariadb').supportsReturning).toBe(true)
    expect(grammarFor('mariadb').supportsUpdateReturning).toBe(false)
    expect(grammarFor('mariadb').render(sql`SELECT ${sql.id('a')} = ${1}`)).toEqual({
      sql: 'SELECT `a` = ?',
      params: [1],
    })
  })
})

describe.each(engines)('dialects on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
