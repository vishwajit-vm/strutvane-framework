/**
 * A small, safe message formatter for `{param}` placeholders and ICU-style plurals.
 *
 * Supported syntax:
 * - `{name}`: the parameter value (numbers are formatted for the locale: `1,250.5`).
 * - `{count, plural, =0 {no items} one {# item} other {# items}}`: chooses a branch by exact
 *   value (`=n`) first, then by the locale's plural rules (`one`, `few`, `many`, …), then `other`.
 *   Inside a branch, `#` is the formatted number. Branches may contain placeholders and plurals.
 *
 * **Never throws and never evaluates code.** Message templates come from translation files that
 * may be edited by non-developers, so malformed syntax degrades to literal text (and is reported in
 * `malformed`). A missing parameter is left visible as `{name}` (and reported in `missing`), so a
 * mistake shows up in the UI instead of silently producing a half sentence.
 *
 * @module
 */

/** A value that can be substituted into a message. */
export type MessageParam = string | number | boolean

/** The result of formatting. */
export interface FormatResult {
  readonly text: string
  /** Parameter names that were referenced but not provided. */
  readonly missing: readonly string[]
  /** Whether the template contained syntax errors (rendered literally). */
  readonly malformed: boolean
}

type Node =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'arg'; readonly name: string }
  | { readonly kind: 'pound' }
  | {
      readonly kind: 'plural'
      readonly name: string
      readonly options: ReadonlyMap<string, readonly Node[]>
    }

const IDENT = /^[A-Za-z_][\w.-]*$/
const MAX_DEPTH = 8
const MAX_TEMPLATE_LENGTH = 10_000

interface ParseState {
  readonly src: string
  pos: number
  malformed: boolean
}

/** Parse until end of input (depth 0) or until the closing `}` of a plural branch. */
function parseNodes(state: ParseState, depth: number, inBranch: boolean): Node[] {
  const nodes: Node[] = []
  let text = ''
  const flush = (): void => {
    if (text) nodes.push({ kind: 'text', value: text })
    text = ''
  }
  while (state.pos < state.src.length) {
    const ch = state.src[state.pos] as string
    if (ch === '}' && inBranch) break
    if (ch === '#' && inBranch) {
      flush()
      nodes.push({ kind: 'pound' })
      state.pos++
      continue
    }
    if (ch === '{') {
      const start = state.pos
      const node = depth < MAX_DEPTH ? parseArgument(state, depth) : undefined
      if (node) {
        flush()
        nodes.push(node)
      } else {
        // Malformed: keep the brace as literal text and continue after it.
        state.malformed = true
        state.pos = start + 1
        text += '{'
      }
      continue
    }
    text += ch
    state.pos++
  }
  flush()
  return nodes
}

/** Parse `{name}` or `{name, plural, ...}` starting at `{`. Returns undefined if malformed. */
function parseArgument(state: ParseState, depth: number): Node | undefined {
  const { src } = state
  const close = src.indexOf('}', state.pos)
  const comma = src.indexOf(',', state.pos)
  if (close === -1) return undefined
  if (comma === -1 || comma > close) {
    const name = src.slice(state.pos + 1, close).trim()
    if (!IDENT.test(name)) return undefined
    state.pos = close + 1
    return { kind: 'arg', name }
  }
  const name = src.slice(state.pos + 1, comma).trim()
  if (!IDENT.test(name)) return undefined
  const typeEnd = src.indexOf(',', comma + 1)
  if (typeEnd === -1 || src.slice(comma + 1, typeEnd).trim() !== 'plural') return undefined
  let pos = typeEnd + 1
  const options = new Map<string, readonly Node[]>()
  for (;;) {
    while (pos < src.length && /\s/.test(src[pos] as string)) pos++
    if (src[pos] === '}') {
      state.pos = pos + 1
      return options.has('other') ? { kind: 'plural', name, options } : undefined
    }
    const selectorMatch = /^(=\d+|zero|one|two|few|many|other)\s*\{/.exec(src.slice(pos, pos + 32))
    if (!selectorMatch?.[1]) return undefined
    const selector = selectorMatch[1]
    const branchState: ParseState = { src, pos: pos + selectorMatch[0].length, malformed: false }
    const branch = parseNodes(branchState, depth + 1, true)
    if (src[branchState.pos] !== '}') return undefined
    if (branchState.malformed) state.malformed = true
    options.set(selector, branch)
    pos = branchState.pos + 1
  }
}

function formatNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value)
  } catch {
    return new Intl.NumberFormat('en').format(value)
  }
}

function pluralCategory(value: number, locale: string): string {
  try {
    return new Intl.PluralRules(locale).select(value)
  } catch {
    return new Intl.PluralRules('en').select(value)
  }
}

function render(
  nodes: readonly Node[],
  params: Readonly<Record<string, MessageParam | undefined>>,
  locale: string,
  missing: Set<string>,
  pound: string | undefined,
): string {
  let out = ''
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value
        break
      case 'pound':
        out += pound ?? '#'
        break
      case 'arg': {
        // Own params only: `{constructor}` must render as missing, not as an inherited function.
        const value = Object.hasOwn(params, node.name) ? params[node.name] : undefined
        if (value === undefined) {
          missing.add(node.name)
          out += `{${node.name}}`
        } else {
          out += typeof value === 'number' ? formatNumber(value, locale) : String(value)
        }
        break
      }
      case 'plural': {
        const raw = Object.hasOwn(params, node.name) ? params[node.name] : undefined
        const value = typeof raw === 'number' ? raw : Number(raw)
        if (raw === undefined || !Number.isFinite(value)) missing.add(node.name)
        const n = Number.isFinite(value) ? value : 0
        const branch =
          node.options.get(`=${n}`) ??
          node.options.get(pluralCategory(n, locale)) ??
          node.options.get('other')
        out += render(branch ?? [], params, locale, missing, formatNumber(n, locale))
        break
      }
    }
  }
  return out
}

/** Format a message template. Never throws. */
export function formatMessage(
  template: string,
  params: Readonly<Record<string, MessageParam | undefined>> = {},
  locale = 'en',
): FormatResult {
  const source = typeof template === 'string' ? template : String(template)
  if (source.length > MAX_TEMPLATE_LENGTH) {
    return { text: source, missing: [], malformed: true }
  }
  const state: ParseState = { src: source, pos: 0, malformed: false }
  const nodes = parseNodes(state, 0, false)
  const missing = new Set<string>()
  const text = render(nodes, params, locale, missing, undefined)
  return { text, missing: [...missing], malformed: state.malformed }
}
