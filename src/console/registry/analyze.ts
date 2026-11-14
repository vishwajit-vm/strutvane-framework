/**
 * Static analysis of one convention file. User code is parsed, NEVER executed: discovery must be
 * safe (no side effects, no secrets read, no network) and fast enough for watch mode.
 *
 * Parser: oxc-parser (Rust, native binding). See README §Design for the measured comparison with
 * the TypeScript 6 compiler API.
 */
import { parseSync } from 'oxc-parser'
import {
  type AstNode,
  booleanValue,
  child,
  children,
  collectImports,
  type ImportBinding,
  identifierName,
  isNode,
  readObject,
  stringValue,
  unwrap,
} from './ast.ts'
import {
  DEFINE_FUNCTIONS,
  FRAMEWORK_MODULES,
  isAllowedDefineSource,
  ROUTE_METHODS,
} from './conventions.ts'
import type { DiscoveredFile } from './discover.ts'
import { type Diagnostic, diagnosticAt, lineColumn } from './errors.ts'
import { isPascalCase, modelNameFromFile, pageRoute } from './names.ts'
import { resolveRelativeImport } from './paths.ts'

export interface Position {
  readonly line: number
  readonly column: number
}

/** What static analysis can tell about one model field (`field.<type>(…)…`). */
export interface ModelField {
  readonly name: string
  /** The `field.<type>` builder, or `undefined` when the value is not a builder chain. */
  readonly type: string | undefined
  /** For relations: the related model's name (first string argument). */
  readonly target: string | undefined
  /** For `enum`/`set`: the literal values (first argument, an array of strings). */
  readonly values: readonly string[] | undefined
}

export interface ModelEntry {
  readonly kind: 'model'
  readonly file: string
  readonly name: string
  readonly fields: readonly string[]
  readonly fieldDetails: readonly ModelField[]
  readonly softDeletes: boolean
  readonly tenant: boolean
  /** `api: false` in the model options disables the automatic CRUD API. */
  readonly api: boolean
  readonly at: Position
}

const RELATION_TYPES: ReadonlySet<string> = new Set([
  'belongsTo',
  'hasOne',
  'hasMany',
  'manyToMany',
  'morphMany',
])

/**
 * Read `field.decimal(12, 2).min(0)` as `{ type: 'decimal' }` by walking the call chain down to
 * its root. Anything that is not such a chain (a helper call, a variable) has an unknown type;
 * that is not an error, the framework still validates it at runtime.
 */
function describeField(name: string, value: Node): ModelField {
  let current: Node | undefined = unwrap(value)
  while (current !== undefined && current.type === 'CallExpression') {
    const callee = child(current, 'callee')
    if (callee === undefined || callee.type !== 'MemberExpression' || callee['computed'] === true)
      break
    const object = child(callee, 'object')
    const property = identifierName(child(callee, 'property'))
    const root = object === undefined ? undefined : unwrap(object)
    if (root !== undefined && root.type === 'Identifier' && identifierName(root) === 'field') {
      const target =
        property !== undefined && RELATION_TYPES.has(property)
          ? stringValue(children(current, 'arguments')[0])
          : undefined
      const first = children(current, 'arguments')[0]
      return { name, type: property, target, values: stringList(first) }
    }
    current = root
  }
  return { name, type: undefined, target: undefined, values: undefined }
}

/** `['draft', 'paid']` → the strings; `undefined` for anything else. */
function stringList(node: Node | undefined): string[] | undefined {
  const value = node === undefined ? undefined : unwrap(node)
  if (value === undefined || value.type !== 'ArrayExpression') return undefined
  const out: string[] = []
  for (const element of children(value, 'elements')) {
    const s = stringValue(element)
    if (s === undefined) return undefined
    out.push(s)
  }
  return out
}

export interface ActionEntry {
  readonly name: string
  /** Explicit permission, if the action declares one. */
  readonly permission: string | undefined
  readonly at: Position
}

export interface ResourceEntry {
  readonly kind: 'resource'
  readonly file: string
  /** The model, referenced either by its file (via an import) or by its name (string literal). */
  readonly modelRef: { readonly file: string } | { readonly name: string }
  readonly actions: readonly ActionEntry[]
  readonly at: Position
}

export interface PolicyEntry {
  readonly kind: 'policy'
  readonly file: string
  /** Resource key, e.g. `invoice`. */
  readonly resource: string
  readonly at: Position
}

export interface RouteEntry {
  readonly kind: 'route'
  readonly file: string
  readonly method: string
  readonly path: string
  readonly name: string | undefined
  readonly permission: string | undefined
  readonly at: Position
}

export interface NamedEntry {
  readonly kind: 'job' | 'listener' | 'command'
  readonly file: string
  /** Job name, event name (listeners) or command name. */
  readonly name: string
  readonly at: Position
}

export interface PageEntry {
  readonly kind: 'page'
  readonly file: string
  readonly route: string
  readonly at: Position
}

export type Entry = ModelEntry | ResourceEntry | PolicyEntry | RouteEntry | NamedEntry | PageEntry

export interface FileAnalysis {
  readonly file: string
  readonly entries: readonly Entry[]
  readonly diagnostics: readonly Diagnostic[]
}

type Node = AstNode & Record<string, unknown>

/** Analyze one file's text. Pure: same input → same output. */
export function analyzeFile(file: DiscoveredFile, text: string): FileAnalysis {
  const { relPath, convention } = file
  const diagnostics: Diagnostic[] = []
  const pos = (offset: number): Position => lineColumn(text, offset)
  const report = (
    code: Diagnostic['code'],
    offset: number,
    message: string,
    hint?: string,
    severity: Diagnostic['severity'] = 'error',
  ): void => {
    diagnostics.push(diagnosticAt(code, severity, relPath, text, offset, message, hint))
  }
  const done = (entries: Entry[]): FileAnalysis => ({ file: relPath, entries, diagnostics })

  // Pages are not parsed: their URL comes from the file path alone.
  if (convention.kind === 'page') {
    return done([
      {
        kind: 'page',
        file: relPath,
        route: pageRoute(relPath, convention.dir, convention.suffix),
        at: pos(0),
      },
    ])
  }

  const parsed = parseSync(relPath, text, { sourceType: 'module' })
  const parseErrors = parsed.errors.filter((e) => e.severity === 'Error')
  if (parseErrors.length > 0) {
    for (const error of parseErrors) {
      report(
        'PARSE_ERROR',
        error.labels[0]?.start ?? 0,
        error.message,
        'Fix the syntax error; the file could not be read.',
      )
    }
    return done([])
  }
  const program: unknown = parsed.program
  if (!isNode(program)) return done([])

  const exportDefault = children(program, 'body').find((s) => s.type === 'ExportDefaultDeclaration')
  if (exportDefault === undefined) {
    const expected =
      convention.define === undefined
        ? 'export default [ route.get(…) ]'
        : `export default ${convention.define}(…)`
    report('MISSING_DEFAULT_EXPORT', 0, `No default export found.`, `Add \`${expected}\`.`)
    return done([])
  }
  const declaration = child(exportDefault, 'declaration')
  const value = declaration === undefined ? undefined : unwrap(declaration)
  if (value === undefined) {
    report(
      'UNEXPECTED_DEFAULT_EXPORT',
      exportDefault.start,
      'The default export could not be read.',
    )
    return done([])
  }
  const imports = collectImports(program)

  if (convention.kind === 'route') return done(analyzeRoutes(value, imports))

  // Every other convention default-exports a call to its define* function.
  const expected = convention.define ?? ''
  if (value.type !== 'CallExpression') {
    report(
      'UNEXPECTED_DEFAULT_EXPORT',
      value.start,
      `The default export must be a call to ${expected}(…).`,
      `Write \`export default ${expected}(…)\`. Strutvane reads this call without running your code.`,
    )
    return done([])
  }
  const calleeLocal = identifierName(child(value, 'callee'))
  const binding = calleeLocal === undefined ? undefined : imports.get(calleeLocal)
  const fromFramework =
    binding !== undefined && isAllowedDefineSource(binding.imported, binding.source)
  if (!fromFramework || binding === undefined) {
    if (calleeLocal !== undefined && DEFINE_FUNCTIONS.has(calleeLocal)) {
      report(
        'NOT_IMPORTED_FROM_FRAMEWORK',
        value.start,
        `${calleeLocal} is not imported from @strutvane/framework.`,
        `Add \`import { ${calleeLocal} } from '@strutvane/framework'\`.`,
      )
    } else {
      report(
        'UNEXPECTED_DEFAULT_EXPORT',
        value.start,
        `The default export must be a call to ${expected}(…) from @strutvane/framework.`,
        `Write \`export default ${expected}(…)\`.`,
      )
    }
    return done([])
  }
  if (binding.imported !== expected) {
    const right = DEFINE_FUNCTIONS.has(binding.imported)
      ? ` ${binding.imported} files belong in a different folder.`
      : ''
    report(
      'UNEXPECTED_DEFAULT_EXPORT',
      value.start,
      `Expected ${expected}(…) in ${convention.dir}, found ${binding.imported}(…).${right}`,
      `Use ${expected}(…) here, or move the file to the folder for ${binding.imported}.`,
    )
    return done([])
  }

  const args = children(value, 'arguments')
  const at = pos(value.start)
  switch (convention.kind) {
    case 'model':
      return done(analyzeModel(args, value.start, at))
    case 'resource':
      return done(analyzeResource(args, value.start, at))
    case 'policy': {
      const resource = requireString(args[0], value.start, 'The resource key (first argument)')
      return done(resource === undefined ? [] : [{ kind: 'policy', file: relPath, resource, at }])
    }
    case 'job':
    case 'listener':
    case 'command': {
      const label =
        convention.kind === 'listener' ? 'The event name' : `The ${convention.kind} name`
      const name = requireString(args[0], value.start, `${label} (first argument)`)
      return done(name === undefined ? [] : [{ kind: convention.kind, file: relPath, name, at }])
    }
  }

  // ---- helpers (closures over this file's text and diagnostics) ----

  function requireString(
    node: Node | undefined,
    fallback: number,
    what: string,
  ): string | undefined {
    const s = stringValue(node)
    if (s === undefined) {
      report(
        'NON_LITERAL_ARGUMENT',
        node?.start ?? fallback,
        `${what} must be a string literal.`,
        'Use a plain string like "invoice". Strutvane reads it without running your code, so variables and expressions cannot be resolved.',
      )
    }
    return s
  }

  function analyzeModel(args: Node[], callStart: number, at: Position): Entry[] {
    const name = requireString(args[0], callStart, 'The model name (first argument)')
    if (name === undefined) return []
    let ok = true
    if (!isPascalCase(name)) {
      ok = false
      report(
        'INVALID_MODEL_NAME',
        args[0]?.start ?? callStart,
        `Model name "${name}" must be PascalCase.`,
        'Example: "InvoiceLine".',
      )
    }
    const suggested = modelNameFromFile(
      relPath.slice(relPath.lastIndexOf('/') + 1),
      convention.suffix,
    )
    if (ok && suggested !== name) {
      report(
        'FILE_NAME_MISMATCH',
        args[0]?.start ?? callStart,
        `Model "${name}" is defined in a file named for "${suggested}".`,
        `Rename the file to match the model, so it is easy to find.`,
        'warning',
      )
    }
    const fields = readObject(args[1], callStart)
    if (!fields.ok) {
      report(
        'NON_LITERAL_ARGUMENT',
        fields.at,
        fields.reason === 'not-an-object'
          ? 'The fields (second argument) must be an object literal.'
          : 'Fields must have static names; spreads and computed keys cannot be read without running code.',
        'List every field directly: { number: field.string(), … }',
      )
      return []
    }
    let softDeletes = false
    let tenant = false
    let api = true
    if (args[2] !== undefined) {
      const options = readObject(args[2], callStart)
      if (!options.ok) {
        report(
          'NON_LITERAL_ARGUMENT',
          options.at,
          'The model options (third argument) must be an object literal with static keys.',
        )
        return []
      }
      for (const option of options.properties) {
        if (option.key !== 'softDeletes' && option.key !== 'tenant' && option.key !== 'api')
          continue
        const flag = booleanValue(option.value)
        if (flag === undefined) {
          report(
            'NON_LITERAL_ARGUMENT',
            option.value.start,
            `Option "${option.key}" must be true or false.`,
          )
          return []
        }
        if (option.key === 'softDeletes') softDeletes = flag
        else if (option.key === 'api') api = flag
        else tenant = flag
      }
    }
    if (!ok) return []
    return [
      {
        kind: 'model',
        file: relPath,
        name,
        fields: fields.properties.map((p) => p.key),
        fieldDetails: fields.properties.map((p) => describeField(p.key, p.value)),
        softDeletes,
        tenant,
        api,
        at,
      },
    ]
  }

  function analyzeResource(args: Node[], callStart: number, at: Position): Entry[] {
    const first = args[0] === undefined ? undefined : unwrap(args[0])
    let modelRef: ResourceEntry['modelRef'] | undefined
    const literal = stringValue(first)
    const local = identifierName(first)
    if (literal !== undefined) {
      modelRef = { name: literal }
    } else if (local !== undefined) {
      const source = imports.get(local)?.source
      const resolved = source === undefined ? undefined : resolveRelativeImport(relPath, source)
      if (resolved !== undefined) modelRef = { file: resolved }
    }
    if (modelRef === undefined) {
      report(
        'NON_LITERAL_ARGUMENT',
        first?.start ?? callStart,
        'The model (first argument) must be an imported model or a model name string.',
        "Write `import Invoice from '../models/invoice.model.ts'` and `defineResource(Invoice, …)`.",
      )
      return []
    }
    const actions: ActionEntry[] = []
    if (args[1] !== undefined) {
      const options = readObject(args[1], callStart)
      if (!options.ok) {
        report(
          'NON_LITERAL_ARGUMENT',
          options.at,
          'The resource options (second argument) must be an object literal with static keys.',
        )
        return []
      }
      const actionsProp = options.properties.find((p) => p.key === 'actions')
      if (actionsProp !== undefined) {
        const actionObj = readObject(actionsProp.value, actionsProp.start)
        if (!actionObj.ok) {
          report(
            'NON_LITERAL_ARGUMENT',
            actionObj.at,
            'Actions must be an object literal with static action names.',
          )
          return []
        }
        for (const action of actionObj.properties) {
          let permission: string | undefined
          const config = readObject(action.value, action.start)
          if (config.ok) {
            const permProp = config.properties.find((p) => p.key === 'permission')
            if (permProp !== undefined) {
              permission = stringValue(permProp.value)
              if (permission === undefined) {
                report(
                  'NON_LITERAL_ARGUMENT',
                  permProp.value.start,
                  `Permission of action "${action.key}" must be a string literal.`,
                )
                return []
              }
            }
          }
          actions.push({ name: action.key, permission, at: pos(action.start) })
        }
      }
    }
    return [{ kind: 'resource', file: relPath, modelRef, actions, at }]
  }

  function analyzeRoutes(value: Node, importMap: Map<string, ImportBinding>): Entry[] {
    if (value.type !== 'ArrayExpression') {
      report(
        'UNEXPECTED_DEFAULT_EXPORT',
        value.start,
        'A route file must default-export an array of route.<method>(…) calls.',
        "Write `export default [route.get('/path', { … })]`.",
      )
      return []
    }
    const routes: Entry[] = []
    for (const element of children(value, 'elements')) {
      const call = unwrap(element)
      const callee = call.type === 'CallExpression' ? child(call, 'callee') : undefined
      const objectName =
        callee?.type === 'MemberExpression' && callee['computed'] !== true
          ? identifierName(child(callee, 'object'))
          : undefined
      const method = callee === undefined ? undefined : identifierName(child(callee, 'property'))
      const binding = objectName === undefined ? undefined : importMap.get(objectName)
      const isRoute =
        binding !== undefined &&
        binding.imported === 'route' &&
        FRAMEWORK_MODULES.includes(binding.source)
      if (!isRoute || method === undefined || !ROUTE_METHODS.includes(method)) {
        report(
          'INVALID_ROUTE',
          call.start,
          'Each entry must be route.get/post/put/patch/delete(…) imported from @strutvane/framework.',
          "Example: route.post('/reports/revenue', { name: 'reports.revenue', permission: 'report.revenue' })",
        )
        continue
      }
      const args = children(call, 'arguments')
      const path = stringValue(args[0])
      if (path === undefined || !path.startsWith('/')) {
        report(
          'INVALID_ROUTE',
          args[0]?.start ?? call.start,
          'The route path must be a string literal starting with "/".',
        )
        continue
      }
      let name: string | undefined
      let permission: string | undefined
      if (args[1] !== undefined) {
        const options = readObject(args[1], call.start)
        if (!options.ok) {
          report(
            'NON_LITERAL_ARGUMENT',
            options.at,
            'Route options must be an object literal with static keys.',
          )
          continue
        }
        for (const option of options.properties) {
          if (option.key !== 'name' && option.key !== 'permission') continue
          const s = stringValue(option.value)
          if (s === undefined) {
            report(
              'NON_LITERAL_ARGUMENT',
              option.value.start,
              `Route option "${option.key}" must be a string literal.`,
            )
            continue
          }
          if (option.key === 'name') name = s
          else permission = s
        }
      }
      routes.push({
        kind: 'route',
        file: relPath,
        method: method.toUpperCase(),
        path,
        name,
        permission,
        at: pos(call.start),
      })
    }
    return routes
  }
}
