/**
 * The registry compiler: discover → analyze (incrementally) → build registry → emit → write.
 *
 * Failure policy: if there is any error diagnostic, NO output is produced and the previously
 * written registry is left untouched ("keep last good"). The app keeps running on the last
 * consistent registry while the developer fixes the error, and a broken registry can never be
 * half-applied.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { analyzeFile, type FileAnalysis } from './analyze.ts'
import { OUTPUT_FILE } from './conventions.ts'
import { discover } from './discover.ts'
import { emitRegistry } from './emit.ts'
import { compareDiagnostics, type Diagnostic, hasErrors } from './errors.ts'
import { buildRegistry, type Registry } from './registry.ts'

export interface CompileStats {
  /** Convention files found. */
  readonly files: number
  /** Files parsed in this run (the rest came from the cache). */
  readonly analyzed: number
  readonly ms: number
}

export interface CompileResult {
  /** Generated source, or `undefined` when there are errors. */
  readonly output: string | undefined
  readonly registry: Registry | undefined
  /** All diagnostics, deterministically sorted. */
  readonly diagnostics: readonly Diagnostic[]
  readonly stats: CompileStats
}

export interface WriteResult {
  readonly result: CompileResult
  /** `true` only when the file on disk actually changed. */
  readonly written: boolean
  readonly outputPath: string
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly hash: string
  readonly analysis: FileAnalysis
}

/**
 * Files modified within this window are always re-hashed even if mtime+size look unchanged:
 * coarse file-system timestamps (FAT, some network drives: 2 s) can hide a second edit made in
 * the same tick with the same size. This is the "racy clean" problem Git solves the same way.
 */
const RACY_WINDOW_MS = 2_000

export class RegistryCompiler {
  readonly root: string
  readonly outputPath: string
  readonly #cache = new Map<string, CacheEntry>()

  constructor(root: string) {
    this.root = root
    this.outputPath = join(root, ...OUTPUT_FILE.split('/'))
  }

  /** Compile the project. Re-analyzes only files whose content changed since the last call. */
  compile(): CompileResult {
    const started = performance.now()
    const discovery = discover(this.root)
    const analyses: FileAnalysis[] = []
    const present = new Set<string>()
    let analyzed = 0

    for (const file of discovery.files) {
      present.add(file.relPath)
      const stat = statSync(file.absPath)
      const cached = this.#cache.get(file.relPath)
      const racy = Date.now() - stat.mtimeMs < RACY_WINDOW_MS
      if (
        cached !== undefined &&
        !racy &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        analyses.push(cached.analysis)
        continue
      }
      const text = stripBom(readFileSync(file.absPath, 'utf8'))
      const hash = createHash('sha256').update(text).digest('hex')
      let analysis: FileAnalysis
      if (cached !== undefined && cached.hash === hash) {
        analysis = cached.analysis
      } else {
        analysis = analyzeFile(file, text)
        analyzed++
      }
      this.#cache.set(file.relPath, { mtimeMs: stat.mtimeMs, size: stat.size, hash, analysis })
      analyses.push(analysis)
    }
    for (const key of [...this.#cache.keys()]) if (!present.has(key)) this.#cache.delete(key)

    const { registry, diagnostics: registryDiagnostics } = buildRegistry(analyses)
    const diagnostics = [
      ...discovery.diagnostics,
      ...analyses.flatMap((a) => a.diagnostics),
      ...registryDiagnostics,
    ].sort(compareDiagnostics)
    const ok = !hasErrors(diagnostics)
    return {
      output: ok ? emitRegistry(registry) : undefined,
      registry: ok ? registry : undefined,
      diagnostics,
      stats: { files: discovery.files.length, analyzed, ms: performance.now() - started },
    }
  }

  /** Whether the file on disk already equals a successful compile's output. */
  isCurrent(result: CompileResult): boolean {
    if (result.output === undefined) return false
    return existsSync(this.outputPath) && readFileSync(this.outputPath, 'utf8') === result.output
  }

  /** Compile and write the registry if (and only if) it changed and there are no errors. */
  write(): WriteResult {
    const result = this.compile()
    if (result.output === undefined) return { result, written: false, outputPath: this.outputPath }
    const current = existsSync(this.outputPath) ? readFileSync(this.outputPath, 'utf8') : undefined
    if (current === result.output) return { result, written: false, outputPath: this.outputPath }
    writeAtomically(this.outputPath, result.output)
    return { result, written: true, outputPath: this.outputPath }
  }
}

/** One-shot compile (no cache reuse). */
export function compileProject(root: string): CompileResult {
  return new RegistryCompiler(root).compile()
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Write via a temp file + rename, so readers (tsc, Vite, editors) never observe a partial file.
 * On Windows, rename can briefly fail with EPERM/EBUSY while an antivirus or editor holds the
 * target; retry a few times before giving up.
 */
function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try {
          unlinkSync(temp)
        } catch {
          // best effort cleanup; the original error is what matters
        }
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt)
    }
  }
}
