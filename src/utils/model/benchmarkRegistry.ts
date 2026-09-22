export type BenchmarkFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type Benchmarks = {
  modelId: string
  parameterCount?: number
  downloads?: number
  tags?: string[]
  contextWindow?: number
  pricing?: { input?: number; output?: number }
  scores?: Record<string, number>
}

export type BenchmarkRegistry = {
  lookup(modelId: string): Promise<Benchmarks | null>
}

export type BenchmarkRegistryOptions = {
  fetch?: BenchmarkFetch
  artificialAnalysisApiKey?: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as JsonRecord)
    : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function asNumberRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record).filter(
    (entry): entry is [string, number] => asNumber(entry[1]) !== undefined,
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

async function fetchJson(
  fetcher: BenchmarkFetch,
  url: string,
  init?: RequestInit,
): Promise<JsonRecord | null> {
  try {
    const response = await fetcher(url, init)
    if (!response.ok) return null
    return asRecord(await response.json()) ?? null
  } catch {
    return null
  }
}

function normalizeHuggingFace(data: JsonRecord | null): Partial<Benchmarks> {
  if (!data) return {}
  const config = asRecord(data.config)
  const safetensors = asRecord(data.safetensors)
  return {
    parameterCount:
      asNumber(data.parameters) ??
      asNumber(config?.num_parameters) ??
      asNumber(safetensors?.total),
    downloads: asNumber(data.downloads),
    tags: asStringArray(data.tags),
  }
}

function normalizeArtificialAnalysis(
  data: JsonRecord | null,
): Partial<Benchmarks> {
  if (!data) return {}
  const pricing = asRecord(data.pricing)
  return {
    contextWindow:
      asNumber(data.context_window) ?? asNumber(data.contextWindow),
    pricing:
      pricing &&
      (asNumber(pricing.input) !== undefined ||
        asNumber(pricing.output) !== undefined)
        ? {
            input: asNumber(pricing.input),
            output: asNumber(pricing.output),
          }
        : undefined,
    scores:
      asNumberRecord(data.benchmarks) ?? asNumberRecord(data.scores),
  }
}

export function createBenchmarkRegistry(
  options: BenchmarkRegistryOptions = {},
): BenchmarkRegistry {
  const fetcher = options.fetch ?? fetch
  const cache = new Map<string, Benchmarks | null>()

  return {
    async lookup(modelId) {
      const normalizedModelId = modelId.trim()
      if (!normalizedModelId) return null
      if (cache.has(normalizedModelId)) {
        return cache.get(normalizedModelId) ?? null
      }

      const encodedModelId = encodeURIComponent(normalizedModelId)
      const [huggingFace, artificialAnalysis] = await Promise.all([
        fetchJson(
          fetcher,
          `https://huggingface.co/api/models/${encodedModelId}`,
        ),
        options.artificialAnalysisApiKey?.trim()
          ? fetchJson(
              fetcher,
              `https://artificialanalysis.ai/api/v2/models/${encodedModelId}`,
              {
                headers: {
                  Authorization: `Bearer ${options.artificialAnalysisApiKey.trim()}`,
                },
              },
            )
          : Promise.resolve(null),
      ])

      const normalized: Benchmarks = {
        modelId: normalizedModelId,
        ...normalizeHuggingFace(huggingFace),
        ...normalizeArtificialAnalysis(artificialAnalysis),
      }
      const hasData = Object.keys(normalized).length > 1
      const result = hasData ? normalized : null
      cache.set(normalizedModelId, result)
      return result
    },
  }
}

const defaultRegistry = createBenchmarkRegistry({
  artificialAnalysisApiKey: process.env.ARTIFICIAL_ANALYSIS_API_KEY,
})

export function lookupModelBenchmarks(
  modelId: string,
): Promise<Benchmarks | null> {
  return defaultRegistry.lookup(modelId)
}
