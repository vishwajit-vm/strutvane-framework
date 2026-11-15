/**
 * Soak and spike: a real server under sustained mixed load (CRUD, permission-protected routes,
 * error routes, clients that give up mid-request), then a burst of concurrent requests. Heap,
 * active handles and (on Postgres) database connections must stay flat; nothing may crash.
 *
 * Not part of the gate (it takes minutes): `npm run test:soak`.
 * - `SOAK_MINUTES` (default 10), `SOAK_CONCURRENCY` (32), `SOAK_SPIKE` (2000).
 * - `SOAK_DB=postgres://…` runs against Postgres (a throw-away database: its tables are dropped);
 *   the default is SQLite in a temp file.
 */
import { describe, expect, test } from 'vitest'
import { growth, runSoak } from './soak-driver.ts'

const minutes = Number(process.env['SOAK_MINUTES'] ?? '10')
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`

describe('soak', () => {
  test(
    `steady load for ${minutes} min, then a spike: no crash, no leak`,
    async () => {
      const result = await runSoak({
        durationMs: minutes * 60_000,
        sampleEveryMs: Math.max(5_000, Math.min(30_000, (minutes * 60_000) / 20)),
        concurrency: Number(process.env['SOAK_CONCURRENCY'] ?? '32'),
        spike: Number(process.env['SOAK_SPIKE'] ?? '2000'),
        ...(process.env['SOAK_DB'] ? { database: process.env['SOAK_DB'] } : {}),
        onSample: (s) =>
          process.stdout.write(
            `[soak] ${(s.atMs / 1000).toFixed(0)}s heap ${mb(s.heapUsed)} rss ${mb(s.rss)} handles ${s.handles}${s.dbConnections !== undefined ? ` db ${s.dbConnections}` : ''} requests ${s.requests}\n`,
          ),
      })
      const g = growth(result.samples)
      process.stdout.write(`[soak] ${JSON.stringify({ growth: g, spike: result.spike })}\n`)

      // Nothing crashed, every request got the answer it expects, and the server outlived the spike.
      expect(result.serverExit, result.serverStderr).toBeUndefined()
      expect(result.unexpected).toEqual([])
      expect(result.aliveAfterSpike).toBe(true)
      // A spike may be refused or queued, but never answered with a server error.
      expect(Object.keys(result.spike).filter((k) => k.startsWith('5'))).toEqual([])

      // No steady growth: heap within 1 MB/min (GC noise) and no more than 10% over the warmed-up
      // start; handles back to the warmed-up level once the clients are idle.
      expect(g.heapSlopeMbPerMin).toBeLessThan(1)
      expect(g.heapEndMb).toBeLessThan(g.heapStartMb * 1.1 + 2)
      const idle = result.samples.at(-2)
      const warm = result.samples[1]
      if (idle && warm) expect(idle.handles).toBeLessThanOrEqual(warm.handles + 5)
      const db = result.samples.map((s) => s.dbConnections).filter((n) => n !== undefined)
      if (db.length > 0) expect(Math.max(...db)).toBeLessThanOrEqual(11) // pool max + sampler
    },
    (minutes + 5) * 60_000,
  )
})
