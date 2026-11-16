/**
 * A tiny async mutex for engines that have exactly one connection (SQLite, PGlite).
 *
 * Why it is needed: with one connection, a transaction that awaits something would otherwise let
 * an unrelated query from another request run *inside* that open transaction (and be rolled back
 * with it). Holding the lock for the whole transaction makes each one truly isolated.
 */

/**
 * First come, first served lock.
 *
 * @example
 * const unlock = await mutex.lock()
 * try { … } finally { unlock() }
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve()

  /**
   * Wait for the lock; resolves to the function that releases it.
   *
   * @example
   * const unlock = await new Mutex().lock()
   * unlock()
   */
  async lock(): Promise<() => void> {
    let release: () => void = () => undefined
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.#tail
    // Chain before awaiting, so the queue order is the call order.
    this.#tail = previous.then(() => next)
    await previous
    let released = false
    return () => {
      // Releasing twice would let two holders in at once later; make it a no-op instead.
      if (released) return
      released = true
      release()
    }
  }
}
