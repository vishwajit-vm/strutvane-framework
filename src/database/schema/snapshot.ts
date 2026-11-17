/**
 * The runtime schema snapshot the ORM reads: re-exported from the migration-first schema module,
 * so the replay, the generators and the ORM share one vocabulary and can never disagree.
 *
 * @module
 */
export type {
  ColumnDef,
  ColumnKind,
  IndexDef,
  SchemaSnapshot,
  TableState,
} from '../../schema/columns.ts'
