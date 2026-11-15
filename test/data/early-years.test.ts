/**
 * Datetimes in years 0001–0099 survive a round trip on every engine. PGlite parses `timestamptz`
 * text (`0050-03-04 05:06:07+00`) with JavaScript's legacy date parser, which reads a year below
 * 100 as 19xx or 20xx: `0050` came back as `1950`, `0001` as `2001`. The driver now parses
 * timestamps itself, so stored and read values match.
 *
 * The class covered: every timestamp type the driver returns (`timestamptz`, `timestamp`) at the
 * edges of the storable range, on both engines.
 */
import { describe, expect, it } from 'vitest'
import { createRepository } from '../../src/data/repository.ts'
import { parsePgTimestamp } from '../../src/database/drivers.ts'
import { migrationSource } from '../../src/migrations/files.ts'
import { migrate } from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createModelRegistry } from '../../src/model/registry.ts'
import { createDatabase, DIALECTS } from '../helpers/engines.ts'

const Era = defineModel('Era', { at: field.datetime(), day: field.date().optional() })

const EDGES = [
  '0001-01-01T00:00:00.000Z',
  '0050-03-04T05:06:07.123Z',
  '0099-12-31T23:59:59.999Z',
  '0100-01-01T00:00:00.000Z',
  '1969-12-31T23:59:59.000Z',
  '9999-12-31T23:59:59.999Z',
]

describe.each(DIALECTS)('datetimes in early years on %s', (dialect) => {
  it('every edge of the storable range reads back exactly as written', async () => {
    const db = await createDatabase(dialect)
    try {
      const registry = createModelRegistry([Era.definition])
      const plan = await planMigration({ dialect, previous: [], next: registry.all })
      await migrate(db, [migrationSource('0001', plan.statements)])
      const repo = createRepository({
        db,
        model: Era.definition,
        registry,
        ids: () => crypto.randomUUID(),
      })
      for (const at of EDGES) {
        const created = await repo.create({ at, day: at.slice(0, 10) })
        expect(created['at'], at).toBe(at)
        expect(created['day'], at).toBe(at.slice(0, 10))
        expect((await repo.find(created.id))?.['at'], at).toBe(at)
      }
    } finally {
      await db.close()
    }
  })
})

describe('parsePgTimestamp', () => {
  it('parses Postgres text output with offsets, fractions and BC years', () => {
    expect(parsePgTimestamp('0050-03-04 05:06:07+00').toISOString()).toBe(
      '0050-03-04T05:06:07.000Z',
    )
    expect(parsePgTimestamp('0001-01-01 00:00:00.5+05:30').toISOString()).toBe(
      '0000-12-31T18:30:00.500Z',
    )
    expect(parsePgTimestamp('2026-11-15 10:00:00.123456-02').toISOString()).toBe(
      '2026-11-15T12:00:00.123Z',
    )
    // `timestamp` (no zone) is read as UTC.
    expect(parsePgTimestamp('0042-06-01 12:00:00').toISOString()).toBe('0042-06-01T12:00:00.000Z')
    expect(parsePgTimestamp('0044-03-15 12:00:00+00 BC').getUTCFullYear()).toBe(-43)
    expect(Number.isNaN(parsePgTimestamp('infinity').getTime())).toBe(true)
  })
})
