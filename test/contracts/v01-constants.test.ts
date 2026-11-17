import { describe, expect, test } from 'vitest'
import {
  LOG_LEVEL_SEVERITY,
  LOG_LEVELS,
  type LogLevel,
  PROBLEM_CODES,
  type ProblemCode,
} from '../../src/contracts/index.ts'

describe('LOG_LEVELS / LOG_LEVEL_SEVERITY', () => {
  const every: Record<LogLevel, true> = {
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
  }

  test('lists every level exactly once, in ascending severity', () => {
    expect([...LOG_LEVELS].sort()).toEqual(Object.keys(every).sort())
    const severities = LOG_LEVELS.map((l) => LOG_LEVEL_SEVERITY[l])
    expect(severities).toEqual([...severities].sort((a, b) => a - b))
    expect(new Set(severities).size).toBe(severities.length)
  })

  test('uses the pino/bunyan numbering and is frozen', () => {
    expect(LOG_LEVEL_SEVERITY).toEqual({
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50,
      fatal: 60,
    })
    expect(Object.isFrozen(LOG_LEVEL_SEVERITY)).toBe(true)
  })
})

describe('PROBLEM_CODES', () => {
  // A Record over the union forces every code to be listed here; the assertion keeps the runtime
  // list in sync with the type (RFC-0002 + RFC-0003 codes).
  const every: Record<ProblemCode, true> = {
    validation_failed: true,
    unauthenticated: true,
    forbidden: true,
    not_found: true,
    conflict: true,
    stale_record: true,
    rate_limited: true,
    payload_too_large: true,
    service_unavailable: true,
    internal_error: true,
    file_too_large: true,
    too_many_files: true,
    file_empty: true,
    file_type_not_allowed: true,
    file_corrupt: true,
    image_dimensions_invalid: true,
    upload_incomplete: true,
    storage_unavailable: true,
    quota_exceeded: true,
    file_infected: true,
    scan_unavailable: true,
  }

  test('lists every ProblemCode exactly once, all snake_case', () => {
    expect([...PROBLEM_CODES].sort()).toEqual(Object.keys(every).sort())
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length)
    for (const code of PROBLEM_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})
