import type { Blueprint } from '../../../../../../src/entries/schema.ts'

/**
 * A reusable helper: the kind of thing real projects grow ("every table gets these columns").
 * Approach (a) runs it like any other code; approach (b) can't see inside it.
 */
export function addAuditColumns(t: Blueprint): void {
  t.foreignId('created_by').nullable()
  t.foreignId('updated_by').nullable()
  t.timestamps()
}
