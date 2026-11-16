/**
 * A stand-in for the ORM module the generated test types augment (`@strutvane/framework/database`
 * in an app). Generated with `modelModule: '../../../registry.ts'` so the golden fixture compiles
 * before the package is built.
 */

/** Any JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Filled by the generated `models.d.ts`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated code
export interface TableRegistry {}
