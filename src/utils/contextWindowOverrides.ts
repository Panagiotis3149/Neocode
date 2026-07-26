import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'

export const MIN_CONTEXT_WINDOW = 16_384
export const MAX_CONTEXT_WINDOW = 2_147_483_647

export type ContextWindowOverride = {
  contextWindowTokens: number
}

export type ContextWindowOverrides = Record<string, ContextWindowOverride>

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

/**
 * Parse a context window size string.
 * Supported formats: 16384, 256k, 256K, 1m, 1M, 0.5m, 0.5M
 * Rules:
 * - 'k' suffix = ×1000 (integers only, decimals rejected)
 * - 'm' suffix = ×1_000_000 (decimals allowed)
 * - No suffix = raw integer (must be within [MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW])
 * Returns the parsed token count, or throws an Error with a descriptive message.
 */
export function parseContextWindowSize(input: string): number {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Usage: /context <size>  e.g. 256k, 1m, or /context reset.')
  }

  const lower = trimmed.toLowerCase()

  // Reset aliases
  if (lower === 'reset' || lower === '0' || lower === '-1') {
    throw new Error('RESET')
  }

  // Naked integer (no suffix)
  if (!lower.endsWith('k') && !lower.endsWith('m')) {
    if (!/^\d+$/.test(lower)) {
      throw new Error('Usage: /context <size>  e.g. 256k, 1m, or /context reset.')
    }
    const n = parseInt(lower, 10)
    if (Number.isNaN(n)) {
      throw new Error('Usage: /context <size>  e.g. 256k, 1m, or /context reset.')
    }
    if (n < MIN_CONTEXT_WINDOW || n > MAX_CONTEXT_WINDOW) {
      throw new Error(
        `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}.`
      )
    }
    return n
  }

  // k suffix - integers only
  if (lower.endsWith('k')) {
    const numPart = lower.slice(0, -1)
    if (!/^\d+$/.test(numPart)) {
      throw new Error(
        'Usage: /context <size>  e.g. 256k, 1m, or /context reset.'
      )
    }
    const n = parseInt(numPart, 10) * 1_000
    if (n < MIN_CONTEXT_WINDOW || n > MAX_CONTEXT_WINDOW) {
      throw new Error(
        `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}.`
      )
    }
    return n
  }

  // m suffix - decimals allowed
  if (lower.endsWith('m')) {
    const numPart = lower.slice(0, -1)
    if (!/^\d+(\.\d+)?$/.test(numPart)) {
      throw new Error('Usage: /context <size>  e.g. 256k, 1m, or /context reset.')
    }
    const n = Math.round(parseFloat(numPart) * 1_000_000)
    if (n < MIN_CONTEXT_WINDOW || n > MAX_CONTEXT_WINDOW) {
      throw new Error(
        `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}.`
      )
    }
    return n
  }

  throw new Error('Usage: /context <size>  e.g. 256k, 1m, or /context reset.')
}

function getOverrides(): ContextWindowOverrides {
  return getSettingsForSource('userSettings')?.contextWindowOverrides ?? {}
}

/**
 * Get the context window override for a model, if any.
 * Exact model ID match only (no prefix matching per spec).
 */
export function getContextWindowOverride(
  model: string,
): ContextWindowOverride | undefined {
  const overrides = getOverrides()
  const normalizedModel = normalizeModel(model)
  const override = overrides[normalizedModel]
  if (!override) return undefined
  return override
}

/**
 * Set (or update) a context window override for a model.
 * Exact model ID only — no prefix matching per spec.
 */
export function setContextWindowOverride(
  model: string,
  contextWindowTokens: number,
): { error: Error | null } {
  if (contextWindowTokens < MIN_CONTEXT_WINDOW || contextWindowTokens > MAX_CONTEXT_WINDOW) {
    return {
      error: new Error(
        `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}.`,
      ),
    }
  }

  const normalizedModel = normalizeModel(model)
  const overrides = getOverrides()
  const next = { ...overrides, [normalizedModel]: { contextWindowTokens } }

  return updateSettingsForSource('userSettings', {
    contextWindowOverrides: next,
  })
}

/**
 * Remove (clear) a context window override for a model.
 * The key is removed from the settings object entirely.
 */
export function clearContextWindowOverride(model: string): { error: Error | null } {
  const normalizedModel = normalizeModel(model)
  const overrides = getOverrides()
  if (!overrides[normalizedModel]) {
    return { error: null } // idempotent
  }
  // Deep-merge behavior for objects means setting to undefined deletes the key.
  const next = { ...overrides, [normalizedModel]: undefined }

  return updateSettingsForSource('userSettings', {
    contextWindowOverrides: next,
  })
}

/**
 * List all context window overrides (shallow copy).
 */
export function listContextWindowOverrides(): ContextWindowOverrides {
  return { ...getOverrides() }
}