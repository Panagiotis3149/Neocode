/**
 * Fallback chain logic - builds model fallback chain and handles current model detection
 */
import type { FallbackModel, FallbackChain, GoalConfig } from './types.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getUserSpecifiedModelSetting, getDefaultMainLoopModel } from '../../utils/model/model.js'

// Default model fallbacks per gateway
const DEFAULT_FALLBACKS: Record<string, FallbackModel[]> = {
  'nvidia-nim': [
    {
      modelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
      label: 'Nemotron 70B (NVIDIA Default)',
      gatewayId: 'nvidia-nim',
      isDefault: true,
    },
    {
      modelId: 'meta/llama-3.1-405b-instruct',
      label: 'Llama 3.1 405B',
      gatewayId: 'nvidia-nim',
    },
    {
      modelId: 'nvidia/nemotron-3-ultra',
      label: 'Nemotron 3 Ultra',
      gatewayId: 'nvidia-nim',
    },
  ],
  anthropic: [
    {
      modelId: 'claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet',
      gatewayId: 'anthropic',
      isDefault: true,
    },
    {
      modelId: 'claude-3-5-haiku-20241022',
      label: 'Claude 3.5 Haiku',
      gatewayId: 'anthropic',
    },
    {
      modelId: 'claude-3-opus-20240229',
      label: 'Claude 3 Opus',
      gatewayId: 'anthropic',
    },
  ],
  openai: [
    {
      modelId: 'gpt-4o',
      label: 'GPT-4o',
      gatewayId: 'openai',
      isDefault: true,
    },
    {
      modelId: 'gpt-4o-mini',
      label: 'GPT-4o Mini',
      gatewayId: 'openai',
    },
    {
      modelId: 'gpt-4-turbo',
      label: 'GPT-4 Turbo',
      gatewayId: 'openai',
    },
  ],
  google: [
    {
      modelId: 'gemini-1.5-pro',
      label: 'Gemini 1.5 Pro',
      gatewayId: 'google',
      isDefault: true,
    },
    {
      modelId: 'gemini-1.5-flash',
      label: 'Gemini 1.5 Flash',
      gatewayId: 'google',
    },
  ],
}

/**
 * Get the currently selected model from config
 */
export async function getCurrentModel(): Promise<FallbackModel> {
  const model = (getUserSpecifiedModelSetting() || getDefaultMainLoopModel()) as string | null
  const gateway = getAPIProvider()

  if (!model) {
    // Fall back to gateway default
    const defaults = DEFAULT_FALLBACKS[gateway]
    if (defaults && defaults.length > 0) {
      return defaults[0]
    }
    // Ultimate fallback
    return {
      modelId: 'claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet',
      gatewayId: 'anthropic',
      isDefault: true,
    }
  }

  return {
    modelId: model,
    label: model,
    gatewayId: gateway,
    isDefault: false,
  }
}

/**
 * Get previous model. In this codebase there's no tracked "previous model"
 * history on GlobalConfig, so return null. The fallback chain will still
 * have the current model + gateway defaults + backup models.
 */
async function getPreviousModel(): Promise<FallbackModel | null> {
  return null
}

/**
 * Build the fallback chain for a given current model
 */
export async function buildFallbackChain(currentModel: FallbackModel): Promise<FallbackChain> {
  const models: FallbackModel[] = [currentModel]
  const gatewayDefaults = DEFAULT_FALLBACKS[currentModel.gatewayId] || []

  // Add gateway defaults (excluding current model)
  for (const def of gatewayDefaults) {
    if (def.modelId !== currentModel.modelId) {
      models.push({ ...def })
    }
  }

  // Backup models are not directly available on the config object;
  // the fallback chain already covers gateway defaults as effective backups.

  // Add previous model
  const previous = await getPreviousModel()
  if (previous && !models.some((m) => m.modelId === previous.modelId)) {
    models.push(previous)
  }

  return {
    models,
    currentIndex: 0,
  }
}

/**
 * Get the next model in the fallback chain
 */
export function getNextFallbackModel(chain: FallbackChain): FallbackModel | null {
  const nextIndex = chain.currentIndex + 1
  if (nextIndex < chain.models.length) {
    return chain.models[nextIndex]
  }
  return null
}

/**
 * Advance the fallback chain to the next model
 */
export function advanceFallbackChain(chain: FallbackChain): FallbackChain {
  const nextIndex = Math.min(chain.currentIndex + 1, chain.models.length - 1)
  return {
    ...chain,
    currentIndex: nextIndex,
  }
}

/**
 * Reset fallback chain to a specific model
 */
export function resetFallbackChain(chain: FallbackChain, model: FallbackModel): FallbackChain {
  const index = chain.models.findIndex((m) => m.modelId === model.modelId)
  return {
    ...chain,
    currentIndex: index >= 0 ? index : 0,
  }
}

/**
 * Check if fallback chain is exhausted
 */
export function isFallbackChainExhausted(chain: FallbackChain): boolean {
  return chain.currentIndex >= chain.models.length - 1
}

/**
 * Parse goal config from user arguments
 */
export function parseGoalConfig(args: string[], defaults: Partial<GoalConfig> = {}): GoalConfig {
  const goal = args.join(' ').trim()

  return {
    goal,
    maxIterations: defaults.maxIterations ?? 10,
    verifyEachIteration: defaults.verifyEachIteration ?? true,
    verificationCommands: defaults.verificationCommands ?? [],
    retryMultiplier: defaults.retryMultiplier ?? 3,
    maxRateLimitWaitMs: defaults.maxRateLimitWaitMs ?? 5 * 60 * 1000, // 5 minutes
    fallbackChain: undefined, // Will be built dynamically
  }
}