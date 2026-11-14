/**
 * The client side of the soak harness. Starts `soak-server.ts` in a child process, drives a mix of
 * CRUD, permission-protected, error and aborted requests at it for a while, samples the server's
 * heap and active resources at a fixed interval, then fires a spike of concurrent requests.
 *
 * Used by `soak.soak.test.ts` (`npm run test:soak`) and runnable on its own:
 * `node test/soak/soak-driver.ts --minutes 10 --out soak.json`.
 *
 * @module
 */
import { type ChildProcess, fork } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** One server-side measurement. */
export interface SoakSample {
  readonly atMs: number
  readonly heapUsed: number
  readonly rss: number
  readonly handles: number
  readonly resources: Readonly<Record<string, number>>
  readonly dbConnections?: number
  /** Requests completed by the driver so far. */
  readonly requests: number
}

/** What a soak run observed. */
export interface SoakResult {
  readonly samples: readonly SoakSample[]
  /** Response status (or `error:<code>` / `aborted`) → count, for the steady phase. */
  readonly statuses: Readonly<Record<string, number>>
  /** Same, for the spike. */
  readonly spike: Readonly<Record<string, number>>
  /** Unexpected statuses: anything other than what each request expects. */
  readonly unexpected: readonly string[]
  readonly serverExit: { readonly code: number | null; readonly signal: string | null } | undefined
  readonly serverStderr: string
  /** The server answered a request after the spike. */
  readonly aliveAfterSpike: boolean
}

/** Options for {@link runSoak}. */
export interface SoakOptions {
  readonly durationMs: number
  readonly sampleEveryMs: number
  readonly concurrency: number
  readonly spike: number
  /** Postgres URL; default SQLite in a temp file. */
  readonly database?: string
  readonly onSample?: (sample: SoakSample) => void
}

const SERVER = fileURLToPath(new URL('./soak-server.ts', import.meta.url))
const AUTH = { 'x-soak-user': 'soak-user', 'content-type': 'application/json' }

type Step = readonly [label: string, expected: readonly number[], run: () => Promise<Response>]

/** Run a soak against a fresh server process. */
export async function runSoak(options: SoakOptions): Promise<SoakResult> {
  const child = fork(SERVER, [], {
    execArgv: ['--expose-gc'],
    env: { ...process.env, ...(options.database ? { SOAK_DB: options.database } : {}) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000)
  })
  let exit: SoakResult['serverExit']
  child.on('exit', (code, signal) => {
    exit = { code, signal }
  })
  const base = await waitFor<{ url: string }>(child, 'ready', 60_000).then((m) => m.url)

  const statuses: Record<string, number> = {}
  const unexpected: string[] = []
  let requests = 0
  const record = (bucket: Record<string, number>, key: string): void => {
    bucket[key] = (bucket[key] ?? 0) + 1
  }

  const steps = (): Step[] => {
    const api = `${base}/api/v1`
    let id = ''
    return [
      [
        'create',
        [201],
        async () => {
          const r = await fetch(`${api}/notes`, {
            method: 'POST',
            headers: AUTH,
            body: JSON.stringify({ title: `note ${Math.random()}`, body: 'x'.repeat(200) }),
          })
          if (r.status === 201) id = ((await r.clone().json()) as { id: string }).id
          return r
        },
      ],
      ['list', [200], () => fetch(`${api}/notes?page[size]=10&sort=-title`, { headers: AUTH })],
      ['show', [200], () => fetch(`${api}/notes/${id}`, { headers: AUTH })],
      [
        'update',
        [200],
        () =>
          fetch(`${api}/notes/${id}`, {
            method: 'PATCH',
            headers: AUTH,
            body: JSON.stringify({ status: 'done' }),
          }),
      ],
      ['report (auth)', [200], () => fetch(`${api}/reports/2026`, { headers: AUTH })],
      ['report (anonymous)', [401], () => fetch(`${api}/reports/2026`)],
      ['list (anonymous)', [401, 403], () => fetch(`${api}/notes`)],
      ['not found', [404], () => fetch(`${base}/nope/${Math.random()}`)],
      [
        'invalid body',
        [422],
        () =>
          fetch(`${api}/notes`, {
            method: 'POST',
            headers: AUTH,
            body: JSON.stringify({ title: 42, extra: true }),
          }),
      ],
      [
        'malformed json',
        [400],
        () => fetch(`${api}/notes`, { method: 'POST', headers: AUTH, body: '{"title":' }),
      ],
      ['handler throws', [500], () => fetch(`${api}/boom`)],
      ['delete', [204], () => fetch(`${api}/notes/${id}`, { method: 'DELETE', headers: AUTH })],
    ]
  }

  const runStep = async ([label, expected, run]: Step): Promise<void> => {
    try {
      const r = await run()
      await r.arrayBuffer() // always consume the body, or the client leaks sockets
      record(statuses, String(r.status))
      if (!expected.includes(r.status)) unexpected.push(`${label}: ${r.status}`)
    } catch (error) {
      const code = errorCode(error)
      record(statuses, `error:${code}`)
      unexpected.push(`${label}: ${code}`)
    } finally {
      requests++
    }
  }

  const abortedRequest = async (): Promise<void> => {
    // A client that gives up mid-request: the server must release whatever it held.
    const controller = new AbortController()
    const p = fetch(`${base}/api/v1/notes?page[size]=100`, {
      headers: AUTH,
      signal: controller.signal,
    })
    setImmediate(() => controller.abort())
    await p.then(
      (r) => r.arrayBuffer(),
      () => undefined,
    )
    record(statuses, 'aborted')
    requests++
  }

  const started = Date.now()
  const deadline = started + options.durationMs
  const samples: SoakSample[] = []
  const takeSample = async (): Promise<void> => {
    child.send({ type: 'sample' })
    const s = await waitFor<Omit<SoakSample, 'atMs' | 'requests'>>(child, 'sample', 30_000)
    const sample: SoakSample = {
      atMs: Date.now() - started,
      heapUsed: s.heapUsed,
      rss: s.rss,
      handles: s.handles,
      resources: s.resources,
      ...(s.dbConnections !== undefined ? { dbConnections: s.dbConnections } : {}),
      requests,
    }
    samples.push(sample)
    options.onSample?.(sample)
  }

  const worker = async (n: number): Promise<void> => {
    let i = 0
    while (Date.now() < deadline && exit === undefined) {
      for (const step of steps()) await runStep(step)
      if (++i % 5 === n % 5) await abortedRequest()
    }
  }
  await takeSample()
  const sampler = (async () => {
    while (Date.now() + options.sampleEveryMs < deadline && exit === undefined) {
      await sleep(options.sampleEveryMs)
      await takeSample()
    }
  })()
  await Promise.all([...Array.from({ length: options.concurrency }, (_, n) => worker(n)), sampler])
  // Idle sample: workers are done, keep-alive sockets may linger; a leak would not go away.
  await sleep(1_000)
  if (exit === undefined) await takeSample()

  // Spike: many concurrent requests at once. 503s, queueing or refused connections are fine;
  // a crash or a hang is not.
  const spike: Record<string, number> = {}
  if (exit === undefined) {
    await Promise.all(
      Array.from({ length: options.spike }, async (_, n) => {
        try {
          const r = await fetch(
            n % 2 === 0 ? `${base}/api/v1/notes?page[size]=5` : `${base}/health`,
            { headers: AUTH, signal: AbortSignal.timeout(60_000) },
          )
          await r.arrayBuffer()
          record(spike, String(r.status))
        } catch (error) {
          record(spike, `error:${errorCode(error)}`)
        }
      }),
    )
  }
  let aliveAfterSpike = false
  if (exit === undefined) {
    const r = await fetch(`${base}/health`).catch(() => undefined)
    aliveAfterSpike = r?.status === 200
    await r?.arrayBuffer()
    await sleep(2_000)
    await takeSample()
  }

  if (exit === undefined) {
    child.send('shutdown')
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      sleep(15_000).then(() => {
        child.kill()
      }),
    ])
  }
  return {
    samples,
    statuses,
    spike,
    unexpected: summarize(unexpected),
    serverExit: exit,
    serverStderr: stderr,
    aliveAfterSpike,
  }
}

/** Heap and handle growth between the warmed-up start and the end of the steady phase. */
export function growth(samples: readonly SoakSample[]): {
  readonly heapStartMb: number
  readonly heapEndMb: number
  readonly heapSlopeMbPerMin: number
  readonly handlesStart: number
  readonly handlesEnd: number
} {
  // Skip the first sample (cold) and the last two (idle and post-spike).
  const steady = samples.slice(1, Math.max(2, samples.length - 2))
  const mb = (n: number): number => Math.round((n / 1024 / 1024) * 100) / 100
  const first = steady[0] ?? samples[0]
  const last = steady.at(-1) ?? samples.at(-1)
  if (!first || !last)
    return { heapStartMb: 0, heapEndMb: 0, heapSlopeMbPerMin: 0, handlesStart: 0, handlesEnd: 0 }
  // Least-squares slope of heapUsed over time, robust to one noisy sample.
  const xs = steady.map((s) => s.atMs / 60_000)
  const ys = steady.map((s) => s.heapUsed / 1024 / 1024)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  const num = xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] ?? 0) - my), 0)
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
  return {
    heapStartMb: mb(first.heapUsed),
    heapEndMb: mb(last.heapUsed),
    heapSlopeMbPerMin: den === 0 ? 0 : Math.round((num / den) * 1000) / 1000,
    handlesStart: first.handles,
    handlesEnd: last.handles,
  }
}

function summarize(lines: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1)
  return [...counts].map(([l, n]) => `${l} ×${n}`)
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause
  if (typeof cause?.code === 'string') return cause.code
  return error instanceof Error ? error.name : 'unknown'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function waitFor<T>(child: ChildProcess, type: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`soak server sent no "${type}" within ${timeoutMs} ms`))
    }, timeoutMs)
    const onMessage = (m: unknown): void => {
      if (typeof m === 'object' && m !== null && 'type' in m && m.type === type) {
        cleanup()
        resolve(m as T)
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`soak server exited (${String(code)}) before "${type}"`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

// Stand-alone: `node test/soak/soak-driver.ts --minutes 10 [--out file.json] [--db <url>]`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const minutes = Number(arg('minutes') ?? '10')
  const db = arg('db')
  const result = await runSoak({
    durationMs: minutes * 60_000,
    sampleEveryMs: Number(arg('sample-seconds') ?? '30') * 1000,
    concurrency: Number(arg('concurrency') ?? '32'),
    spike: Number(arg('spike') ?? '2000'),
    ...(db ? { database: db } : {}),
    onSample: (s) =>
      process.stdout.write(
        `${(s.atMs / 1000).toFixed(0).padStart(5)}s heap ${(s.heapUsed / 1048576).toFixed(1)} MB rss ${(s.rss / 1048576).toFixed(1)} MB handles ${s.handles} ${JSON.stringify(s.resources)}${s.dbConnections !== undefined ? ` db ${s.dbConnections}` : ''} requests ${s.requests}\n`,
      ),
  })
  const out = arg('out')
  if (out)
    writeFileSync(out, JSON.stringify({ ...result, growth: growth(result.samples) }, null, 2))
  process.stdout.write(
    `${JSON.stringify({ growth: growth(result.samples), statuses: result.statuses, spike: result.spike, unexpected: result.unexpected, serverExit: result.serverExit, aliveAfterSpike: result.aliveAfterSpike }, null, 2)}\n`,
  )
}
