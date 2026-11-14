// Minimal typed stand-in for @strutvane/framework, so generated registries can be type-checked.
export interface FieldDef {
  readonly type: string
}
export interface FieldBuilder extends FieldDef {
  unique(): FieldBuilder
  required(): FieldBuilder
  optional(): FieldBuilder
  default(value: unknown): FieldBuilder
  searchable(): FieldBuilder
  filterable(): FieldBuilder
  sortable(): FieldBuilder
  min(value: number): FieldBuilder
}
function builder(type: string): FieldBuilder {
  const b: FieldBuilder = {
    type,
    unique: () => b,
    required: () => b,
    optional: () => b,
    default: () => b,
    searchable: () => b,
    filterable: () => b,
    sortable: () => b,
    min: () => b,
  }
  return b
}
export const field = {
  string: () => builder('string'),
  text: () => builder('text'),
  integer: () => builder('integer'),
  decimal: (_precision: number, _scale: number) => builder('decimal'),
  boolean: () => builder('boolean'),
  date: () => builder('date'),
  enum: (_values: readonly string[]) => builder('enum'),
  belongsTo: (_model: string) => builder('belongsTo'),
  hasMany: (_model: string) => builder('hasMany'),
}
export interface ModelOptions {
  readonly timestamps?: boolean
  readonly softDeletes?: boolean
  readonly tenant?: boolean
  readonly audit?: boolean
}
export interface ModelDefinition<N extends string = string> {
  readonly name: N
  readonly fields: Readonly<Record<string, FieldDef>>
  readonly options: ModelOptions
}
export function defineModel<const N extends string>(
  name: N,
  fields: Readonly<Record<string, FieldDef>>,
  options: ModelOptions = {},
): ModelDefinition<N> {
  return { name, fields, options }
}
export interface ActionConfig {
  readonly permission?: string
  readonly label?: string
}
export function defineResource(
  model: ModelDefinition,
  options: { readonly actions?: Readonly<Record<string, ActionConfig>> } = {},
) {
  return { model, options }
}
export function definePolicy(
  resource: string,
  rules: (p: { allow(action: string): void }) => void,
) {
  return { resource, rules }
}
interface RouteOptions {
  readonly name?: string
  readonly permission?: string
}
const make =
  (method: string) =>
  (path: string, options: RouteOptions = {}) => ({ method, path, options })
export const route = {
  get: make('GET'),
  post: make('POST'),
  put: make('PUT'),
  patch: make('PATCH'),
  delete: make('DELETE'),
}
export function defineJob(name: string, handler: (payload: unknown) => Promise<void>) {
  return { name, handler }
}
export function defineListener(event: string, handler: (payload: unknown) => Promise<void>) {
  return { event, handler }
}
export function defineCommand(name: string, handler: (args: readonly string[]) => Promise<number>) {
  return { name, handler }
}
