/**
 * Field keys the logger must redact: every model field marked `sensitive()` or `hidden()`.
 *
 * The framework never imports a logging package. At boot it runs the {@link REDACT_KEYS_HOOK}
 * hook with these keys (integration map: hooks), and the active logger implementation
 * (`@strutvane/logs`, or any other) adds them to its redaction rules. When nobody handles the
 * hook, the logger's built-in key list still applies.
 *
 * @module
 */
import type { ModelDefinition } from './define-model.ts'

/** Hook run once at boot with {@link RedactKeysPayload}. Observe-only. */
export const REDACT_KEYS_HOOK = 'logger.redactKeys'

/** Payload of {@link REDACT_KEYS_HOOK}. */
export interface RedactKeysPayload {
  /** Field keys (API names, e.g. `taxId`) and their column names (e.g. `tax_id`), deduplicated. */
  readonly keys: readonly string[]
  /** Who contributed the keys. */
  readonly source: '@strutvane/framework'
}

/** The keys of every `sensitive` or `hidden` field, as API keys and as column names. */
export function sensitiveFieldKeys(models: readonly ModelDefinition[]): string[] {
  const keys = new Set<string>()
  for (const model of models) {
    for (const [key, def] of Object.entries(model.fields)) {
      if (!def.sensitive && !def.hidden) continue
      keys.add(key)
      // Raw rows (driver errors, debug output) carry column names.
      keys.add(key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    }
  }
  return [...keys].sort()
}
