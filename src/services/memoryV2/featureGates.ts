export const MEMORY_V2_GATES = [
  'MEMORY_STORE_V2',
  'MEMORY_HOT_SNAPSHOT',
  'MEMORY_REVIEWER',
  'MEMORY_PRECOMPACTION_FLUSH',
  'EXTERNAL_MEMORY_PROVIDER',
  'SKILL_STORE_V2',
  'AUTO_SKILL_GENERATION',
  'SKILL_CURATOR',
  'SKILL_PROMOTION',
  'RETRIEVAL_COMPACTION',
] as const

export type MemoryV2Gate = (typeof MEMORY_V2_GATES)[number]

export type FeatureGateRequest = Partial<Record<MemoryV2Gate, boolean>>

export const MEMORY_V2_EXTERNAL_BLOCKERS = {
  WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE: 'WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE',
  GENERATED_SKILL_MUTATION_CAPABILITY_UNAVAILABLE: 'GENERATED_SKILL_MUTATION_CAPABILITY_UNAVAILABLE',
  GENERATED_SKILL_SECURE_STORAGE_UNAVAILABLE: 'GENERATED_SKILL_SECURE_STORAGE_UNAVAILABLE',
} as const

export type MemoryV2ExternalBlocker = (typeof MEMORY_V2_EXTERNAL_BLOCKERS)[keyof typeof MEMORY_V2_EXTERNAL_BLOCKERS]
export type FeatureGateBlocker = MemoryV2Gate | MemoryV2ExternalBlocker
export type FeatureGateBlockers = Partial<Record<MemoryV2Gate, readonly MemoryV2ExternalBlocker[]>>

export type EffectiveFeatureGate = {
  requested: boolean
  effective: boolean
  blockedBy: FeatureGateBlocker[]
}

export type FeatureGateResolution = Record<MemoryV2Gate, EffectiveFeatureGate>

export const MEMORY_V2_GATE_DEPENDENCIES: Readonly<
  Record<MemoryV2Gate, readonly MemoryV2Gate[]>
> = {
  MEMORY_STORE_V2: [],
  MEMORY_HOT_SNAPSHOT: ['MEMORY_STORE_V2'],
  MEMORY_REVIEWER: ['MEMORY_STORE_V2'],
  MEMORY_PRECOMPACTION_FLUSH: ['MEMORY_REVIEWER'],
  EXTERNAL_MEMORY_PROVIDER: ['MEMORY_STORE_V2'],
  SKILL_STORE_V2: [],
  AUTO_SKILL_GENERATION: ['SKILL_STORE_V2'],
  SKILL_CURATOR: ['SKILL_STORE_V2'],
  SKILL_PROMOTION: ['SKILL_STORE_V2'],
  RETRIEVAL_COMPACTION: [],
}

export function resolveFeatureGates(
  requested: FeatureGateRequest = {},
  externalBlockers: FeatureGateBlockers = {},
): FeatureGateResolution {
  const resolved = {} as FeatureGateResolution
  const resolving = new Set<MemoryV2Gate>()

  const collectBlockers = (
    gate: MemoryV2Gate,
    visited = new Set<MemoryV2Gate>(),
  ): FeatureGateBlocker[] => {
    if (visited.has(gate)) return []
    visited.add(gate)
    const blockers: FeatureGateBlocker[] = [gate, ...(externalBlockers[gate] ?? [])]
    for (const dependency of MEMORY_V2_GATE_DEPENDENCIES[gate]) {
      if (!resolve(dependency).effective) {
        blockers.push(...collectBlockers(dependency, visited))
      }
    }
    return blockers
  }

  const resolve = (gate: MemoryV2Gate): EffectiveFeatureGate => {
    const existing = resolved[gate]
    if (existing) return existing

    const isRequested = requested[gate] === true
    if (!isRequested) {
      const disabled = { requested: false, effective: false, blockedBy: [] }
      resolved[gate] = disabled
      return disabled
    }

    if (resolving.has(gate)) {
      throw new Error(`Feature gate dependency cycle: ${gate}`)
    }
    resolving.add(gate)

    const blockedBy: FeatureGateBlocker[] = [...(externalBlockers[gate] ?? [])]
    for (const dependency of MEMORY_V2_GATE_DEPENDENCIES[gate]) {
      const dependencyResult = resolve(dependency)
      if (!dependencyResult.effective) {
        blockedBy.push(...collectBlockers(dependency))
      }
    }

    const uniqueBlockedBy = [...new Set(blockedBy)]
    const result = {
      requested: true,
      effective: uniqueBlockedBy.length === 0,
      blockedBy: uniqueBlockedBy,
    }
    resolving.delete(gate)
    resolved[gate] = result
    return result
  }

  for (const gate of MEMORY_V2_GATES) resolve(gate)
  return resolved
}

export function isFeatureGateEnabled(
  gate: MemoryV2Gate,
  requested: FeatureGateRequest = {},
  externalBlockers: FeatureGateBlockers = {},
): boolean {
  return resolveFeatureGates(requested, externalBlockers)[gate].effective
}
