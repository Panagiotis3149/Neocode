import { expect, test } from 'vitest'
import { Semaphore, mapWithConcurrency } from './boundedAsync.js'

test('Semaphore hands out exactly `max` permits, then blocks', async () => {
  const sem = new Semaphore(1)
  let firstResolved = false
  let secondResolved = false

  const first = sem.acquire().then(() => {
    firstResolved = true
  })
  const second = sem.acquire().then(() => {
    secondResolved = true
  })

  await first
  expect(firstResolved).toBe(true)
  // Second is still waiting — it must not resolve until a release.
  expect(secondResolved).toBe(false)

  sem.release()
  await second
  expect(secondResolved).toBe(true)
})

test('Semaphore release re-permits a fresh acquire without blocking', async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  sem.release()
  let ran = false
  await sem.acquire().then(() => {
    ran = true
  })
  expect(ran).toBe(true)
})

test('mapWithConcurrency preserves input order', async () => {
  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async n => n * 10,
  )
  expect(results).toEqual([10, 20, 30, 40, 50])
})

test('mapWithConcurrency bounds in-flight work to `concurrency`', async () => {
  const concurrency = 3
  let active = 0
  let peak = 0

  await mapWithConcurrency(
    Array.from({ length: 20 }, (_, i) => i),
    concurrency,
    async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
    },
  )

  expect(peak).toBe(concurrency)
})

test('mapWithConcurrency with empty input returns empty array', async () => {
  const results = await mapWithConcurrency([], 4, async () => {
    throw new Error('should not run')
  })
  expect(results).toEqual([])
})

test('mapWithConcurrency propagates the first rejection', async () => {
  const error = new Error('boom')
  await expect(
    mapWithConcurrency(
      [1, 2, 3],
      2,
      async n => {
        if (n === 2) throw error
        return n
      },
    ),
  ).rejects.toBe(error)
})
