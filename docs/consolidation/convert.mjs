#!/usr/bin/env node
// Consolidation step 3 (after merge.sh): turn the merged tree into ONE npm package,
// @strutvane/framework, with subpath exports for the absorbed parts.
//   - rewrites REAL import specifiers only (found by TypeScript's pre-processor, so code inside
//     template strings, e.g. generated-app templates, is never touched);
//   - remaps relative imports and `new URL('<rel>', import.meta.url)` of moved files;
//   - merges dependencies, exports, bin, build entries, test config; drops pnpm files;
//   - retargets the absorbed changesets to @strutvane/framework.
// Usage: node convert.mjs <framework worktree> <dir with node_modules/typescript> <original packages dir>
// Then: npx biome check --write . && npm install --ignore-scripts && npm approve-scripts esbuild
// (the replay of commit "refactor: one @strutvane/framework package" in CONSOLIDATION.md).
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, posix, resolve } from 'node:path'

const [repo, tsHome, originals] = process.argv.slice(2, 5).map((p) => resolve(p))
const ts = createRequire(join(tsHome, 'package.json'))('typescript')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const write = (p, s) => writeFileSync(join(repo, p), s)
const readJson = (p) => JSON.parse(read(p))
const writeJson = (p, v) => write(p, `${JSON.stringify(v, null, 2)}\n`)

/** Old location (repo-relative in its ORIGINAL repo) → new location in the framework repo. */
const MOVES = [
  { pkg: '@strutvane/contracts', part: 'contracts', from: { src: 'src', test: 'test' } },
  { pkg: '@strutvane/core', part: 'core', from: { src: 'src', test: 'test' } },
  { pkg: '@strutvane/devkit', part: 'devkit', from: { src: 'src', test: 'test' } },
  {
    pkg: '@strutvane/cli',
    part: 'console',
    from: { src: 'packages/cli/src', test: 'packages/cli/test' },
  },
]
const SKIP_DIRS = new Set(['fixtures', '__golden__', 'node_modules', 'dist', 'coverage'])

function* walk(dir) {
  for (const e of readdirSync(join(repo, dir))) {
    const p = posix.join(dir, e)
    if (statSync(join(repo, p)).isDirectory()) {
      if (!SKIP_DIRS.has(e)) yield* walk(p)
    } else if (/\.(m?ts|tsx)$/.test(e)) yield p
  }
}
const relSpec = (fromFile, toFile) => {
  const r = posix.relative(posix.dirname(fromFile), toFile)
  return r.startsWith('.') ? r : `./${r}`
}
/** For a moved file: its old path (in old-repo coordinates) and the move it belongs to. */
function oldPathOf(newPath) {
  for (const m of MOVES) {
    for (const kind of ['src', 'test']) {
      const prefix = `${kind}/${m.part}/`
      if (newPath.startsWith(prefix))
        return { move: m, old: posix.join(m.from[kind], newPath.slice(prefix.length)) }
    }
  }
  return undefined
}
/** Map an old-repo path of `move` to its new framework path, if it was moved. */
function newPathOf(move, oldPath) {
  for (const kind of ['src', 'test']) {
    const prefix = `${move.from[kind]}/`
    if (oldPath.startsWith(prefix)) return posix.join(kind, move.part, oldPath.slice(prefix.length))
  }
  return undefined
}
const PKG_TARGET = Object.fromEntries(MOVES.map((m) => [m.pkg, `src/${m.part}/index.ts`]))

const report = { files: 0, packageImports: 0, relativeImports: 0, urls: 0, unmapped: [] }
for (const top of ['src', 'test']) {
  for (const file of walk(top)) {
    const text = read(file)
    const moved = oldPathOf(file)
    const edits = []
    const remapRelative = (spec) => {
      if (!moved || !spec.startsWith('.')) return undefined
      const oldTarget = posix.normalize(posix.join(posix.dirname(moved.old), spec))
      const target = newPathOf(moved.move, oldTarget)
      if (!target) {
        report.unmapped.push(`${file}: ${spec}`)
        return undefined
      }
      const next = relSpec(file, target)
      return next === spec ? undefined : next
    }
    for (const imp of ts.preProcessFile(text, true, false).importedFiles) {
      const spec = imp.fileName
      let next
      if (PKG_TARGET[spec]) {
        next = relSpec(file, PKG_TARGET[spec])
        report.packageImports++
      } else {
        next = remapRelative(spec)
        if (next) report.relativeImports++
      }
      if (next) {
        // FileReference positions are approximate around the quotes; anchor on the literal itself.
        const at = text.indexOf(spec, Math.max(0, imp.pos - 1))
        edits.push({ pos: at, end: at + spec.length, next })
      }
    }
    // new URL('<relative>', import.meta.url): runtime paths to sibling files (bins, fixtures).
    for (const m of text.matchAll(/new URL\((['"])(\.{1,2}\/[^'"]+)\1, import\.meta\.url\)/g)) {
      const next = remapRelative(m[2])
      if (next) {
        const pos = m.index + m[0].indexOf(m[2])
        edits.push({ pos, end: pos + m[2].length, next })
        report.urls++
      }
    }
    if (edits.length === 0) continue
    let out = text
    for (const e of edits.sort((a, b) => b.pos - a.pos))
      out = out.slice(0, e.pos) + e.next + out.slice(e.end)
    write(file, out)
    report.files++
  }
}

// CLI version: it used to read ../package.json of @strutvane/cli. It now reads the framework's
// manifest, found by walking up (works from src/console in tests and from any dist chunk).
const versionFile = 'src/console/version.ts'
write(
  versionFile,
  read(versionFile)
    .replace(
      ' * npm actually installed. `../package.json` resolves correctly from both `src/` (tests, type\n * stripping) and `dist/` (published build), because both sit one level below the package root.\n',
      ' * npm actually installed. The manifest is the nearest `package.json` above this module (see\n * `ownManifest`), which is right from `src/console/` (tests, type stripping) and from any `dist/`\n * chunk (published build) alike.\n',
    )
    .replace('/** The installed version of `@strutvane/cli`. */\n', '')
    .replace(
      "export const CLI_VERSION: string = readPackageVersion(new URL('../package.json', import.meta.url))",
      `/**
 * The package.json of the package this module ships in: the nearest one above it. Since the CLI
 * moved into \`@strutvane/framework\`, this file sits deeper than the package root in src/ (and
 * dist/ chunk layout is the bundler's choice), so a fixed \`../package.json\` is no longer right.
 */
export function ownManifest(from: URL): URL {
  let dir = new URL('.', from)
  for (;;) {
    const candidate = new URL('package.json', dir)
    if (existsSync(candidate)) return candidate
    const parent = new URL('..', dir)
    if (parent.href === dir.href) return new URL('../package.json', from)
    dir = parent
  }
}

/** The installed version of the package that ships the CLI (\`@strutvane/framework\`). */
export const CLI_VERSION: string = readPackageVersion(ownManifest(new URL(import.meta.url)))`,
    )
    .replace(
      "import { readFileSync } from 'node:fs'",
      "import { existsSync, readFileSync } from 'node:fs'",
    ),
)

// package.json: one package. Dependencies = union; absorbed @strutvane/* deps disappear.
const origin = (n) => JSON.parse(readFileSync(join(originals, n, 'package.json'), 'utf8'))
const pkg = readJson('package.json')
const absorbed = [
  origin('contracts'),
  origin('core'),
  origin('devkit'),
  origin('cli/packages/cli'),
  origin('cli'),
]
const merge = (field) => {
  const out = { ...(pkg[field] ?? {}) }
  for (const a of absorbed)
    for (const [k, v] of Object.entries(a[field] ?? {})) {
      if (out[k] && out[k] !== v)
        process.stderr.write(`[convert] ${field}.${k}: ${out[k]} vs ${v} (kept ${out[k]})
`)
      out[k] ??= v
    }
  for (const m of MOVES) delete out[m.pkg]
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}
pkg.dependencies = merge('dependencies')
pkg.devDependencies = merge('devDependencies')
for (const k of Object.keys(pkg.dependencies)) delete pkg.devDependencies[k]
delete pkg.packageManager
// `strutvane` is the v2 name (blueprint §3.2). `strutvane-cli` is the name @strutvane/cli used and
// that generated apps' `sv` script calls, kept so swapping the dependency changes nothing.
pkg.bin = { strutvane: 'dist/console/bin.mjs', 'strutvane-cli': 'dist/console/bin.mjs' }
const sub = (file) => ({ types: `./dist/${file}.d.mts`, default: `./dist/${file}.mjs` })
const { './package.json': manifestExport, ...exportsRest } = pkg.exports
pkg.exports = {
  ...exportsRest,
  './contracts': sub('contracts/index'),
  './core': sub('core/index'),
  './devkit': sub('devkit/index'),
  './console': sub('console/index'),
  './package.json': manifestExport,
}
pkg.scripts = { ...pkg.scripts, 'test:perf': 'vitest run --config vitest.perf.config.ts' }
pkg.description = `${pkg.description.replace(/\.$/, '')}, plus the kernel (core), shared contracts, the CLI (console) and the installer/generator SDK (devkit).`
// npm >= 11.19 is required: older npm ignores .npmrc's strict-allow-scripts and min-release-age.
// fsevents (macOS only, via vite/tsx) has an install script that pnpm never ran: deny it explicitly.
pkg.devEngines = { packageManager: { name: 'npm', version: '>=11.19.0', onFail: 'error' } }
pkg.allowScripts = { ...pkg.allowScripts, 'fsevents@2.3.3': false }
const ordered = {}
for (const [k, v] of Object.entries(pkg)) {
  if (k === 'bin' || k === 'devEngines') continue
  ordered[k] = v
  if (k === 'exports') ordered.bin = pkg.bin
  if (k === 'engines') ordered.devEngines = pkg.devEngines
}
writeJson('package.json', ordered)

// Build: one tsdown config, one entry per public subpath (+ the CLI bin).
write(
  'tsdown.config.ts',
  read('tsdown.config.ts').replace(
    "    'testing/index': 'src/testing/index.ts',\n",
    "    'testing/index': 'src/testing/index.ts',\n    'contracts/index': 'src/contracts/index.ts',\n    'core/index': 'src/core/index.ts',\n    'devkit/index': 'src/devkit/index.ts',\n    'console/index': 'src/console/index.ts',\n    'console/bin': 'src/console/bin.ts',\n",
  ),
)
// Tests: the CLI's fixtures are app data (not part of the build or the type-check), and its
// child-process tests need the CLI repo's longer timeouts.
write(
  'vitest.config.ts',
  `import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. The framework now also holds the kernel (core), contracts, the CLI
// (console) and devkit, whose suites moved under test/<part>/. Timeouts are the largest any of
// the absorbed repos needed (the CLI's child-process and watcher tests on Windows).
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, 'test/console/fixtures/**'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      coverage: { exclude: ['src/console/bin.ts'] },
    },
  }),
)
`,
)
write(
  'tsconfig.json',
  read('tsconfig.json').replace(
    '"include": ["src", "test"]\n',
    '"include": ["src", "test"],\n  "exclude": ["test/console/fixtures"]\n',
  ),
)
// The version test reads "a JSON file without a version": it was the CLI repo root's tsconfig
// (../../../ from packages/cli/test/); it is now the framework root's (../../ from test/console/).
write(
  'test/console/units.test.ts',
  read('test/console/units.test.ts').replace(
    "new URL('../../../tsconfig.json', import.meta.url)",
    "new URL('../../tsconfig.json', import.meta.url)",
  ),
)

// pnpm → npm.
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(repo, f), { force: true })
rmSync(join(repo, 'packages'), { recursive: true, force: true })

// Changesets of the absorbed packages now describe the framework.
const cs = join(repo, '.changeset')
for (const f of readdirSync(cs)) {
  if (!f.endsWith('.md') || f === 'README.md') continue
  const p = join(cs, f)
  const t = readFileSync(p, 'utf8')
  const RANK = { patch: 1, minor: 2, major: 3 }
  const fixed = t.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, head) => {
    // One entry per package, highest bump wins (core: minor + framework: patch → framework: minor).
    const bumps = new Map()
    for (const line of head.split(/\r?\n/)) {
      const m = /^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line)
      if (!m) continue
      const name = /^(@strutvane\/(contracts|core|devkit|cli)|strutvane)$/.test(m[1])
        ? '@strutvane/framework'
        : m[1]
      if (!bumps.has(name) || RANK[m[2]] > RANK[bumps.get(name)]) bumps.set(name, m[2])
    }
    return `---\n${[...bumps].map(([n, b]) => `"${n}": ${b}`).join('\n')}\n---`
  })
  if (fixed !== t) writeFileSync(p, fixed)
}
process.stdout.write(`[convert] ${JSON.stringify(report, null, 2)}
`)

// Changesets reads .changeset/pre/*.md too and refuses records for packages that are not in this
// repo, so the absorbed pre/ records (what 0.1.0-next.0 shipped) become plain docs. An empty
// changeset (contracts shipped with one) makes `changeset status` fail, so it goes.
const released = join(repo, 'docs', 'changelogs', 'released')
mkdirSync(released, { recursive: true })
for (const f of readdirSync(join(cs, 'pre'))) {
  if (/^(contracts|core|devkit|cli)-.*.md$/.test(f))
    renameSync(join(cs, 'pre', f), join(released, f))
}
for (const f of readdirSync(cs)) {
  const p = join(cs, f)
  if (f.endsWith('.md') && statSync(p).size === 0) rmSync(p)
}
