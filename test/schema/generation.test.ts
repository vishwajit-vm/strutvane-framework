/**
 * Generated files: golden copies, determinism, and the "stays in sync after migrate" promise,
 * proven with the real TypeScript compiler.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { buildArtifacts, writeArtifacts } from '../../src/schema/generate/artifacts.ts'
import { migration } from '../../src/schema/migration.ts'
import { replayMigrations } from '../../src/schema/replay.ts'
import {
  BLOG_ARTIFACTS,
  BLOG_ROOT,
  cleanupTempDirs,
  copyMigrations,
  makeTempDir,
  migrationSource,
  REPO_ROOT,
  replayApp,
  SCHEMA_TESTS,
} from './helpers.ts'

const GENERATE = join(SCHEMA_TESTS, 'scripts', 'generate.ts')

afterAll(cleanupTempDirs)

const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc')

function tsc(project: string): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [TSC, '--noEmit', '-p', join(project, 'tsconfig.json')],
    { encoding: 'utf8' },
  )
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('golden files', () => {
  test('the committed fixtures/blog/.strutvane output is exactly what the generator produces', async () => {
    const files = buildArtifacts(await replayApp(BLOG_ROOT), {}, BLOG_ARTIFACTS)
    expect([...files.keys()]).toEqual([
      '.strutvane/resources.json',
      '.strutvane/schema.json',
      '.strutvane/sql/migrations.mariadb.sql',
      '.strutvane/sql/migrations.mysql.sql',
      '.strutvane/sql/migrations.postgres.sql',
      '.strutvane/sql/migrations.sqlite.sql',
      '.strutvane/sql/schema.mariadb.sql',
      '.strutvane/sql/schema.mysql.sql',
      '.strutvane/sql/schema.postgres.sql',
      '.strutvane/sql/schema.sqlite.sql',
      '.strutvane/types/models.d.ts',
    ])
    for (const [path, content] of files) {
      // After an intended change: node test/schema/scripts/generate.ts test/schema/fixtures/blog --fixture
      expect(readFileSync(join(BLOG_ROOT, path), 'utf8').replace(/\r\n/g, '\n'), path).toBe(content)
    }
  })

  test('output is deterministic and portable: same bytes twice, LF only, no machine paths', async () => {
    const first = buildArtifacts(await replayApp(BLOG_ROOT))
    const second = buildArtifacts(await replayApp(BLOG_ROOT))
    expect([...second]).toEqual([...first])
    for (const content of first.values()) {
      expect(content).not.toContain('\r')
      expect(content).not.toContain(REPO_ROOT)
      expect(content).not.toMatch(/[A-Z]:\\/)
    }
  })

  test('writeArtifacts only touches files whose content changed', async () => {
    const app = makeTempDir('write')
    const files = buildArtifacts(await replayApp(BLOG_ROOT))
    expect(writeArtifacts(app, files)).toHaveLength(11)
    expect(writeArtifacts(app, files)).toEqual([])
  })

  test('the CLI script works in plain Node and reports that nothing changed', () => {
    const result = spawnSync(process.execPath, [GENERATE, BLOG_ROOT, '--fixture'], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Replayed 7 migrations into 4 tables.')
    expect(result.stdout).toContain('Everything was already up to date.')
  })

  test('the CLI prints a friendly error for a broken migration and exits 1', () => {
    const app = makeTempDir('broken')
    copyMigrations(BLOG_ROOT, app)
    writeFileSync(
      join(app, 'database', 'migrations', '2026_01_08_000000_typo.ts'),
      migrationSource("schema.table('post', (t) => { t.string('x').nullable() })", ''),
    )
    const result = spawnSync(process.execPath, [GENERATE, app], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '[unknown_table] in 2026_01_08_000000_typo.ts: There is no table "post"',
    )
    expect(result.stderr).toContain('Hint: Known tables: users, posts, categories, tags.')
  })
})

describe('types stay in sync with migrations (real tsc)', () => {
  test('after a migration renames and drops columns, regenerated types turn stale code into compile errors', async () => {
    const app = makeTempDir('sync')
    copyMigrations(BLOG_ROOT, app)
    // The stand-in for the ORM module, and the type-only project: kept outside `database/`, whose
    // migrations Vitest imports (a tsconfig there would be read for them too).
    const types = join(app, 'check')
    mkdirSync(types)
    writeFileSync(
      join(app, 'registry.ts'),
      'export type JsonValue = unknown\nexport interface TableRegistry {}\n',
    )
    writeFileSync(
      join(types, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['consumer.ts', '../.strutvane/types/*.d.ts'],
      }),
    )
    writeFileSync(
      join(types, 'consumer.ts'),
      `import type { Post } from '../.strutvane/types/models.d.ts'
export function summary(post: Post): string {
  return [post.title, post.subtitle ?? '', post.content ?? ''].join(' ')
}
`,
    )
    const options = { modelModule: '../../registry.ts' }
    writeArtifacts(app, buildArtifacts(await replayApp(app), {}, options))
    const before = tsc(types)
    expect(before.output).toBe('')
    expect(before.status).toBe(0)

    // A new migration, like `node strut make:migration tidy_posts_table` would start it.
    writeFileSync(
      join(app, 'database', 'migrations', '2026_01_08_000000_tidy_posts_table.ts'),
      migrationSource(
        "schema.table('posts', (t) => { t.dropColumn('subtitle'); t.renameColumn('content', 'body_html') })",
        "schema.table('posts', (t) => { t.renameColumn('body_html', 'content'); t.string('subtitle').nullable() })",
      ),
    )
    // Before `node strut migrate` regenerates, the stale types still compile: this is why migrate must regenerate.
    expect(tsc(types).status).toBe(0)

    writeArtifacts(app, buildArtifacts(await replayApp(app), {}, options))
    const after = tsc(types)
    expect(after.status).not.toBe(0)
    expect(after.output).toContain(
      "consumer.ts(3,28): error TS2339: Property 'subtitle' does not exist on type 'Post'.",
    )
    expect(after.output).toContain(
      "consumer.ts(3,49): error TS2339: Property 'content' does not exist on type 'Post'.",
    )
  })
})

describe('fixture migrations compile as an app would write them', () => {
  test('every fixture migration type-checks under the strict settings (without isolatedDeclarations)', () => {
    // The root tsconfig leaves them out: `export default migration({…})` is how apps write it, and
    // isolatedDeclarations (a library setting) wants an explicit type on every default export.
    const dir = makeTempDir('fixtures-tsc')
    const slash = (path: string): string => path.replace(/\\/g, '/')
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: slash(join(REPO_ROOT, 'tsconfig.base.json')),
        compilerOptions: {
          types: ['node'],
          typeRoots: [slash(join(REPO_ROOT, 'node_modules', '@types'))],
          isolatedDeclarations: false,
          declaration: false,
          declarationMap: false,
        },
        include: [slash(join(SCHEMA_TESTS, 'fixtures'))],
      }),
    )
    const result = tsc(dir)
    expect(result.output).toBe('')
    expect(result.status).toBe(0)
  })
})

describe('atomic writes survive Windows sharing errors and never leave temp files', () => {
  test('a transient EPERM on rename is retried; a lasting one fails and removes the temp file', () => {
    const app = mkdtempSync(join(tmpdir(), 'sv-atomic-'))
    try {
      // On Windows a file that an antivirus scanner or an editor has open for a moment refuses to
      // be replaced (EPERM/EBUSY): the write failed outright and left `<file>.<pid>.tmp` behind.
      let failures = 2
      const flaky = (from: string, to: string): void => {
        if (failures > 0) {
          failures -= 1
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
            code: 'EPERM',
          })
        }
        renameSync(from, to)
      }
      expect(
        writeArtifacts(app, new Map([['.strutvane/a.txt', 'one']]), { rename: flaky }),
      ).toEqual(['.strutvane/a.txt'])
      expect(readFileSync(join(app, '.strutvane/a.txt'), 'utf8')).toBe('one')
      const locked = (): void => {
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
      }
      expect(() =>
        writeArtifacts(app, new Map([['.strutvane/a.txt', 'two']]), { rename: locked }),
      ).toThrow(/EBUSY/)
      expect(readFileSync(join(app, '.strutvane/a.txt'), 'utf8')).toBe('one')
      expect(readdirSync(join(app, '.strutvane')).filter((name) => name.endsWith('.tmp'))).toEqual(
        [],
      )
      // A real permission problem is not retried forever: other errors fail at once.
      let calls = 0
      const denied = (): void => {
        calls += 1
        throw Object.assign(new Error('ENOENT: no such file or directory, rename'), {
          code: 'ENOENT',
        })
      }
      expect(() =>
        writeArtifacts(app, new Map([['.strutvane/a.txt', 'three']]), { rename: denied }),
      ).toThrow(/ENOENT/)
      expect(calls).toBe(1)
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})

describe('an app that only runs on PostgreSQL or SQLite may index TEXT', () => {
  test('the MySQL and MariaDB files explain why they were not generated, the others are complete', () => {
    const replay = replayMigrations([
      {
        name: '2026_01_01_000000_create_notes_table',
        migration: migration({
          up(schema) {
            schema.create('notes', (t) => {
              t.id()
              t.text('body').index()
            })
          },
          down(schema) {
            schema.dropIfExists('notes')
          },
        }),
      },
    ])
    const files = buildArtifacts(replay)
    expect(files.get('.strutvane/sql/schema.mysql.sql')).toMatch(
      /^-- Not generated for mysql: .*TEXT/,
    )
    expect(files.get('.strutvane/sql/migrations.mariadb.sql')).toMatch(
      /^-- Not generated for mariadb: /,
    )
    expect(files.get('.strutvane/sql/schema.postgres.sql')).toContain(
      'CREATE INDEX "notes_body_index"',
    )
  })
})
