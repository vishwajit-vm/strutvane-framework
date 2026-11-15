/**
 * Builds a throwaway Strutvane project on disk (the same layout create-strutvane generates) whose
 * files import this repo's sources by absolute file URL, so runtime tests exercise the real
 * loader, boot path, migrator and commands without an install step.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = (path: string): string =>
  pathToFileURL(resolve(import.meta.dirname, '../../src', path)).href

/** Absolute import specifiers for the framework's entry points. */
export const IMPORTS: Readonly<
  Record<'framework' | 'provider' | 'http' | 'database' | 'testing', string>
> = {
  framework: src('index.ts'),
  provider: src('entries/provider.ts'),
  http: src('entries/http.ts'),
  database: src('entries/database.ts'),
  testing: src('testing/index.ts'),
}

/** The files of a minimal project; override or add any of them. */
export function projectFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'strutvane.config.ts': `import frameworkProvider from '${IMPORTS.provider}'
export default { app: { name: 'demo', preset: 'api' }, providers: [frameworkProvider] }
`,
    'config/app.ts': `export default { name: 'demo', env: 'local', port: 0 }
`,
    'config/database.ts': `export default {
  default: 'sqlite',
  connection: { filename: 'storage/database.sqlite' },
  migrations: { directory: 'database/migrations', table: 'strutvane_migrations' },
  seeders: { directory: 'database/seeders' },
}
`,
    'config/api.ts': `export default { prefix: '/api', version: 'v1', docs: true }
`,
    'app/models/invoice.model.ts': `import { defineModel, field } from '${IMPORTS.framework}'
export default defineModel('Invoice', {
  number: field.string().unique().filterable().sortable(),
  amount: field.decimal(12, 2).sortable(),
  status: field.enum(['draft', 'sent', 'paid']).default('draft').filterable(),
}, { timestamps: true })
`,
    'app/http/routes/api.ts': `import { route } from '${IMPORTS.http}'
export default [
  route.get('/hello', { public: true, handler: () => ({ message: 'hi' }) }),
  route.get('/private', { handler: (c) => ({ actor: c.actor?.id ?? null }) }),
  route.post('/echo', { public: true, handler: async (c) => c.json() }),
  route.delete('/nothing', { public: true, handler: () => undefined }),
  route.get('/reports/:year', { permission: 'report.view', handler: (c) => ({ year: c.params.year }) }),
]
`,
    'database/factories/invoice.factory.ts': `import { defineFactory } from '${IMPORTS.testing}'
import Invoice from '../../app/models/invoice.model.ts'
export default defineFactory(Invoice, ({ fake, sequence }) => ({
  number: 'INV-' + sequence,
  amount: fake.decimal({ min: 1, max: 100, scale: 2 }),
  status: fake.pick(['draft', 'sent']),
}))
`,
    'database/seeders/invoice.seeder.ts': `import { defineSeeder } from '${IMPORTS.database}'
import InvoiceFactory from '../factories/invoice.factory.ts'
export default defineSeeder('InvoiceSeeder', async ({ create }) => { await create(InvoiceFactory, 3) })
`,
    'database/seeders/database.seeder.ts': `import { defineSeeder } from '${IMPORTS.database}'
import InvoiceSeeder from './invoice.seeder.ts'
export default defineSeeder({ async run({ call }) { await call(InvoiceSeeder); await call(InvoiceSeeder) } })
`,
    '.env': 'STRUTVANE_FIXTURE_FROM_DOTENV=yes\n',
    'storage/.gitkeep': '',
    ...extra,
  }
}

/** Write a project into a fresh temp directory. */
export async function makeProject(
  files: Record<string, string> = projectFiles(),
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sv-project-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return { root, cleanup: () => removeProject(root) }
}

/** Longest a project cleanup may take before the test run moves on. */
const CLEANUP_DEADLINE_MS = 5_000

/**
 * Remove a test project, quickly and boundedly.
 *
 * libSQL (0.5.x) keeps a SQLite file open on Windows until the statement objects that used it are
 * garbage-collected: `close()` alone does not release it. Without a collection the file stays
 * locked for seconds (until the next major GC), and `rm` sat in its retry loop that long for
 * every project, sequentially: under load that pushed `afterEach` hooks past their 60 s timeout.
 * So collect first (the test workers run with `--expose-gc`), which releases the file at once,
 * then remove with a short retry. Bounded: whatever is still locked after the deadline is left to
 * the OS temp cleaner instead of stalling the run (it is a temp directory).
 */
export async function removeProject(root: string): Promise<void> {
  ;(globalThis as { gc?: () => void }).gc?.()
  const removal = rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  )
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    removal,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLEANUP_DEADLINE_MS)
    }),
  ])
  clearTimeout(timer)
}
