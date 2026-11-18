/**
 * `log:tail` takes the blueprint's flags (CONSISTENCY-2026-11-15 #39): `--level=`, `--channel=`,
 * `--grep=`, `--since=` and `--follow`, which is the default (`--no-follow` exits after the
 * backlog).
 */
import { describe, expect, test } from 'vitest'
import { parseSince } from '../../src/logging/commands/tail.ts'

const NOW = Date.parse('2026-11-15T10:00:00.000Z')

describe('log:tail flags', () => {
  test('parseSince takes durations and dates', () => {
    expect(parseSince('15m', NOW)).toBe('2026-11-15T09:45:00.000Z')
    expect(parseSince('30s', NOW)).toBe('2026-11-15T09:59:30.000Z')
    expect(parseSince('2h', NOW)).toBe('2026-11-15T08:00:00.000Z')
    expect(parseSince('7d', NOW)).toBe('2026-11-08T10:00:00.000Z')
    expect(parseSince('2026-11-15T09:00:00Z', NOW)).toBe('2026-11-15T09:00:00.000Z')
    expect(parseSince('2026-11-14', NOW)).toBe('2026-11-14T00:00:00.000Z')
    for (const bad of ['', 'soon', '15', '15 minutes', '-5m', 'm', '2026-13-45']) {
      expect(parseSince(bad, NOW), bad).toBeUndefined()
    }
  })
})
