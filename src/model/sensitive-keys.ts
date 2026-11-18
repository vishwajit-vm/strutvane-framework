/**
 * Field keys loggers must redact: every model field marked `sensitive()` or `hidden()`.
 *
 * The framework never imports a logging package. At boot it registers these keys with core's
 * process-wide redaction registry (`registerSensitiveKeys` from `@strutvane/framework/core`), which both
 * core's fallback logger and the logging pipeline consult on every record, including loggers that
 * were created before the keys were registered.
 *
 * @module
 */
import { registerSensitiveKeys } from '../core/index.ts'
import type { ModelDefinition } from './define-model.ts'

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

/** Register the models' sensitive and hidden field keys for log redaction. Returns the keys. */
export function registerModelSensitiveKeys(models: readonly ModelDefinition[]): string[] {
  const keys = sensitiveFieldKeys(models)
  if (keys.length > 0) registerSensitiveKeys(keys)
  return keys
}
