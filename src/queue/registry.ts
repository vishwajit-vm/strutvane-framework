/**
 * The job registry: the only way the worker turns a payload's job name into code (RFC-0006 §1.3).
 * A name that isn't registered is a poison message, never an import.
 *
 * @module
 */
import { closestMatch } from '../support/str.ts'
import { QueueError } from './errors.ts'
import { isJob, type RegisteredJob } from './job.ts'

/**
 * Jobs by name.
 *
 * @example
 * const jobs = new JobRegistry().register(SendWelcomeEmail)
 * jobs.get('send-welcome-email')
 */
export class JobRegistry {
  readonly #jobs = new Map<string, RegisteredJob>()

  /**
   * Register jobs. Registering the same definition twice is a no-op; a different job with a
   * taken name throws `queue_job_duplicate_name`.
   */
  register(...jobs: readonly RegisteredJob[]): this {
    for (const job of jobs) {
      if (!isJob(job))
        throw new QueueError(
          'queue_job_invalid',
          'Only jobs made with defineJob() can be registered.',
          'Export const MyJob = defineJob({ name, handle }) and register MyJob.',
        )
      const existing = this.#jobs.get(job.name)
      if (existing !== undefined && existing !== job)
        throw new QueueError(
          'queue_job_duplicate_name',
          `Two different jobs are called "${job.name}".`,
          'Job names must be unique across the app and its packages: rename one of them.',
        )
      this.#jobs.set(job.name, job)
    }
    return this
  }

  /**
   * Register every job a module exports (what `app/jobs` discovery does per file).
   *
   * @example
   * jobs.registerModule(await import('./app/jobs/send-mail.ts'))
   */
  registerModule(module: Readonly<Record<string, unknown>>): this {
    for (const value of Object.values(module)) if (isJob(value)) this.register(value)
    return this
  }

  /** The job with this name, or `undefined`. */
  get(name: string): RegisteredJob | undefined {
    return this.#jobs.get(name)
  }

  /**
   * The job with this name, or `queue_job_unknown` with a "did you mean".
   *
   * @example
   * jobs.require('send-mail')
   */
  require(name: string): RegisteredJob {
    const job = this.#jobs.get(name)
    if (job !== undefined) return job
    const guess = closestMatch(name, [...this.#jobs.keys()])
    throw new QueueError(
      'queue_job_unknown',
      `No job called "${name}" is registered in this process.`,
      guess === undefined
        ? 'Put the job in app/jobs (exported), or register it in a provider with app.jobs.register(Job).'
        : `Did you mean "${guess}"? Otherwise put the job in app/jobs or register it in a provider.`,
    )
  }

  /** Every registered name, sorted. */
  names(): readonly string[] {
    return [...this.#jobs.keys()].sort()
  }
}
