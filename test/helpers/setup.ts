/** Create a migrated database for a set of models. */
import { createUuidV7Generator } from '../../src/core/index.ts'
import { createRepository, type Repository } from '../../src/data/repository.ts'
import type { Database, Dialect } from '../../src/database/types.ts'
import { migrationSource } from '../../src/migrations/files.ts'
import { migrate } from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import type { ModelDefinition } from '../../src/model/define-model.ts'
import { createModelRegistry, type ModelRegistry } from '../../src/model/registry.ts'
import { createDatabase } from './engines.ts'

export interface Fixture {
  readonly db: Database
  readonly registry: ModelRegistry
  repo(name: string): Repository
}

export const TENANT_A = '0190a000-0000-7000-8000-00000000000a'
export const TENANT_B = '0190a000-0000-7000-8000-00000000000b'

/** A fresh database with the models' tables created through the real migration path. */
export async function setupDatabase(
  dialect: Dialect,
  models: readonly ModelDefinition[],
): Promise<Fixture> {
  const db = await createDatabase(dialect)
  const plan = await planMigration({ dialect, previous: [], next: models })
  await migrate(db, [migrationSource('0001_init', plan.statements)])
  const registry = createModelRegistry(models)
  const ids = createUuidV7Generator()
  return {
    db,
    registry,
    repo: (name) => createRepository({ db, model: registry.require(name), registry, ids }),
  }
}
