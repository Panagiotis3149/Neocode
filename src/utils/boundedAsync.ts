/**
 * Utilities for bounding concurrency of async work (e.g. filesystem IO over
 * many files) so a task list doesn't fan out to hundreds of in-flight
 * operations at once.
 */

/**
 * A simple counting semaphore for bounding concurrent async operations.
 *
 * `acquire()` resolves once a permit is available (up to `max`), and the caller
 * MUST `await release()` in a `finally` so the permit is always returned even
 * when the work throws.
 */
export class Semaphore {
  private permits: number
  private readonly waiters: (() => void)[] = []

  constructor(max: number) {
    this.permits = max
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    this.permits++
    const next = this.waiters.shift()
    if (next) {
      this.permits--
      next()
    }
  }
}

/**
 * Apply `fn` to each item, running at most `concurrency` of them in parallel.
 * Results preserve input order. Exceptions propagate (the pending queue is
 * drained and the first rejection wins) so callers see the same error they
 * would from a plain `Promise.all(items.map(fn))`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!, index)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}
