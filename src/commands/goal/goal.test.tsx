/**
 * Tests for /goal command
 */
import { describe, it, expect } from 'bun:test'
import {
  buildFallbackChain,
  getCurrentModel,
  getNextFallbackModel,
  advanceFallbackChain,
  resetFallbackChain,
} from './fallbackChain.js'
import {
  handleRateLimit,
  parseRateLimitError,
} from './rateLimitHandler.js'
import {
  assessGoalCompletion,
  runVerification,
} from './verification.js'
import type { FallbackModel, FallbackChain, GoalConfig } from './types.js'

describe('Goal Command Types', () => {
  it('should have correct type structure', () => {
    const config: GoalConfig = {
      goal: 'Test goal',
      maxIterations: 5,
      verifyEachIteration: true,
      retryMultiplier: 3,
    }
    expect(config.goal).toBe('Test goal')
    expect(config.maxIterations).toBe(5)
    expect(config.retryMultiplier).toBe(3)
  })
})

describe('Fallback Chain', () => {
  const mockModels: FallbackModel[] = [
    { modelId: 'model-1', label: 'Model 1', gatewayId: 'gateway-1', isDefault: true },
    { modelId: 'model-2', label: 'Model 2', gatewayId: 'gateway-1', isBackup: true },
    { modelId: 'model-3', label: 'Model 3', gatewayId: 'gateway-1', isPrevious: true },
  ]

  const mockChain: FallbackChain = {
    models: mockModels,
    currentIndex: 0,
  }

  it('should get next fallback model', () => {
    const next = getNextFallbackModel(mockChain)
    expect(next).toEqual(mockModels[1])
  })

  it('should advance fallback chain', () => {
    const advanced = advanceFallbackChain(mockChain)
    expect(advanced.currentIndex).toBe(1)
    expect(advanced.models).toEqual(mockModels)
  })

  it('should reset fallback chain', () => {
    const advanced = advanceFallbackChain(mockChain)
    const reset = resetFallbackChain(advanced, mockModels[0])
    expect(reset.currentIndex).toBe(0)
  })

  it('should return null when no more fallbacks', () => {
    const endChain: FallbackChain = { models: mockModels, currentIndex: 2 }
    const next = getNextFallbackModel(endChain)
    expect(next).toBeNull()
  })
})

describe('Rate Limit Handler', () => {
  it('should parse 429 error with retry-after header', () => {
    const error = new Error('Rate limited') as any
    error.status = 429
    error.headers = { 'retry-after': '60' }

    const result = parseRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
    expect(result.retryAfterMs).toBe(60000)
    expect(result.statusCode).toBe(429)
  })

  it('should detect NVIDIA NIM quota exhausted', () => {
    const error = new Error('quota exhausted: Too many requests') as any
    error.status = 429

    const result = parseRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
    expect(result.isNvidiaNimQuotaExhausted).toBe(true)
  })

  it('should detect NVIDIA NIM too many requests', () => {
    const error = new Error('NVIDIA NIM: Too many requests') as any
    error.status = 429

    const result = parseRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
    expect(result.isNvidiaNimQuotaExhausted).toBe(true)
  })

  it('should not treat non-429 as rate limit', () => {
    const error = new Error('Server error') as any
    error.status = 500

    const result = parseRateLimitError(error)
    expect(result.isRateLimit).toBe(false)
  })
})

describe('Goal Completion Assessment', () => {
  it('should detect completion with positive keywords', () => {
    const result = assessGoalCompletion(
      'Create a hello world component',
      'Successfully created and tested the hello world component. Implementation complete.',
      ['src/components/HelloWorld.tsx']
    )
    expect(result.complete).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('should detect incomplete with ongoing keywords', () => {
    const result = assessGoalCompletion(
      'Create a hello world component',
      'Working on creating the hello world component, still in progress',
      []
    )
    expect(result.complete).toBe(false)
  })

  it('should score file modifications positively', () => {
    const result = assessGoalCompletion(
      'Create a component',
      'Done with the task',
      ['file1.ts', 'file2.ts', 'file3.ts']
    )
    expect(result.confidence).toBeGreaterThan(0.3)
  })

  it('should detect goal relevance', () => {
    const result = assessGoalCompletion(
      'Add user authentication',
      'Implemented user authentication with JWT tokens and login flow',
      ['src/auth.ts']
    )
    expect(result.confidence).toBeGreaterThan(0.5)
  })
})

describe('Verification', () => {
  it('should have default verification commands', async () => {
    // Test that default commands are defined
    const { DEFAULT_VERIFICATION_COMMANDS } = await import('./verification.js')
    expect(DEFAULT_VERIFICATION_COMMANDS).toEqual([])
  })

  it('should run quick verification', async () => {
    const { runQuickVerification } = await import('./verification.js')
    // This will actually run build, so we just verify it doesn't throw
    const result = await runQuickVerification()
    expect(result).toHaveProperty('passed')
    expect(result).toHaveProperty('summary')
  })
})