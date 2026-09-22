import { describe, expect, test } from 'bun:test'

import {
  MEMORY_V2_GATES,
  MEMORY_V2_EXTERNAL_BLOCKERS,
  resolveFeatureGates,
  type MemoryV2Gate,
} from './featureGates.js'

describe('memory V2 feature gates', () => {
  test('all gates are disabled unless explicitly requested', () => {
    const resolved = resolveFeatureGates()

    for (const gate of MEMORY_V2_GATES) {
      expect(resolved[gate]).toEqual({
        requested: false,
        effective: false,
        blockedBy: [],
      })
    }
  })

  test('reports a direct dependency that blocks a requested gate', () => {
    const resolved = resolveFeatureGates({ MEMORY_HOT_SNAPSHOT: true })

    expect(resolved.MEMORY_HOT_SNAPSHOT).toEqual({
      requested: true,
      effective: false,
      blockedBy: ['MEMORY_STORE_V2'],
    })
  })

  test('reports transitive dependency blockers and enables a complete chain', () => {
    const requested: Partial<Record<MemoryV2Gate, boolean>> = {
      MEMORY_PRECOMPACTION_FLUSH: true,
      MEMORY_REVIEWER: true,
      MEMORY_STORE_V2: true,
    }

    const resolved = resolveFeatureGates(requested)

    expect(resolved.MEMORY_PRECOMPACTION_FLUSH).toEqual({
      requested: true,
      effective: true,
      blockedBy: [],
    })

    const blocked = resolveFeatureGates({ MEMORY_PRECOMPACTION_FLUSH: true })
    expect(blocked.MEMORY_PRECOMPACTION_FLUSH).toEqual({
      requested: true,
      effective: false,
      blockedBy: ['MEMORY_REVIEWER', 'MEMORY_STORE_V2'],
    })
  })

  test('keeps independent skill and retrieval gates independently resolvable', () => {
    const resolved = resolveFeatureGates({
      SKILL_STORE_V2: true,
      SKILL_CURATOR: true,
      RETRIEVAL_COMPACTION: true,
    })

    expect(resolved.SKILL_CURATOR.effective).toBe(true)
    expect(resolved.RETRIEVAL_COMPACTION.effective).toBe(true)
    expect(resolved.MEMORY_STORE_V2.effective).toBe(false)
  })

  test('reports a platform blocker before auto skill generation can become effective', () => {
    const resolved = resolveFeatureGates(
      { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true },
      { AUTO_SKILL_GENERATION: [MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE] },
    )

    expect(resolved.AUTO_SKILL_GENERATION).toEqual({
      requested: true,
      effective: false,
      blockedBy: [MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE],
    })
  })
})
