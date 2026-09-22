import type { GeneratedSkillStoreOptions } from '../generatedSkills/store.js'
import type { FeatureGateRequest, FeatureGateResolution } from './featureGates.js'

export type MemoryV2SkillRuntimeConfig = Readonly<{
  gates: FeatureGateRequest
  generatedSkillOptions?: GeneratedSkillStoreOptions
  gateResolution?: FeatureGateResolution
}>

let activeConfig: MemoryV2SkillRuntimeConfig = { gates: {} }

export function configureMemoryV2SkillRuntime(
  gates: FeatureGateRequest = {},
  generatedSkillOptions?: GeneratedSkillStoreOptions,
  gateResolution?: FeatureGateResolution,
): void {
  activeConfig = Object.freeze({ gates: Object.freeze({ ...gates }), generatedSkillOptions, gateResolution })
}

export function getMemoryV2SkillRuntimeConfig(): MemoryV2SkillRuntimeConfig {
  return activeConfig
}
