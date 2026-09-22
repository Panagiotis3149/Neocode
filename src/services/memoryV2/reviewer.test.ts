import { describe, expect, test } from 'bun:test'

import {
  REVIEWER_TOKENIZER_ID,
  ReviewerCursorError,
  chunkReviewerUnit,
  createReviewerCursor,
  createReviewerEnvelope,
  reviewWithRetry,
  sanitizeReviewerPayload,
  sanitizeReviewerInput,
  validateReviewerOutput,
  type ReviewerEvidence,
} from './reviewer.js'

describe('Memory V2 reviewer', () => {
  test('sanitizes scanner-detected secrets before a remote request', () => {
    const secret = 'ghp_123456789012345678901234567890123456'
    const result = sanitizeReviewerInput(`Keep this token ${secret} private.`)

    expect(result.sanitized).not.toContain(secret)
    expect(result.sanitized).toContain('[REDACTED:GitHub PAT:1]')
    expect(result.placeholders).toEqual([
      { placeholder: '[REDACTED:GitHub PAT:1]', ruleId: 'github-pat' },
    ])
  })

  test('sanitizes structured private tool fields and assigns request-wide unique placeholders', () => {
    const result = sanitizeReviewerPayload({
      first: 'ghp_123456789012345678901234567890123456',
      tool: { privateOutput: 'private result', token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' },
    })
    const serialized = JSON.stringify(result.sanitized)
    expect(serialized).not.toContain('ghp_')
    expect(serialized).not.toContain('private result')
    expect(result.placeholders.map(item => item.placeholder)).toEqual([
      '[REDACTED:GitHub PAT:1]',
      '[REDACTED:PRIVATE_TOOL_OUTPUT:2]',
      '[REDACTED:GitHub PAT:3]',
    ])
  })

  test('includes explicit placeholder preservation instructions in the envelope', () => {
    const envelope = createReviewerEnvelope({
      projectScopeId: 'project-a',
      source: 'observation',
      mutationClass: 'observation',
      requestId: 'review-instructions',
    }, { MEMORY_REVIEWER: true, MEMORY_STORE_V2: true })
    expect(envelope.instructions).toContain('preserve')
    expect(envelope.instructions).toContain('placeholder')
  })

  test('does not restore placeholders and rejects secret-bearing output', () => {
    const source = sanitizeReviewerInput(
      'Use ghp_123456789012345678901234567890123456 only locally.',
    )
    expect(validateReviewerOutput(source, 'Use [REDACTED:GitHub PAT:1] locally.')).toEqual({
      accepted: true,
      text: 'Use [REDACTED:GitHub PAT:1] locally.',
    })
    expect(() => validateReviewerOutput(source, 'ghp_123456789012345678901234567890123456')).toThrow()
    expect(() => validateReviewerOutput(source, 'Use [REDACTED:GitHub PAT:9] locally.')).toThrow()
    expect(() => validateReviewerOutput(source, 'Use [REDACTED:AWS_KEY:1] locally.')).toThrow()
  })

  test('requires evidence for durable memory mutations but allows observational review', () => {
    const evidence: ReviewerEvidence = {
      sourceMessageIds: ['message-1'],
      mutationClass: 'memory',
      attachmentsExcluded: true,
    }
    expect(() => createReviewerEnvelope({
      projectScopeId: 'project-a',
      source: 'memory candidate',
      mutationClass: 'memory',
      evidence,
      requestId: 'review-1',
    }, { MEMORY_REVIEWER: true, MEMORY_STORE_V2: true })).not.toThrow()
    expect(() => createReviewerEnvelope({
      projectScopeId: 'project-a',
      source: 'memory candidate',
      mutationClass: 'memory',
      evidence: { sourceMessageIds: [], mutationClass: 'memory', attachmentsExcluded: true },
      requestId: 'review-2',
    }, { MEMORY_REVIEWER: true, MEMORY_STORE_V2: true })).toThrow()
    expect(() => createReviewerEnvelope({
      projectScopeId: 'project-a',
      source: 'observation',
      mutationClass: 'observation',
      requestId: 'review-3',
    }, { MEMORY_REVIEWER: true, MEMORY_STORE_V2: true })).not.toThrow()
  })

  test('persists tokenizer identity and bounds cursor advancement', () => {
    const cursor = createReviewerCursor({
      sessionId: 'session-1',
      messageId: 'message-1',
      tokenOffset: 12_000,
      tokenizerId: REVIEWER_TOKENIZER_ID,
    })
    expect(cursor.tokenizerId).toBe(REVIEWER_TOKENIZER_ID)
    expect(() => createReviewerCursor({
      sessionId: 'session-1',
      messageId: 'message-1',
      tokenOffset: 12_001,
      tokenizerId: REVIEWER_TOKENIZER_ID,
    })).toThrow(ReviewerCursorError)
    expect(() => createReviewerCursor({
      sessionId: 'session-1',
      messageId: 'message-1',
      tokenOffset: 0,
      tokenizerId: 'different-tokenizer',
    })).toThrow()
  })

  test('allows one retry and rejects the second invalid reviewer output', async () => {
    const source = sanitizeReviewerInput('Keep ghp_123456789012345678901234567890123456 private.')
    let attempts = 0
    await expect(reviewWithRetry(source, source.sanitized, async () => {
      attempts += 1
      return attempts === 1 ? 'ghp_123456789012345678901234567890123456' : 'Keep [REDACTED:GitHub PAT:1] private.'
    })).resolves.toBe('Keep [REDACTED:GitHub PAT:1] private.')
    expect(attempts).toBe(2)
  })

  test('splits a giant reviewer unit into deterministic 12000-token chunks', () => {
    const text = '😀'.repeat(24_001)
    const chunks = chunkReviewerUnit({ messageId: 'message-giant', text })
    expect(chunks.map(chunk => chunk.tokenCount)).toEqual([12_000, 12_000, 1])
    expect(chunks.map(chunk => chunk.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text)
    expect(chunks[0].cursor.tokenizerId).toBe(REVIEWER_TOKENIZER_ID)
    expect(chunks[1].cursor.tokenOffset).toBe(0)
  })
})
