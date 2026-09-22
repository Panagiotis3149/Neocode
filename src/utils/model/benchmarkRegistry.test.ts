import { describe, expect, test } from 'bun:test'
import {
  createBenchmarkRegistry,
  type BenchmarkFetch,
} from './benchmarkRegistry.js'

describe('benchmark registry', () => {
  test('normalizes Hugging Face and Artificial Analysis data', async () => {
    const calls: string[] = []
    const fetch: BenchmarkFetch = async input => {
      const url = String(input)
      calls.push(url)
      if (url.includes('huggingface.co')) {
        return new Response(
          JSON.stringify({
            downloads: 42,
            tags: ['text-generation'],
            config: { num_parameters: 7000000000 },
          }),
        )
      }
      return new Response(
        JSON.stringify({
          context_window: 128000,
          pricing: { input: 1.2, output: 4.8 },
          benchmarks: { mmlu: 0.91 },
        }),
      )
    }

    const registry = createBenchmarkRegistry({
      fetch,
      artificialAnalysisApiKey: 'aa-key',
    })
    const result = await registry.lookup('org/model')

    expect(result).toEqual({
      modelId: 'org/model',
      parameterCount: 7000000000,
      downloads: 42,
      tags: ['text-generation'],
      contextWindow: 128000,
      pricing: { input: 1.2, output: 4.8 },
      scores: { mmlu: 0.91 },
    })
    expect(calls).toHaveLength(2)
  })

  test('does not call Artificial Analysis without an API key', async () => {
    const calls: string[] = []
    const registry = createBenchmarkRegistry({
      fetch: async input => {
        calls.push(String(input))
        return new Response(JSON.stringify({ downloads: 1 }))
      },
      artificialAnalysisApiKey: undefined,
    })

    await registry.lookup('model')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('huggingface.co')
  })

  test('caches successful lookups by model id', async () => {
    let calls = 0
    const registry = createBenchmarkRegistry({
      fetch: async () => {
        calls += 1
        return new Response(JSON.stringify({ downloads: 2 }))
      },
    })

    const first = await registry.lookup('model')
    const second = await registry.lookup('model')

    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  test('returns partial data when one backend fails', async () => {
    const registry = createBenchmarkRegistry({
      fetch: async input => {
        if (String(input).includes('huggingface.co')) {
          return new Response('nope', { status: 500 })
        }
        return new Response(JSON.stringify({ contextWindow: 64000 }))
      },
      artificialAnalysisApiKey: 'aa-key',
    })

    await expect(registry.lookup('model')).resolves.toMatchObject({
      modelId: 'model',
      contextWindow: 64000,
    })
  })
})
