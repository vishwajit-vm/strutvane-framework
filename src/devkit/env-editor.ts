/**
 * Edits `.env` (local values, never committed) and `.env.example` (documented, committed) together,
 * so they never drift apart: the DX rule in docs/05 §3.2.
 *
 * Rules:
 * - Keys must be UPPER_SNAKE_CASE. Invalid keys are rejected before anything is staged.
 * - **Existing keys are never overwritten** in either file. They are reported as `kept`, so a
 *   developer's local values and edits always win.
 * - `secret: true` generates a crypto-random value (32 bytes, base64url) for `.env` only.
 * - **`.env.example` never receives a secret.** It gets an empty value for `secret: true` keys, and
 *   also for any key whose name looks secret (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*KEY*`,
 *   `*_DSN`, `*SALT*`, …) and for any value that embeds credentials in a URL
 *   (`postgres://user:pw@host`), even if the installer forgot to flag it. That is defence in
 *   depth against leaking a real value into a committed file.
 * - Non-secret values (defaults like `DB_HOST=127.0.0.1`) appear in both files, as in docs/05.
 * - New keys of a section that already exists are appended to the end of that section; otherwise
 *   a new titled block is appended. Comments, ordering and line endings are preserved.
 * - Values never contain line breaks (multi-line values are rejected).
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import type { EnvVar, InstallEnv } from '../contracts/index.ts'
import { DevkitError } from './errors.ts'
import { ENV_LINE_KEY } from './secret-files.ts'
import { fromLines, shapeOf, type TextShape, toLines } from './text.ts'

/** The two files and what happened to each key. */
export interface EnvAddResult {
  /** Keys newly written. */
  readonly added: readonly string[]
  /** Keys that already existed in `.env` and were left untouched. */
  readonly kept: readonly string[]
}

/** The minimal file access the editor needs (a {@link StagedFs} fits). */
export interface EnvEditorFs {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, content: string, options?: { readonly overwrite?: boolean }): Promise<void>
}

/**
 * The contracts' `InstallEnv`, plus a reporting variant and removal for uninstallers.
 *
 * `add` keeps the contract's `Promise<void>` signature so a devkit editor can be passed anywhere an
 * `InstallEnv` is expected; {@link EnvEditor.ensure} does the same work and says what it did.
 */
export interface EnvEditor extends InstallEnv {
  /** Same as `add`, but reports which keys were added and which already existed. */
  ensure(section: string, vars: readonly EnvVar[]): Promise<EnvAddResult>
  /** Remove keys (and their comment lines) from both files. Missing keys are ignored. */
  remove(keys: readonly string[]): Promise<void>
}

/** Options for {@link createEnvEditor}. */
export interface EnvEditorOptions {
  /** Local values file. Default `.env`. */
  readonly envPath?: string
  /** Committed documentation file. Default `.env.example`. */
  readonly examplePath?: string
  /** Secret generator (injectable for tests). Default: 32 random bytes, base64url. */
  readonly generateSecret?: () => string
}

const KEY = /^[A-Z][A-Z0-9_]*$/
/**
 * Key names that suggest a sensitive value: substrings that are distinctive anywhere
 * (`PASSWORD`, `SECRET`, `TOKEN`, …), plus short words matched only as a whole `_`-separated
 * part (`PASS`, `PWD`, `DSN`, `SALT`, `SIGNING`) so that `BYPASS_CACHE` or `COMPASS_URL` stay
 * public.
 */
const SECRET_NAME =
  /(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_KEY|_KEY$|^KEY$|(?:^|_)(?:PASS|PWD|DSN|SALT|SIGNING)(?:_|$))/
/** A URL with a password in its user-info part: `scheme://user:password@host`. */
const CREDENTIAL_URL = /:\/\/[^/\s]*:[^@\s]+@/
const LINE_KEY = ENV_LINE_KEY

/**
 * True if a key name, or its value when given, suggests the value is sensitive.
 *
 * The value check catches connection strings with embedded credentials
 * (`DATABASE_URL=postgres://app:pw@db/app`), whose key name looks harmless. Erring towards
 * "secret" is the safe direction: the only effect is an empty value in `.env.example`.
 */
export function looksSecret(key: string, value?: string): boolean {
  return SECRET_NAME.test(key) || (value !== undefined && CREDENTIAL_URL.test(value))
}

/** Keys defined in an env file's text. */
export function envKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const line of toLines(text)) {
    const m = LINE_KEY.exec(line)
    if (m?.[1]) keys.add(m[1])
  }
  return keys
}

/**
 * Format a value for an env file so that every loader reads it back unchanged: bare when safe,
 * else double-quoted, else single-quoted.
 *
 * **Why no escapes?** The app loads `.env` with Node's own parser (`process.loadEnvFile`), which
 * understands no escape sequence except `\n` inside double quotes: `"a\"b"` reads as `a\`, and a
 * backslash before `n` becomes a line break. So a value is quoted only in a style that needs no
 * escaping at all: double quotes when it has no `"` and no `\`, single quotes (taken literally)
 * when it has no `'`. A value that fits neither, or holds a control character, is refused with
 * `invalid_env_value` rather than written in a form the app would read differently.
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new DevkitError('invalid_env_value', 'env values cannot contain line breaks')
  }
  // Tab is allowed (quoted); every other C0 control character and DEL is refused.
  if (hasControlCharacter(value)) {
    throw new DevkitError('invalid_env_value', 'env values cannot contain control characters')
  }
  if (value === '' || /^[A-Za-z0-9_./:@+,-]+$/.test(value)) return value
  if (!/["\\]/.test(value)) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  throw new DevkitError(
    'invalid_env_value',
    "env values cannot contain both ' and \" (or ' and \\): no quoting keeps them unchanged for every .env loader",
  )
}

/** True for C0 control characters other than tab, and DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return true
  }
  return false
}

/** The header line of a section, e.g. `# ─── Auth ───…`. */
export function sectionHeader(section: string): string {
  const title = `# ─── ${section} `
  return title.padEnd(Math.max(title.length + 3, 66), '─')
}

const HEADER_PREFIX = '# ─── '

function defaultSecret(): string {
  return randomBytes(32).toString('base64url')
}

function validate(section: string, vars: readonly EnvVar[]): void {
  if (section.trim() === '' || /[\r\n]/.test(section)) {
    throw new DevkitError('invalid_env_key', 'section titles must be a single non-empty line')
  }
  const seen = new Set<string>()
  for (const v of vars) {
    if (!KEY.test(v.key)) {
      throw new DevkitError('invalid_env_key', `env key "${v.key}" must be UPPER_SNAKE_CASE`)
    }
    if (seen.has(v.key))
      throw new DevkitError('invalid_env_key', `env key "${v.key}" is listed twice`)
    seen.add(v.key)
    if (v.secret === true && v.value !== undefined) {
      throw new DevkitError(
        'invalid_env_value',
        `env key "${v.key}" is marked secret: omit "value" and let devkit generate one`,
      )
    }
    if (v.comment !== undefined && /[\r\n]/.test(v.comment)) {
      throw new DevkitError('invalid_env_value', `comment for "${v.key}" must be a single line`)
    }
    if (v.value !== undefined) formatEnvValue(v.value) // throws on line breaks
  }
}

/** Insert `block` lines into `lines`: at the end of `section` if present, else as a new block. */
function insertBlock(lines: string[], section: string, entries: readonly string[]): string[] {
  const header = sectionHeader(section)
  const start = lines.findIndex((l) => l.trimEnd() === header.trimEnd())
  if (start < 0) {
    const out = [...lines]
    while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop()
    if (out.length > 0) out.push('')
    return [...out, header, ...entries]
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith(HEADER_PREFIX)) {
      end = i
      break
    }
  }
  while (end > start + 1 && lines[end - 1]?.trim() === '') end--
  return [...lines.slice(0, end), ...entries, ...lines.slice(end)]
}

function entryLines(v: EnvVar, value: string): string[] {
  return [...(v.comment ? [`# ${v.comment}`] : []), `${v.key}=${formatEnvValue(value)}`]
}

async function readOrEmpty(fs: EnvEditorFs, path: string): Promise<string | undefined> {
  return (await fs.exists(path)) ? fs.read(path) : undefined
}

function write(fs: EnvEditorFs, path: string, lines: string[], shape: TextShape | undefined) {
  const text = fromLines(lines, {
    eol: shape?.eol ?? '\n',
    bom: shape?.bom ?? false,
    finalNewline: true,
  })
  return fs.write(path, text, { overwrite: true })
}

/** Create an editor for a project's `.env` and `.env.example`. */
export function createEnvEditor(fs: EnvEditorFs, options: EnvEditorOptions = {}): EnvEditor {
  const envPath = options.envPath ?? '.env'
  const examplePath = options.examplePath ?? '.env.example'
  const secret = options.generateSecret ?? defaultSecret

  const editor: EnvEditor = {
    async add(section, vars) {
      await editor.ensure(section, vars)
    },

    async ensure(section, vars) {
      validate(section, vars)
      const envText = await readOrEmpty(fs, envPath)
      const exampleText = await readOrEmpty(fs, examplePath)
      const envExisting = envKeys(envText ?? '')
      const exampleExisting = envKeys(exampleText ?? '')

      const added: string[] = []
      const kept: string[] = []
      const envEntries: string[] = []
      const exampleEntries: string[] = []
      for (const v of vars) {
        if (envExisting.has(v.key)) kept.push(v.key)
        else {
          added.push(v.key)
          envEntries.push(...entryLines(v, v.secret === true ? secret() : (v.value ?? '')))
        }
        if (!exampleExisting.has(v.key)) {
          const safe = v.secret === true || looksSecret(v.key, v.value) ? '' : (v.value ?? '')
          exampleEntries.push(...entryLines(v, safe))
        }
      }
      if (envEntries.length > 0) {
        const shape = envText === undefined ? undefined : shapeOf(envText)
        await write(fs, envPath, insertBlock(toLines(envText ?? ''), section, envEntries), shape)
      }
      if (exampleEntries.length > 0) {
        const shape = exampleText === undefined ? undefined : shapeOf(exampleText)
        const lines = insertBlock(toLines(exampleText ?? ''), section, exampleEntries)
        await write(fs, examplePath, lines, shape)
      }
      return { added, kept }
    },

    async remove(keys) {
      const drop = new Set(keys)
      for (const path of [envPath, examplePath]) {
        const text = await readOrEmpty(fs, path)
        if (text === undefined) continue
        const lines = toLines(text)
        const out: string[] = []
        for (const line of lines) {
          const key = LINE_KEY.exec(line)?.[1]
          if (key !== undefined && drop.has(key)) {
            // Also drop the comment line directly above the key (it documents only that key).
            if (
              out.length > 0 &&
              out[out.length - 1]?.startsWith('# ') &&
              !out[out.length - 1]?.startsWith(HEADER_PREFIX)
            ) {
              out.pop()
            }
            continue
          }
          out.push(line)
        }
        // Drop section headers left with no keys.
        const cleaned = out.filter((line, i) => {
          if (!line.startsWith(HEADER_PREFIX)) return true
          for (let j = i + 1; j < out.length; j++) {
            const next = out[j] ?? ''
            if (next.startsWith(HEADER_PREFIX)) return false
            if (LINE_KEY.test(next)) return true
          }
          return false
        })
        while (cleaned.length > 0 && cleaned[cleaned.length - 1]?.trim() === '') cleaned.pop()
        if (cleaned.length !== lines.length) await write(fs, path, cleaned, shapeOf(text))
      }
    },
  }
  return editor
}
