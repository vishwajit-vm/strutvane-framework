/**
 * Registers service providers in a project's `strutvane.config.ts`, the edit behind
 * `config.registerProvider('@strutvane/auth/provider')` in installers.
 *
 * Supported shapes (anything else is refused with `config_shape_unrecognised`, and the file is
 * never touched):
 *
 * ```ts
 * export default defineConfig({ providers: [backend], … })   // any call wrapping an object
 * export default { providers: [backend], … }                  // a plain object
 * export default { … } satisfies Config                       // `satisfies` / `as` wrappers
 * ```
 *
 * How the edit stays safe and tidy:
 * - **Parse with an AST, edit as text.** The file is parsed (magicast: Babel + recast) to find the
 *   exact offsets of the `providers` array and the imports, then only those few characters are
 *   changed. Re-printing the whole AST would reflow code the user formatted by hand (recast
 *   collapses a multi-line array it touched, for example); splicing at offsets leaves every other
 *   byte untouched.
 * - **The file's own style:** new items follow the array's layout (one per line, or inline) and
 *   trailing-comma habit; the import copies the quote and semicolon style of the existing imports.
 * - **Idempotent:** registering an already-registered provider changes nothing.
 * - **Reversible:** `unregisterProvider` removes exactly what `registerProvider` added, so a
 *   register → unregister round trip restores the original file byte for byte.
 * - **Verified:** the result is parsed again and checked before it is staged. A file we can't
 *   round-trip is refused rather than corrupted.
 *
 * @module
 */

import { parseModule } from 'magicast'
import type { InstallConfig } from '../contracts/index.ts'
import { DevkitError, describeError } from './errors.ts'
import { fromLines, shapeOf, toLines } from './text.ts'

/** The minimal file access the patcher needs (a {@link StagedFs} fits). */
export interface ConfigPatcherFs {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, content: string, options?: { readonly overwrite?: boolean }): Promise<void>
}

/** The contracts' `InstallConfig`, plus removal for uninstallers. */
export interface ConfigPatcher extends InstallConfig {
  /** Remove a provider and its import. Missing providers are ignored. */
  unregisterProvider(moduleSpecifier: string): Promise<void>
}

const SPECIFIER =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9._-]+(\/[A-Za-z0-9._-]+)*$|^\.{1,2}\/[A-Za-z0-9._/-]+$/
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * A specifier is written into source code, so it is validated strictly: a bare package path
 * (`@scope/name/sub`) without `.`/`..` segments, or a relative path. Quotes, spaces, URLs and
 * anything else that could break out of the string literal are refused.
 */
function isSafeSpecifier(specifier: string): boolean {
  if (!SPECIFIER.test(specifier)) return false
  if (specifier.startsWith('.')) return true
  return specifier.split('/').every((segment) => segment !== '.' && segment !== '..')
}

/**
 * Derive a readable local name for a provider import:
 * `@strutvane/auth/provider` → `authProvider`, `./app/providers/billing.provider.ts` → `billingProvider`.
 */
export function providerLocalName(specifier: string): string {
  const withoutScope = specifier.replace(/^@[^/]+\//, '').replace(/^\.{1,2}\//, '')
  const segments = withoutScope.split('/').filter(Boolean)
  let last = (segments[segments.length - 1] ?? 'provider').replace(/\.(m|c)?[jt]sx?$/, '')
  last = last.replace(/[.-]provider$/i, '')
  if (last.toLowerCase() === 'provider' && segments.length > 1) {
    last = segments[segments.length - 2] ?? 'app'
  }
  const words = last.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const camel = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('')
  const base = /^[A-Za-z_$]/.test(camel) ? camel : `p${camel}`
  return `${base || 'app'}Provider`
}

// ─── The slice of the Babel AST we read ───────────────────────────────────────────────────────

interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
}
interface Identifier extends AstNode {
  readonly name: string
}
interface ImportDeclaration extends AstNode {
  readonly source: AstNode & { readonly value: string }
  readonly specifiers: readonly (AstNode & { readonly local: Identifier })[]
}
interface ObjectProperty extends AstNode {
  readonly computed: boolean
  readonly key: AstNode & { readonly name?: string; readonly value?: unknown }
  readonly value: AstNode
}
/** An ArrayExpression's `elements` or an ObjectExpression's `properties` (holes dropped). */
interface ListNode extends AstNode {
  readonly items: readonly AstNode[]
}

/** What we found in a config file. */
interface ConfigShape {
  readonly imports: readonly ImportDeclaration[]
  readonly firstStatement: AstNode | undefined
  readonly object: ListNode
  /** `undefined` when the object has no `providers` key yet. */
  readonly providers: ListNode | undefined
}

const WRAPPERS = new Set(['TSSatisfiesExpression', 'TSAsExpression', 'ParenthesizedExpression'])

function child(node: AstNode, key: string): AstNode | undefined {
  const value = (node as unknown as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null ? (value as AstNode) : undefined
}

function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node
  while (current !== undefined && WRAPPERS.has(current.type)) current = child(current, 'expression')
  return current
}

function asList(node: AstNode, key: 'elements' | 'properties'): ListNode {
  const items = (node as unknown as Record<string, unknown>)[key]
  const list = Array.isArray(items) ? (items as (AstNode | null)[]) : []
  return {
    type: node.type,
    start: node.start,
    end: node.end,
    items: list.filter((n) => n !== null),
  }
}

function unrecognised(path: string, detail: string): DevkitError {
  return new DevkitError(
    'config_shape_unrecognised',
    `${path}: ${detail}. Expected \`export default defineConfig({ providers: [...] })\` or \`export default { providers: [...] }\`; register the provider by hand`,
  )
}

function isProvidersKey(node: AstNode): node is ObjectProperty {
  if (node.type !== 'ObjectProperty' || (node as ObjectProperty).computed) return false
  const key = (node as ObjectProperty).key
  return (
    (key.type === 'Identifier' && key.name === 'providers') ||
    (key.type === 'StringLiteral' && key.value === 'providers')
  )
}

/** Parse a config file and locate the default-exported object, its providers and the imports. */
function analyse(path: string, source: string): ConfigShape {
  let body: readonly AstNode[]
  try {
    body = (parseModule(source).$ast as unknown as { body: AstNode[] }).body
  } catch (error) {
    throw unrecognised(path, `cannot be parsed (${describeError(error)})`)
  }
  const exported = body.find((n) => n.type === 'ExportDefaultDeclaration')
  let target = unwrap(exported === undefined ? undefined : child(exported, 'declaration'))
  if (target?.type === 'CallExpression') {
    target = unwrap((target as unknown as { arguments: AstNode[] }).arguments[0])
  }
  if (target?.type !== 'ObjectExpression') {
    throw unrecognised(path, 'has no default-exported config object')
  }
  const object = asList(target, 'properties')
  const property = object.items.find(isProvidersKey)
  if (property !== undefined && property.value.type !== 'ArrayExpression') {
    throw unrecognised(path, '"providers" is not an array literal')
  }
  return {
    imports: body.filter((n): n is ImportDeclaration => n.type === 'ImportDeclaration'),
    firstStatement: body[0],
    object,
    providers: property === undefined ? undefined : asList(property.value, 'elements'),
  }
}

/** Import declarations that default-import `specifier`. */
function defaultImportsOf(shape: ConfigShape, specifier: string): ImportDeclaration[] {
  return shape.imports.filter(
    (d) =>
      d.source.value === specifier && d.specifiers.some((s) => s.type === 'ImportDefaultSpecifier'),
  )
}

function defaultLocal(declaration: ImportDeclaration): string | undefined {
  return declaration.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')?.local.name
}

function listedNames(list: ListNode | undefined): string[] {
  return (list?.items ?? [])
    .filter((n): n is Identifier => n.type === 'Identifier')
    .map((n) => n.name)
}

function uniqueName(source: string, shape: ConfigShape, wanted: string): string {
  const taken = new Set(shape.imports.flatMap((d) => d.specifiers.map((s) => s.local.name)))
  const declared = (name: string) =>
    taken.has(name) || new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(source)
  let name = wanted
  for (let n = 2; declared(name); n++) name = `${wanted}${n}`
  return name
}

// ─── Text edits at AST offsets ────────────────────────────────────────────────────────────────

interface TextEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Apply non-overlapping edits from the end of the file backwards, so offsets stay valid. */
function applyEdits(source: string, edits: readonly TextEdit[]): string {
  let out = source
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

function lineStart(code: string, offset: number): number {
  return code.lastIndexOf('\n', offset - 1) + 1
}

/** Offset of the `\n` ending the line that contains `offset` (or the end of the text). */
function lineEnd(code: string, offset: number): number {
  const i = code.indexOf('\n', offset)
  return i < 0 ? code.length : i
}

/**
 * Babel reports offsets on LF text without a BOM, so edits are made on that form and the result is
 * re-encoded in the file's own conventions (CRLF stays CRLF, a BOM stays).
 */
function normalise(source: string): { readonly text: string; restore(code: string): string } {
  const shape = shapeOf(source)
  const text = toLines(source).join('\n') + (shape.finalNewline ? '\n' : '')
  return {
    text,
    restore: (code) => fromLines(toLines(code), { ...shape, finalNewline: code.endsWith('\n') }),
  }
}

function indentAt(code: string, offset: number): string {
  return /^[ \t]*/.exec(code.slice(lineStart(code, offset)))?.[0] ?? ''
}

/** True if only whitespace separates `offset` from the start of its line. */
function startsLine(code: string, offset: number): boolean {
  return code.slice(lineStart(code, offset), offset).trim() === ''
}

/** Remove the whole line(s) spanning `[start, end)`, including the line break. */
function wholeLines(code: string, start: number, end: number): TextEdit {
  return {
    start: lineStart(code, start),
    end: Math.min(code.length, lineEnd(code, end) + 1),
    text: '',
  }
}

/**
 * Add `text` as the last item of an array or object literal, following its layout: one item per
 * line (same indentation and trailing-comma habit) or inline. `whenEmpty` replaces `[]` / `{}`.
 */
function appendItem(code: string, list: ListNode, text: string, whenEmpty: string): TextEdit[] {
  const last = list.items[list.items.length - 1]
  if (last === undefined) {
    const inner = code.slice(list.start + 1, list.end - 1)
    return inner.trim() === ''
      ? [{ start: list.start + 1, end: list.end - 1, text: whenEmpty }]
      : [{ start: list.end - 1, end: list.end - 1, text: ` ${text} ` }] // keep inner comments
  }
  if (!code.slice(list.start, last.start).includes('\n')) {
    return [{ start: last.end, end: last.end, text: `, ${text}` }]
  }
  // Multi-line: a new line after the last item's line (after any `// comment` on it).
  const at = lineEnd(code, last.end)
  const line = `\n${indentAt(code, last.start)}${text}`
  if (/^[ \t]*,/.test(code.slice(last.end, list.end - 1))) {
    return [{ start: at, end: at, text: `${line},` }]
  }
  if (at === last.end) return [{ start: at, end: at, text: `,${line}` }]
  return [
    { start: last.end, end: last.end, text: ',' },
    { start: at, end: at, text: line },
  ]
}

/** Remove one item from an array literal, with its separator (and its line if alone on it). */
function removeItem(code: string, list: ListNode, index: number): TextEdit[] {
  const item = list.items[index] as AstNode
  const next = list.items[index + 1]
  const previous = list.items[index - 1]
  const rest = code.slice(item.end, lineEnd(code, item.end))
  if (startsLine(code, item.start) && /^[ \t]*,?[ \t]*(\/\/.*)?$/.test(rest)) {
    const edits = [wholeLines(code, item.start, item.end)]
    // The last item of a list written without a trailing comma: also drop the comma that
    // `appendItem` put after the previous item, so register → unregister is exact.
    const prevComma = previous === undefined ? null : /^[ \t]*,/.exec(code.slice(previous.end))
    if (next === undefined && previous !== undefined && prevComma !== null && !rest.includes(',')) {
      edits.push({ start: previous.end, end: previous.end + prevComma[0].length, text: '' })
    }
    return edits
  }
  if (next !== undefined) return [{ start: item.start, end: next.start, text: '' }]
  if (previous !== undefined) return [{ start: previous.end, end: item.end, text: '' }]
  const comma = /^[ \t]*,/.exec(code.slice(item.end))
  return [{ start: item.start, end: item.end + (comma?.[0].length ?? 0), text: '' }]
}

/** Remove an import declaration, including its line when it is alone on it. */
function removeStatement(code: string, node: AstNode): TextEdit {
  const alone =
    startsLine(code, node.start) && code.slice(node.end, lineEnd(code, node.end)).trim() === ''
  return alone
    ? wholeLines(code, node.start, node.end)
    : { start: node.start, end: node.end, text: '' }
}

/** The import line, in the style of the file's existing imports (quotes, semicolons). */
function importLine(code: string, shape: ConfigShape, local: string, specifier: string): string {
  const model = shape.imports[shape.imports.length - 1]
  let quote: string
  let semi: string
  if (model !== undefined) {
    quote = code[model.source.start] === '"' ? '"' : "'"
    semi = code[model.end - 1] === ';' ? ';' : ''
  } else {
    // No import to copy: use the quote style most string literals use (single by default, the
    // Strutvane house style) and the first statement's semicolon habit.
    const singles = (code.match(/'[^'\n]*'/g) ?? []).length
    const doubles = (code.match(/"[^"\n]*"/g) ?? []).length
    quote = doubles > singles ? '"' : "'"
    const first = shape.firstStatement
    semi = first !== undefined && code[first.end - 1] === ';' ? ';' : ''
  }
  return `import ${local} from ${quote}${specifier}${quote}${semi}`
}

/** Insert the import after the last import, or before the first statement (after header comments). */
function insertImport(shape: ConfigShape, line: string): TextEdit {
  const lastImport = shape.imports[shape.imports.length - 1]
  if (lastImport !== undefined) {
    return { start: lastImport.end, end: lastImport.end, text: `\n${line}` }
  }
  const at = shape.firstStatement?.start ?? 0
  return { start: at, end: at, text: `${line}\n\n` }
}

/** Create a patcher for a project's config file (default `strutvane.config.ts`). */
export function createConfigPatcher(
  fs: ConfigPatcherFs,
  options: { readonly path?: string } = {},
): ConfigPatcher {
  const path = options.path ?? 'strutvane.config.ts'

  /** Re-parse the edited file and check the edit did exactly what was intended. */
  const verify = (code: string, specifier: string, local: string, registered: boolean): void => {
    let ok: boolean
    try {
      const shape = analyse(path, code)
      const imported = defaultImportsOf(shape, specifier).map(defaultLocal)
      const listed = listedNames(shape.providers).includes(local)
      ok = registered ? imported.includes(local) && listed : imported.length === 0 && !listed
    } catch (error) {
      throw unrecognised(path, `the edited file would not parse (${describeError(error)})`)
    }
    if (!ok) throw unrecognised(path, 'the edit could not be verified; the file was left unchanged')
  }

  return {
    async registerProvider(specifier) {
      if (!isSafeSpecifier(specifier)) {
        throw new DevkitError('invalid_path', `"${specifier}" is not a valid module specifier`)
      }
      if (!(await fs.exists(path))) {
        throw new DevkitError(
          'config_not_found',
          `${path} not found; is this a Strutvane project? (run sv init)`,
        )
      }
      const file = normalise(await fs.read(path))
      const source = file.text
      const shape = analyse(path, source)
      const existing = defaultImportsOf(shape, specifier)[0]
      const existingLocal = existing === undefined ? undefined : defaultLocal(existing)
      const local = existingLocal ?? uniqueName(source, shape, providerLocalName(specifier))
      if (!IDENT.test(local)) {
        throw unrecognised(path, `cannot derive an identifier for "${specifier}"`)
      }
      const listed = listedNames(shape.providers).includes(local)
      if (existingLocal !== undefined && listed) return // already registered: idempotent no-op

      const edits: TextEdit[] = []
      if (!listed) {
        edits.push(
          ...(shape.providers === undefined
            ? appendItem(source, shape.object, `providers: [${local}]`, ` providers: [${local}] `)
            : appendItem(source, shape.providers, local, local)),
        )
      }
      if (existingLocal === undefined) {
        edits.push(insertImport(shape, importLine(source, shape, local, specifier)))
      }
      const code = applyEdits(source, edits)
      verify(code, specifier, local, true)
      await fs.write(path, file.restore(code), { overwrite: true })
    },

    async unregisterProvider(specifier) {
      if (!(await fs.exists(path))) return
      const file = normalise(await fs.read(path))
      const source = file.text
      const shape = analyse(path, source)
      const declarations = defaultImportsOf(shape, specifier)
      const locals = declarations.map(defaultLocal).filter((l): l is string => l !== undefined)
      if (locals.length === 0) return

      const edits: TextEdit[] = []
      const list = shape.providers
      if (list !== undefined) {
        list.items.forEach((item, index) => {
          if (item.type === 'Identifier' && locals.includes((item as Identifier).name)) {
            edits.push(...removeItem(source, list, index))
          }
        })
      }
      // `import auth, { helper } from '…'`: deleting the line would break `helper`, so only
      // single-specifier imports are removed.
      const removable = declarations.filter((d) => d.specifiers.length === 1)
      for (const declaration of removable) edits.push(removeStatement(source, declaration))
      const code = applyEdits(source, edits)
      if (removable.length === declarations.length) {
        for (const local of locals) verify(code, specifier, local, false)
      }
      await fs.write(path, file.restore(code), { overwrite: true })
    },
  }
}
