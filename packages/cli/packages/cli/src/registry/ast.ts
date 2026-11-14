/**
 * Minimal, defensive helpers over oxc-parser's ESTree-compatible AST.
 *
 * The AST is treated as untrusted `unknown` data and narrowed with runtime checks. That keeps the
 * analyzer independent of the exact AST type package version and makes every assumption explicit.
 */

export interface AstNode {
  readonly type: string
  /** UTF-16 offset of the node start. */
  readonly start: number
  readonly end: number
}

type Obj = Record<string, unknown>

export function isNode(value: unknown): value is AstNode & Obj {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Obj)['type'] === 'string' &&
    typeof (value as Obj)['start'] === 'number'
  )
}

/** A child node under `key`, or `undefined`. */
export function child(node: AstNode & Obj, key: string): (AstNode & Obj) | undefined {
  const value = node[key]
  return isNode(value) ? value : undefined
}

/** Child nodes in the array under `key` (non-nodes, e.g. array holes, are dropped). */
export function children(node: AstNode & Obj, key: string): (AstNode & Obj)[] {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

/** Strip wrappers that do not change the runtime value: `( … )`, `as`, `satisfies`, `!`. */
export function unwrap(node: AstNode & Obj): AstNode & Obj {
  let current = node
  for (;;) {
    if (
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression'
    ) {
      const inner = child(current, 'expression')
      if (inner === undefined) return current
      current = inner
    } else {
      return current
    }
  }
}

/** The value of a string literal or an expression-free template literal; otherwise `undefined`. */
export function stringValue(node: (AstNode & Obj) | undefined): string | undefined {
  if (node === undefined) return undefined
  const n = unwrap(node)
  if (n.type === 'Literal' && typeof n['value'] === 'string') return n['value']
  if (n.type === 'TemplateLiteral' && children(n, 'expressions').length === 0) {
    const quasi = children(n, 'quasis')[0]
    const value = quasi?.['value']
    if (typeof value === 'object' && value !== null) {
      const cooked = (value as Obj)['cooked']
      if (typeof cooked === 'string') return cooked
    }
  }
  return undefined
}

/** The value of a boolean literal; otherwise `undefined`. */
export function booleanValue(node: (AstNode & Obj) | undefined): boolean | undefined {
  if (node === undefined) return undefined
  const n = unwrap(node)
  return n.type === 'Literal' && typeof n['value'] === 'boolean' ? n['value'] : undefined
}

/** Name of an identifier node. */
export function identifierName(node: (AstNode & Obj) | undefined): string | undefined {
  if (node === undefined) return undefined
  return node.type === 'Identifier' && typeof node['name'] === 'string' ? node['name'] : undefined
}

export interface StaticProperty {
  readonly key: string
  readonly value: AstNode & Obj
  readonly start: number
}

export type ObjectReadResult =
  | { readonly ok: true; readonly properties: readonly StaticProperty[] }
  | {
      readonly ok: false
      readonly reason: 'not-an-object' | 'dynamic-property'
      readonly at: number
    }

/**
 * Read an object literal whose keys are all static. Spreads (`...x`) and computed keys (`[k]: v`)
 * make the object impossible to read without running code, so they are reported, never guessed.
 */
export function readObject(
  node: (AstNode & Obj) | undefined,
  fallbackAt: number,
): ObjectReadResult {
  if (node === undefined) return { ok: false, reason: 'not-an-object', at: fallbackAt }
  const n = unwrap(node)
  if (n.type !== 'ObjectExpression') return { ok: false, reason: 'not-an-object', at: n.start }
  const properties: StaticProperty[] = []
  for (const prop of children(n, 'properties')) {
    if (prop.type !== 'Property' || prop['computed'] === true) {
      return { ok: false, reason: 'dynamic-property', at: prop.start }
    }
    const keyNode = child(prop, 'key')
    const key = identifierName(keyNode) ?? stringValue(keyNode)
    const value = child(prop, 'value')
    if (key === undefined || value === undefined) {
      return { ok: false, reason: 'dynamic-property', at: prop.start }
    }
    properties.push({ key, value, start: prop.start })
  }
  return { ok: true, properties }
}

export interface ImportBinding {
  /** Imported name (`default` for default imports). */
  readonly imported: string
  /** Module specifier. */
  readonly source: string
}

/** Map of local name → value import binding (type-only imports are ignored). */
export function collectImports(program: AstNode & Obj): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const statement of children(program, 'body')) {
    if (statement.type !== 'ImportDeclaration' || statement['importKind'] === 'type') continue
    const source = stringValue(child(statement, 'source'))
    if (source === undefined) continue
    for (const spec of children(statement, 'specifiers')) {
      if (spec['importKind'] === 'type') continue
      const local = identifierName(child(spec, 'local'))
      if (local === undefined) continue
      if (spec.type === 'ImportSpecifier') {
        const importedNode = child(spec, 'imported')
        const imported = identifierName(importedNode) ?? stringValue(importedNode)
        if (imported !== undefined) bindings.set(local, { imported, source })
      } else if (spec.type === 'ImportDefaultSpecifier') {
        bindings.set(local, { imported: 'default', source })
      }
    }
  }
  return bindings
}
