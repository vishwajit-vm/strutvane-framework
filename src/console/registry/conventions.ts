/**
 * The file conventions Strutvane discovers. This table is the single source of truth: discovery,
 * analysis and docs all read it, so adding a convention is a one-line change.
 */

export type EntryKind =
  | 'model'
  | 'resource'
  | 'policy'
  | 'route'
  | 'job'
  | 'listener'
  | 'command'
  | 'page'

export interface Convention {
  readonly kind: EntryKind
  /** Directory relative to the project root, POSIX separators. */
  readonly dir: string
  /** Required file-name suffix (case-sensitive). */
  readonly suffix: string
  /** Whether sub-directories are searched. */
  readonly recursive: boolean
  /**
   * The framework function the file must default-export a call to (e.g. `defineModel`).
   * `undefined` for conventions with a different shape (routes: an array; pages: not parsed).
   */
  readonly define: string | undefined
}

export const CONVENTIONS: readonly Convention[] = [
  {
    kind: 'model',
    dir: 'app/models',
    suffix: '.model.ts',
    recursive: false,
    define: 'defineModel',
  },
  {
    kind: 'resource',
    dir: 'app/resources',
    suffix: '.resource.ts',
    recursive: false,
    define: 'defineResource',
  },
  {
    kind: 'policy',
    dir: 'app/policies',
    suffix: '.policy.ts',
    recursive: false,
    define: 'definePolicy',
  },
  { kind: 'route', dir: 'app/http/routes', suffix: '.ts', recursive: false, define: undefined },
  { kind: 'job', dir: 'app/jobs', suffix: '.job.ts', recursive: false, define: 'defineJob' },
  {
    kind: 'listener',
    dir: 'app/listeners',
    suffix: '.listener.ts',
    recursive: false,
    define: 'defineListener',
  },
  {
    kind: 'command',
    dir: 'app/commands',
    suffix: '.command.ts',
    recursive: false,
    define: 'defineCommand',
  },
  { kind: 'page', dir: 'web/pages', suffix: '.tsx', recursive: true, define: undefined },
]

/** Modules the `define*` helpers may be imported from. Anything else is rejected. */
export const FRAMEWORK_MODULES: readonly string[] = [
  '@strutvane/framework',
  '@strutvane/framework/http',
]

/**
 * Extra modules allowed for specific `define*` functions. Policies are an `@strutvane/auth`
 * feature (docs/07), so `definePolicy` may come from there as well as from the framework.
 */
export const EXTRA_DEFINE_MODULES: Readonly<Record<string, readonly string[]>> = {
  definePolicy: ['@strutvane/auth'],
}

/** Whether `define` may be imported from `source`. */
export function isAllowedDefineSource(define: string, source: string): boolean {
  return FRAMEWORK_MODULES.includes(source) || (EXTRA_DEFINE_MODULES[define] ?? []).includes(source)
}

/** Every `define*` function name, so a call in the wrong directory gets a precise error. */
export const DEFINE_FUNCTIONS: ReadonlySet<string> = new Set(
  CONVENTIONS.flatMap((c) => (c.define === undefined ? [] : [c.define])),
)

/** HTTP methods a route file may declare via `route.<method>(...)`. */
export const ROUTE_METHODS: readonly string[] = ['get', 'post', 'put', 'patch', 'delete']

/** Where the generated registry is written, relative to the project root. */
export const OUTPUT_FILE: string = '.strutvane/registry.gen.ts'
