import type { Logger } from '../../../../../../src/contracts/logger.ts'
import { LoggerToken } from '../../../../../../src/core/tokens.ts'

/** Discovered listener: logs when a post is published (constructor injection works here too). */
export class LogPostPublished {
  static readonly event = 'post.published'
  static readonly inject: readonly [typeof LoggerToken] = [LoggerToken] as const
  readonly #logger: Logger

  constructor(logger: Logger) {
    this.#logger = logger
  }

  handle(payload: unknown): void {
    const id =
      typeof payload === 'object' && payload !== null && 'id' in payload
        ? String(payload.id)
        : 'unknown'
    this.#logger.info('Post published', { post: id })
  }
}

/** Not a listener (no static event): discovery skips it. */
export const helper = (): string => 'not a listener'
