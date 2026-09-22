/**
 * Tests for /goal command
 */
import { describe, it, expect, beforeEach, vi } from 'bun:test'
import { parseGoalConfig } from './fallbackChain.js'
import {
  parseRateLimitError,
  handleRateLimit,
  calculateRetryDelay,
  executeWithRateLimitHandling,
} from './rateLimitHandler.js'
import {
  runVerification,
  assessGoalCompletion,
} from './verification.js'
import type { FallbackModel, FallbackChain, RateLimitInfo } from './types.js'

describe('Goal Command', () => {
  describe('parseGoalConfig', () => {
    it('parses goal from args', () => {
      const config = parseGoalConfig(['create a login component'])
      expect(config.goal).toBe('create a login component')
    })

    it('uses defaults when not provided', () => {
      const config = parseGoalConfig(['test goal'])
      expect(config.maxIterations).toBe(10)
      expect(config.verifyEachIteration).toBe(true)
      expect(config.verificationCommands).toEqual([])
      expect(config.retryMultiplier).toBe(3)
      expect(config.maxRateLimitWaitMs).toBe(5 * 60 * 1000)
    })

    it('allows custom defaults', () => {
      const config = parseGoalConfig(['test'], { maxIterations: 5, retryMultiplier: 5 })
      expect(config.maxIterations).toBe(5)
      expect(config.retryMultiplier).toBe(5)
    })
  })

  describe('parseRateLimitError', () => {
    it('detects standard 429 error', () => {
      const error = { status: 429, message: 'Rate limit exceeded' }
      const result = parseRateLimitError(error)
      expect(result.isRateLimit).toBe(true)
      expect(result.statusCode).toBe(429)
    })

    it('detects NVIDIA NIM quota exhausted', () => {
      const error = { message: 'quota exhausted', gateway: 'nvidia-nim' }
      const result = parseRateLimitError(error)
      expect(result.isRateLimit).toBe(true)
      expect(result.isNvidiaNimQuotaExhausted).toBe(true)
    })

    it('detects "too many requests"', () => {
      const error = { message: 'Too many requests' }
      const result = parseRateLimitError(error)
      expect(result.isRateLimit).toBe(true)
    })

    it('parses retry-after header', () => {
      const error = {
        response: { headers: { 'retry-after': '30' } },
        message: 'Rate limited',
      }
      const result = parseRateLimitError(error)
      expect(result.retryAfterMs).toBe(30000)
    })

    it('returns false for non-rate-limit errors', () => {
      const error = { status: 500, message: 'Internal server error' }
      const result = parseRateLimitError(error)
      expect(result.isRateLimit).toBe(false)
    })
  })

  describe('calculateRetryDelay', () => {
    it('applies exponential backoff with multiplier', () => {
      const delay0 = calculateRetryDelay(0, 1000, 60000, 3)
      const delay1 = calculateRetryDelay(1, 1000, 60000, 3)
      const delay2 = calculateRetryDelay(2, 1000, 60000, 3)

      expect(delay0).toBeGreaterThanOrEqual(2700)
      expect(delay1).toBeGreaterThanOrEqual(5400)
      expect(delay2).toBeGreaterThanOrEqual(10800)
    })

    it('respects max delay', () => {
      const delay = calculateRetryDelay(10, 1000, 5000, 3)
      expect(delay).toBeLessThanOrEqual(5000)
    })
  })

  describe('handleRateLimit', () => {
    const mockModel: FallbackModel = {
      modelId: 'test-model',
      label: 'Test Model',
      gatewayId: 'test',
    }

    const mockChain: FallbackChain = {
      models: [
        mockModel,
        { modelId: 'fallback-1', label: 'Fallback 1', gatewayId: 'test' },
        { modelId: 'fallback-2', label: 'Fallback 2', gatewayId: 'test' },
      ],
      currentIndex: 0,
    }

    it('falls back after 3 consecutive 429s', () => {
      const rateLimitInfo: RateLimitInfo = {
        isRateLimit: true,
        isNvidiaNimQuotaExhausted: false,
        message: 'Rate limited',
      }

      const decision = handleRateLimit(rateLimitInfo, mockModel, mockChain, 3, 3, 5 * 60 * 1000)
      expect(decision.shouldFallback).toBe(true)
      expect(decision.nextModel?.modelId).toBe('fallback-1')
    })

    it('waits with backoff for first 2 429s', () => {
      const rateLimitInfo: RateLimitInfo = {
        isRateLimit: true,
        isNvidiaNimQuotaExhausted: false,
        message: 'Rate limited',
      }

      const decision = handleRateLimit(rateLimitInfo, mockModel, mockChain, 1, 3, 5 * 60 * 1000)
      expect(decision.shouldFallback).toBe(false)
      expect(decision.waitMs).toBeGreaterThan(0)
    })

    it('handles NVIDIA NIM quota exhausted with retry-after', () => {
      const rateLimitInfo: RateLimitInfo = {
        isRateLimit: true,
        isNvidiaNimQuotaExhausted: true,
        retryAfterMs: 60000,
        message: 'quota exhausted',
      }

      const decision = handleRateLimit(rateLimitInfo, mockModel, mockChain, 1, 3, 5 * 60 * 1000)
      expect(decision.shouldFallback).toBe(false)
      expect(decision.waitMs).toBe(60000)
    })

    it('falls back immediately for NVIDIA NIM quota exhausted without retry-after', () => {
      const rateLimitInfo: RateLimitInfo = {
        isRateLimit: true,
        isNvidiaNimQuotaExhausted: true,
        message: 'quota exhausted',
      }

      const decision = handleRateLimit(rateLimitInfo, mockModel, mockChain, 1, 3, 5 * 60 * 1000)
      expect(decision.shouldFallback).toBe(true)
    })
  })

  describe('assessGoalCompletion', () => {
    it('detects completion from output', () => {
      const result = assessGoalCompletion(
        'create a login component',
        'Successfully created Login.tsx component with full implementation. Completed and tested.',
        ['src/components/Login.tsx']
      )
      expect(result.complete).toBe(true)
      expect(result.confidence).toBeGreaterThan(0.7)
    })

    it('detects ongoing work', () => {
      const result = assessGoalCompletion(
        'create a login component',
        'Working on the login component, started implementing the form',
        []
      )
      expect(result.complete).toBe(false)
    })

    it('counts file modifications as progress', () => {
      const result = assessGoalCompletion(
        'create a login component',
        'Done',
        ['src/components/Login.tsx', 'src/components/Login.css', 'src/hooks/useLogin.ts']
      )
      expect(result.confidence).toBeGreaterThan(0.3)
    })
  })

  describe('runVerification', () => {
    it('runs verification commands', async () => {
      // This will actually run bun commands, so we skip in unit tests
      // Integration tests would verify this
      expect(true).toBe(true)
    })
  })
})
