/**
 * Test helpers: temporary projects (always cleaned up) and a stress-project generator.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_DIR: string = fileURLToPath(new URL('../fixtures/app', import.meta.url))

const created: string[] = []

/** A fresh empty temp directory, removed by {@link cleanupTempDirs}. */
export function tempDir(prefix = 'sv-registry-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** Remove every temp dir created so far (call from `afterAll`). */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Write files (POSIX relative paths → content) under `root`, creating folders as needed. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** A temp copy of the fixture app. */
export function copyFixture(): string {
  const dir = tempDir()
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** A temp project with the framework stub + tsconfig, plus the given app files. */
export function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = tempDir()
  for (const name of ['package.json', 'tsconfig.json', 'lib/strutvane.ts']) {
    cpSync(join(FIXTURE_DIR, ...name.split('/')), join(dir, ...name.split('/')), {
      recursive: true,
    })
  }
  writeFiles(dir, files)
  return dir
}

/** Source of a valid model file. */
export function modelSource(
  name: string,
  fields: readonly string[] = ['title'],
  options = '',
): string {
  const body = fields.map((f) => `  ${f}: field.string(),`).join('\n')
  const opts = options === '' ? '' : `, ${options}`
  return `import { defineModel, field } from '@strutvane/framework'\n\nexport default defineModel('${name}', {\n${body}\n}${opts})\n`
}

/** kebab file stem for a PascalCase name: InvoiceLine → invoice-line. */
export function stem(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * A realistic stress project with exactly `total` (default 200) convention files:
 * models (with resources and policies), jobs, listeners, commands, route files and pages.
 * All files get an mtime one hour in the past, as in a real working copy (see README: racy window).
 */
export function stressProject(total = 200): string {
  const counts = {
    model: 55,
    resource: 40,
    policy: 40,
    job: 20,
    listener: 20,
    command: 10,
    route: 5,
    page: 10,
  }
  const sum = Object.values(counts).reduce((a, b) => a + b, 0)
  if (sum !== total) throw new Error(`stress distribution sums to ${sum}, expected ${total}`)
  const files: Record<string, string> = {}
  const fields = [
    'code',
    'title',
    'description',
    'amount',
    'status',
    'ownerId',
    'createdBy',
    'notes',
  ]
  for (let i = 0; i < counts.model; i++) {
    files[`app/models/entity${i}.model.ts`] = modelSource(
      `Entity${i}`,
      fields,
      i % 3 === 0 ? '{ softDeletes: true, tenant: true }' : '{ tenant: true }',
    )
  }
  for (let i = 0; i < counts.resource; i++) {
    files[`app/resources/entity${i}.resource.ts`] =
      `import { defineResource } from '@strutvane/framework'\nimport Entity${i} from '../models/entity${i}.model.ts'\n\nexport default defineResource(Entity${i}, {\n  actions: {\n    approve: { permission: 'entity${i}.approve' },\n    archive: { label: 'Archive' },\n  },\n})\n`
  }
  for (let i = 0; i < counts.policy; i++) {
    files[`app/policies/entity${i}.policy.ts`] =
      `import { definePolicy } from '@strutvane/framework'\n\nexport default definePolicy('entity${i}', ({ allow }) => {\n  allow('read')\n})\n`
  }
  for (let i = 0; i < counts.job; i++) {
    files[`app/jobs/job-${i}.job.ts`] =
      `import { defineJob } from '@strutvane/framework'\n\nexport default defineJob('job-${i}', async () => {})\n`
  }
  for (let i = 0; i < counts.listener; i++) {
    files[`app/listeners/listener-${i}.listener.ts`] =
      `import { defineListener } from '@strutvane/framework'\n\nexport default defineListener('entity${i}.updated', async () => {})\n`
  }
  for (let i = 0; i < counts.command; i++) {
    files[`app/commands/command-${i}.command.ts`] =
      `import { defineCommand } from '@strutvane/framework'\n\nexport default defineCommand('task:${i}', async () => 0)\n`
  }
  for (let i = 0; i < counts.route; i++) {
    const routes = Array.from(
      { length: 6 },
      (_, j) =>
        `  route.get('/api-${i}/r${j}', { name: 'api${i}.r${j}', permission: 'report.r${i}x${j}' }),`,
    ).join('\n')
    files[`app/http/routes/api-${i}.ts`] =
      `import { route } from '@strutvane/framework'\n\nexport default [\n${routes}\n]\n`
  }
  for (let i = 0; i < counts.page; i++) {
    files[`web/pages/section-${i}/index.tsx`] =
      'export default function Page(): null {\n  return null\n}\n'
  }
  const dir = project(files)
  const past = new Date(Date.now() - 3_600_000)
  for (const rel of Object.keys(files)) utimesSync(join(dir, ...rel.split('/')), past, past)
  return dir
}

/** Median of a list of numbers. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

/** Wait until `predicate()` is true, polling; rejects after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
