/**
 * Edits the two files a v2 app lists its packages in, for `node strut install:<name>`:
 * `bootstrap/providers.ts` (the provider list) and `config/index.ts` (the config files).
 *
 * Every package installer needed this and each copied its own regex-based version (health,
 * log-viewer, search, social-login, redis). This one parses the file (magicast, like the
 * `strutvane.config.ts` patcher) and edits only the few characters that change, so the file's
 * own formatting, quotes and semicolons survive.
 *
 * Shapes it edits (what the skeleton generates, plus the obvious variants):
 *
 * ```ts
 * // bootstrap/providers.ts
 * const providers: readonly AnyProvider[] = [AppServiceProvider]   // or `export const providers`
 * export default [AppServiceProvider] satisfies AnyProvider[]      // `satisfies` / `as` allowed
 *
 * // config/index.ts
 * export default { app, cache } satisfies ConfigFiles              // or wrapped in a call
 * ```
 *
 * **Fail-safe, never a guess:** anything else (a computed list, a spread, a name already imported
 * from another module, a file that would not re-parse after the edit) leaves the file untouched and
 * returns `status: 'manual'` with the exact lines to write by hand, which the installer prints
 * (through `log.warn` when given). An install never fails because a developer reorganised a file.
 *
 * **Idempotent and reversible:** adding twice changes nothing; `remove*` undoes exactly what
 * `add*` did (the import line and the list entry), so install → uninstall restores the file.
 *
 * @module
 */
import { parseModule } from 'magicast'
import {
  type AstNode,
  appendItem,
  applyEdits,
  asList,
  child,
  type Identifier,
  type ImportDeclaration,
  importLine,
  insertImport,
  isSafeSpecifier,
  type ListNode,
  normalise,
  removeItem,
  removeStatement,
  type TextEdit,
  unwrap,
} from './config-patcher.ts'
import { DevkitError } from './errors.ts'

/**
 * One thing to list: what to import, from where, and how.
 *
 * @example
 * const provider: AppListEntry = { specifier: '@strutvane/health/provider', name: 'HealthServiceProvider' }
 * const config: AppListEntry = { specifier: './health.ts', name: 'health' }
 */
export interface AppListEntry {
  /** The module: a package path (`@strutvane/health/provider`) or a relative file (`./health.ts`). */
  readonly specifier: string
  /** The identifier imported and listed (`HealthServiceProvider`, `health`). */
  readonly name: string
  /**
   * `named` writes `import { Name } from '…'`, `default` writes `import Name from '…'`. Default:
   * `named` for providers (packages export provider classes by name), `default` for config files.
   */
  readonly importKind?: 'named' | 'default'
}

/**
 * What an edit did: `added`/`removed`, `unchanged` (already so), or `manual` (the file was left
 * alone; `manual` holds the lines to write by hand).
 *
 * @example
 * const result: AppPatchResult = { file: 'bootstrap/providers.ts', status: 'added', manual: [] }
 */
export interface AppPatchResult {
  readonly file: string
  readonly status: 'added' | 'removed' | 'unchanged' | 'manual'
  readonly manual: readonly string[]
}

/**
 * Edits `bootstrap/providers.ts` and `config/index.ts`.
 *
 * @example
 * const app = createAppPatcher(context.fs, { log: context.log })
 * await app.addProvider({ specifier: '@strutvane/health/provider', name: 'HealthServiceProvider' })
 * await app.addConfig({ specifier: './health.ts', name: 'health' })
 */
export interface AppPatcher {
  /** Import the provider and append it to the provider list. */
  addProvider(entry: AppListEntry): Promise<AppPatchResult>
  /** Remove the provider from the list, and its import. */
  removeProvider(entry: AppListEntry): Promise<AppPatchResult>
  /** Import a config file and add it to `config/index.ts`'s object. */
  addConfig(entry: AppListEntry): Promise<AppPatchResult>
  /** Remove a config file from `config/index.ts`, and its import. */
  removeConfig(entry: AppListEntry): Promise<AppPatchResult>
}

/** The file access the patcher needs (a devkit `StagedFs` fits). */
export interface AppPatcherFs {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, content: string, options?: { readonly overwrite?: boolean }): Promise<void>
}

/** Options for {@link createAppPatcher}. */
export interface AppPatcherOptions {
  /** Default `bootstrap/providers.ts`. */
  readonly providersPath?: string
  /** Default `config/index.ts`. */
  readonly configIndexPath?: string
  /** Where "do this by hand" instructions are printed (an installer's `context.log`). */
  readonly log?: { warn(message: string): void }
}

/** The default location of the provider list. */
export const PROVIDERS_FILE = 'bootstrap/providers.ts'
/** The default location of the config file index. */
export const CONFIG_INDEX_FILE = 'config/index.ts'

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type Kind = 'provider' | 'config'

/** Where the list is and which imports exist. */
interface AppShape {
  readonly imports: readonly ImportDeclaration[]
  readonly firstStatement: AstNode | undefined
  readonly list: ListNode
  /** The names listed (identifiers, or object keys for config). */
  readonly listed: readonly { readonly name: string; readonly index: number }[]
}

/** A declaration's `ImportSpecifier`s etc. as we read them. */
interface ImportSpecifierNode extends AstNode {
  readonly local: Identifier
  readonly imported?: AstNode & { readonly name?: string; readonly value?: unknown }
}

/** Parse the file and find the list; `undefined` when the shape isn't one we edit. */
function analyse(source: string, kind: Kind): AppShape | undefined {
  let body: readonly AstNode[]
  try {
    body = (parseModule(source).$ast as unknown as { body: AstNode[] }).body
  } catch {
    return undefined
  }
  const imports = body.filter((n): n is ImportDeclaration => n.type === 'ImportDeclaration')
  const target = kind === 'provider' ? providerArray(body) : configObject(body)
  if (target === undefined) return undefined
  const list = asList(target, kind === 'provider' ? 'elements' : 'properties')
  const listed: { name: string; index: number }[] = []
  for (const [index, item] of list.items.entries()) {
    const name = kind === 'provider' ? identifierName(item) : propertyName(item)
    // A spread or a computed entry: we can't tell what the list holds, so we don't touch it.
    if (name === undefined) return undefined
    listed.push({ name, index })
  }
  return { imports, firstStatement: body[0], list, listed }
}

function identifierName(node: AstNode): string | undefined {
  return node.type === 'Identifier' ? (node as Identifier).name : undefined
}

function propertyName(node: AstNode): string | undefined {
  if (node.type !== 'ObjectProperty') return undefined
  const property = node as AstNode & { computed: boolean; key: AstNode & { name?: string } }
  if (property.computed || property.key.type !== 'Identifier') return undefined
  return property.key.name
}

/** `const providers = [...]` (exported or not), else `export default [...]`. */
function providerArray(body: readonly AstNode[]): AstNode | undefined {
  for (const statement of body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') : statement
    if (declaration?.type !== 'VariableDeclaration') continue
    const declarators = (declaration as unknown as { declarations: AstNode[] }).declarations
    for (const declarator of declarators) {
      const id = child(declarator, 'id')
      const init = unwrap(child(declarator, 'init'))
      if (id?.type === 'Identifier' && (id as Identifier).name === 'providers')
        return init?.type === 'ArrayExpression' ? init : undefined
    }
  }
  const exported = body.find((n) => n.type === 'ExportDefaultDeclaration')
  const value = unwrap(exported === undefined ? undefined : child(exported, 'declaration'))
  return value?.type === 'ArrayExpression' ? value : undefined
}

/** `export default { ... }`, possibly wrapped (`satisfies`, `as`, a call). */
function configObject(body: readonly AstNode[]): AstNode | undefined {
  const exported = body.find((n) => n.type === 'ExportDefaultDeclaration')
  let value = unwrap(exported === undefined ? undefined : child(exported, 'declaration'))
  if (value?.type === 'CallExpression')
    value = unwrap((value as unknown as { arguments: AstNode[] }).arguments[0])
  return value?.type === 'ObjectExpression' ? value : undefined
}

/** Does `declaration` import `entry.name` the way `entry` wants? */
function importsEntry(declaration: ImportDeclaration, entry: Required<AppListEntry>): boolean {
  if (declaration.source.value !== entry.specifier) return false
  return (declaration.specifiers as readonly ImportSpecifierNode[]).some((specifier) =>
    entry.importKind === 'default'
      ? specifier.type === 'ImportDefaultSpecifier' && specifier.local.name === entry.name
      : specifier.type === 'ImportSpecifier' &&
        specifier.local.name === entry.name &&
        (specifier.imported?.name ?? specifier.imported?.value) === entry.name,
  )
}

/** Is `name` already bound in the file by something other than our import? */
function nameTaken(source: string, shape: AppShape, entry: Required<AppListEntry>): boolean {
  const otherImport = shape.imports.some(
    (declaration) =>
      !importsEntry(declaration, entry) &&
      declaration.specifiers.some((specifier) => specifier.local.name === entry.name),
  )
  return (
    otherImport ||
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${entry.name}\\b`).test(source)
  )
}

/**
 * Create the patcher over a file system (an installer's staged fs: nothing is written until the
 * install commits).
 *
 * @example
 * const app = createAppPatcher(context.fs, { log: context.log })
 */
export function createAppPatcher(fs: AppPatcherFs, options: AppPatcherOptions = {}): AppPatcher {
  const paths: Readonly<Record<Kind, string>> = {
    provider: options.providersPath ?? PROVIDERS_FILE,
    config: options.configIndexPath ?? CONFIG_INDEX_FILE,
  }

  const complete = (entry: AppListEntry, kind: Kind): Required<AppListEntry> => {
    if (!isSafeSpecifier(entry.specifier))
      throw new DevkitError('invalid_path', `"${entry.specifier}" is not a valid module specifier`)
    if (!IDENT.test(entry.name))
      throw new DevkitError('invalid_path', `"${entry.name}" is not a valid identifier`)
    return {
      specifier: entry.specifier,
      name: entry.name,
      importKind: entry.importKind ?? (kind === 'provider' ? 'named' : 'default'),
    }
  }

  const clause = (entry: Required<AppListEntry>): string =>
    entry.importKind === 'named' ? `{ ${entry.name} }` : entry.name

  /** The by-hand instructions, printed once, returned with the result. */
  const manual = (
    kind: Kind,
    entry: Required<AppListEntry>,
    adding: boolean,
    why: string,
  ): AppPatchResult => {
    const file = paths[kind]
    const where = kind === 'provider' ? 'the providers list' : 'the object exported by default'
    const lines = adding
      ? [
          `import ${clause(entry)} from '${entry.specifier}'`,
          `add ${entry.name} to ${where} in ${file}`,
        ]
      : [
          `remove the import of ${entry.name} from '${entry.specifier}'`,
          `remove ${entry.name} from ${where} in ${file}`,
        ]
    options.log?.warn(
      `${file} was not changed (${why}). ${adding ? 'Add' : 'Remove'} it by hand:\n  ${lines.join('\n  ')}`,
    )
    return { file, status: 'manual', manual: lines }
  }

  const add = async (kind: Kind, given: AppListEntry): Promise<AppPatchResult> => {
    const entry = complete(given, kind)
    const file = paths[kind]
    if (!(await fs.exists(file))) return manual(kind, entry, true, 'the file does not exist')
    const text = normalise(await fs.read(file))
    const source = text.text
    const shape = analyse(source, kind)
    if (shape === undefined)
      return manual(kind, entry, true, 'its shape is not one the installer edits')
    const imported = shape.imports.some((declaration) => importsEntry(declaration, entry))
    const listed = shape.listed.some((item) => item.name === entry.name)
    if (imported && listed) return { file, status: 'unchanged', manual: [] }
    if (!imported && nameTaken(source, shape, entry))
      return manual(kind, entry, true, `"${entry.name}" already means something else there`)
    const edits: TextEdit[] = []
    if (!listed) edits.push(...appendItem(source, shape.list, entry.name, entry.name))
    if (!imported)
      edits.push(insertImport(shape, importLine(source, shape, clause(entry), entry.specifier)))
    const code = applyEdits(source, edits)
    const check = analyse(code, kind)
    const ok =
      check?.imports.some((declaration) => importsEntry(declaration, entry)) === true &&
      check.listed.some((item) => item.name === entry.name)
    if (!ok) return manual(kind, entry, true, 'the edit could not be verified')
    await fs.write(file, text.restore(code), { overwrite: true })
    return { file, status: 'added', manual: [] }
  }

  const remove = async (kind: Kind, given: AppListEntry): Promise<AppPatchResult> => {
    const entry = complete(given, kind)
    const file = paths[kind]
    if (!(await fs.exists(file))) return { file, status: 'unchanged', manual: [] }
    const text = normalise(await fs.read(file))
    const source = text.text
    const shape = analyse(source, kind)
    if (shape === undefined)
      return manual(kind, entry, false, 'its shape is not one the installer edits')
    const declarations = shape.imports.filter((declaration) => importsEntry(declaration, entry))
    const items = shape.listed.filter((item) => item.name === entry.name)
    if (declarations.length === 0 && items.length === 0)
      return { file, status: 'unchanged', manual: [] }
    // `import { A, ours } from '…'`: deleting the line would break A, so only our own lines go.
    if (declarations.some((declaration) => declaration.specifiers.length !== 1))
      return manual(kind, entry, false, `its import of ${entry.name} also imports other names`)
    const edits: TextEdit[] = [
      ...items.flatMap((item) => removeItem(source, shape.list, item.index)),
      ...declarations.map((declaration) => removeStatement(source, declaration)),
    ]
    const code = applyEdits(source, edits)
    const check = analyse(code, kind)
    const ok =
      check !== undefined &&
      !check.imports.some((declaration) => importsEntry(declaration, entry)) &&
      !check.listed.some((item) => item.name === entry.name)
    if (!ok) return manual(kind, entry, false, 'the edit could not be verified')
    await fs.write(file, text.restore(code), { overwrite: true })
    return { file, status: 'removed', manual: [] }
  }

  return {
    addProvider: (entry) => add('provider', entry),
    removeProvider: (entry) => remove('provider', entry),
    addConfig: (entry) => add('config', entry),
    removeConfig: (entry) => remove('config', entry),
  }
}
