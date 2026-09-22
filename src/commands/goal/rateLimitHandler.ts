/**
 * Rate limit handler for 429 errors with 3x retries and model fallback
 */
import type { RateLimitInfo, FallbackDecision, FallbackModel, FallbackChain } from './types.js'
import { getNextFallbackModel, advanceFallbackChain, isFallbackChainExhausted } from './fallbackChain.js'

/**
 * Parse rate limit error from API response
 * Detects both standard 429 and NVIDIA NIM "quota exhausted" soft limits
 */
export function parseRateLimitError(error: unknown): RateLimitInfo {
  const defaultInfo: RateLimitInfo = {
    isRateLimit: false,
    isNvidiaNimQuotaExhausted: false,
    message: String(error),
  }

  if (!error || typeof error !== 'object') {
    return defaultInfo
  }

  const err = error as any

  // Check for HTTP 429 status
  const statusCode = err.status || err.statusCode || err.response?.status
  const is429 = statusCode === 429

  // Check error message for rate limit indicators
  const message = err.message || err.error?.message || err.response?.data?.error?.message || ''
  const messageLower = message.toLowerCase()

  // NVIDIA NIM specific: "quota exhausted" or "too many requests"
  const isNvidiaNimQuotaExhausted =
    messageLower.includes('quota exhausted') ||
    messageLower.includes('too many requests') ||
    (messageLower.includes('rate limit') && err.gateway === 'nvidia-nim')

  // Standard rate limit indicators
  const isStandardRateLimit =
    messageLower.includes('rate limit') ||
    messageLower.includes('too many requests') ||
    messageLower.includes('quota exceeded') ||
    messageLower.includes('throttle')

  const isRateLimit = is429 || isStandardRateLimit || isNvidiaNimQuotaExhausted

  // Parse retry-after header
  let retryAfterMs: number | undefined
  const retryAfter = err.response?.headers?.['retry-after'] || err.headers?.['retry-after'] || err.retryAfter
  if (retryAfter) {
    const seconds = parseInt(String(retryAfter), 10)
    if (!isNaN(seconds)) {
      retryAfterMs = seconds * 1000
    }
  }

  // Also check x-ratelimit-reset
  const resetHeader = err.response?.headers?.['x-ratelimit-reset'] || err.headers?.['x-ratelimit-reset']
  if (resetHeader && !retryAfterMs) {
    const resetTime = parseInt(String(resetHeader), 10)
    if (!isNaN(resetTime)) {
      const now = Math.floor(Date.now() / 1000)
      retryAfterMs = Math.max(0, (resetTime - now) * 1000)
    }
  }

  return {
    isRateLimit,
    isNvidiaNimQuotaExhausted,
    retryAfterMs,
    message,
    statusCode,
  }
}

/**
 * Calculate retry delay with exponential backoff and 3x multiplier for 429s
 */
export function calculateRetryDelay(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 5 * 60 * 1000, // 5 minutes
  retryMultiplier: number = 3
): number {
  // Exponential backoff: base * 2^attempt * retryMultiplier
  const delay = baseDelayMs * Math.pow(2, attempt) * retryMultiplier
  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1)
  return Math.min(Math.max(delay + jitter, baseDelayMs), maxDelayMs)
}

/**
 * Handle a rate limit error and decide on fallback/wait strategy
 */
export function handleRateLimit(
  rateLimitInfo: RateLimitInfo,
  currentModel: FallbackModel,
  fallbackChain: FallbackChain,
  consecutive429Errors: number,
  retryMultiplier: number = 3,
  maxRateLimitWaitMs: number = 5 * 60 * 1000
): FallbackDecision {
  const { isRateLimit, isNvidiaNimQuotaExhausted, retryAfterMs } = rateLimitInfo

  if (!isRateLimit) {
    return {
      shouldFallback: false,
      nextModel: null,
      reason: 'Not a rate limit error',
      waitMs: 0,
    }
  }

  // NVIDIA NIM special case: "quota exhausted" is a soft limit
  if (isNvidiaNimQuotaExhausted) {
    // If retry-after is provided and reasonable, wait
    if (retryAfterMs && retryAfterMs <= maxRateLimitWaitMs) {
      return {
        shouldFallback: false,
        nextModel: null,
        reason: `NVIDIA NIM quota exhausted, waiting ${Math.round(retryAfterMs / 1000)}s`,
        waitMs: retryAfterMs,
      }
    }
    // Otherwise fallback immediately (don't wait 5+ minutes)
    const nextModel = getNextFallbackModel(fallbackChain)
    if (nextModel) {
      return {
        shouldFallback: true,
        nextModel,
        reason: 'NVIDIA NIM quota exhausted, falling back to next model',
        waitMs: 0,
      }
    }
    // No fallback available - wait and retry
    const waitTime = retryAfterMs || 60 * 1000 // Default 1 minute
    return {
      shouldFallback: false,
      nextModel: null,
      reason: `NVIDIA NIM quota exhausted, no fallback available, waiting ${Math.round(waitTime / 1000)}s`,
      waitMs: Math.min(waitTime, maxRateLimitWaitMs),
    }
  }

  // Standard 429: apply 3x retry logic
  // After 3 consecutive 429s on same model, fallback
  if (consecutive429Errors >= 3) {
    const nextModel = getNextFallbackModel(fallbackChain)
    if (nextModel) {
      return {
        shouldFallback: true,
        nextModel,
        reason: `3 consecutive 429 errors on ${currentModel.label}, falling back`,
        waitMs: 0,
      }
    }

    // Fallback chain exhausted - wait longer and retry
    const waitTime = retryAfterMs || calculateRetryDelay(consecutive429Errors, 1000, maxRateLimitWaitMs, retryMultiplier)
    return {
      shouldFallback: false,
      nextModel: null,
      reason: `Fallback chain exhausted, waiting ${Math.round(waitTime / 1000)}s before retry`,
      waitMs: Math.min(waitTime, maxRateLimitWaitMs),
    }
  }

  // Less than 3 consecutive 429s - wait with exponential backoff
  const waitTime = retryAfterMs || calculateRetryDelay(consecutive429Errors, 1000, maxRateLimitWaitMs, retryMultiplier)
  return {
    shouldFallback: false,
    nextModel: null,
    reason: `Rate limited (attempt ${consecutive429Errors + 1}/3), waiting ${Math.round(waitTime / 1000)}s`,
    waitMs: Math.min(waitTime, maxRateLimitWaitMs),
  }
}

/**
 * Check if we should attempt a fallback after exhausting retries
 */
export function shouldAttemptFallback(
  consecutive429Errors: number,
  fallbackChain: FallbackChain,
  maxRetriesBeforeFallback: number = 3
): boolean {
  if (consecutive429Errors < maxRetriesBeforeFallback) {
    return false
  }
  return !isFallbackChainExhausted(fallbackChain)
}

/**
 * Execute an operation with rate limit handling and automatic fallback
 */
export async function executeWithRateLimitHandling<T>(
  operation: () => Promise<T>,
  currentModel: FallbackModel,
  fallbackChain: FallbackChain,
  options: {
    maxRetries?: number
    retryMultiplier?: number
    maxRateLimitWaitMs?: number
    onFallback?: (newModel: FallbackModel) => void
    onRetry?: (attempt: number, waitMs: number, reason: string) => void
  } = {}
): Promise<{ result: T; modelUsed: FallbackModel; had429Error: boolean; retriesAttempted: number }> {
  const {
    maxRetries = 10,
    retryMultiplier = 3,
    maxRateLimitWaitMs = 5 * 60 * 1000,
    onFallback,
    onRetry,
  } = options

  let model = currentModel
  let chain = fallbackChain
  let consecutive429 = 0
  let totalRetries = 0
  let had429 = false

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await operation()
      return { result, modelUsed: model, had429Error: had429, retriesAttempted: totalRetries }
    } catch (error) {
      const rateLimitInfo = parseRateLimitError(error)
      had429 = true

      if (!rateLimitInfo.isRateLimit) {
        // Not a rate limit error - rethrow
        throw error
      }

      totalRetries++

      const decision = handleRateLimit(
        rateLimitInfo,
        model,
        chain,
        consecutive429,
        retryMultiplier,
        maxRateLimitWaitMs
      )

      if (decision.shouldFallback && decision.nextModel) {
        // Fallback to next model
        consecutive429 = 0
        model = decision.nextModel
        chain = advanceFallbackChain(chain)
        if (onFallback) onFallback(model)
        continue
      }

      // Wait before retry
      if (decision.waitMs > 0) {
        if (onRetry) onRetry(attempt + 1, decision.waitMs, decision.reason)
        await new Promise((resolve) => setTimeout(resolve, decision.waitMs))
        consecutive429++
      }
    }
  }

  throw new Error('Max retries exceeded for rate limit handling')
}