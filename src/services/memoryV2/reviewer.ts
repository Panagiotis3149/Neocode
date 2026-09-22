import { getSecretLabel, scanForSecrets, sanitizeSecretsWithPlaceholders, type SecretPlaceholder } from '../teamMemorySync/secretScanner.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from './featureGates.js'

export const REVIEWER_TOKENIZER_ID = 'unicode-codepoint-v1'
export const MAX_REVIEWER_CURSOR_TOKENS = 12_000
export const REVIEWER_PLACEHOLDER_INSTRUCTIONS = 'preserve every redacted placeholder exactly as written; never expand, infer, or replace a placeholder with its hidden value.'

export type ReviewerMutationClass = 'memory' | 'skill' | 'provider' | 'observation'

export type ReviewerEvidence = Readonly<{
  sourceMessageIds: readonly string[]
  mutationClass: ReviewerMutationClass
  attachmentsExcluded: boolean
}>

export type ReviewerEnvelope = Readonly<{
  requestId: string
  projectScopeId: string
  mutationClass: ReviewerMutationClass
  sanitizedInput: unknown
  placeholders: readonly SecretPlaceholder[]
  instructions: typeof REVIEWER_PLACEHOLDER_INSTRUCTIONS
  evidence?: ReviewerEvidence
}>

export type ReviewerCursor = Readonly<{
  sessionId: string
  messageId: string
  tokenOffset: number
  chunkIndex: number
  tokenizerId: typeof REVIEWER_TOKENIZER_ID
}>

export type ReviewerChunk = Readonly<{
  messageId: string
  chunkIndex: number
  tokenCount: number
  text: string
  cursor: ReviewerCursor
  nextCursor: ReviewerCursor
}>

export class ReviewerDisabledError extends Error {
  constructor() {
    super('Memory V2 reviewer is disabled')
    this.name = 'ReviewerDisabledError'
  }
}

export class ReviewerEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewerEvidenceError'
  }
}

export class ReviewerCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewerCursorError'
  }
}

export function sanitizeReviewerInput(input: string): ReturnType<typeof sanitizeSecretsWithPlaceholders> {
  if (typeof input !== 'string') throw new TypeError('Reviewer input must be a string')
  return sanitizeSecretsWithPlaceholders(input)
}

export type ReviewerPayloadSanitization = Readonly<{
  sanitized: unknown
  placeholders: readonly SecretPlaceholder[]
  containsOriginalSecret: (content: string) => boolean
}>

type SanitizationState = {
  placeholders: SecretPlaceholder[]
  checks: Array<(content: string) => boolean>
}

function privateToolField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'private' || normalized === 'privateoutput' || normalized === 'privatetooloutput' || normalized === 'tooloutputprivate' || normalized === 'sensitiveoutput' || normalized === 'secret' || normalized === 'password' || normalized === 'authorization' || normalized === 'apikey'
}

function nextPlaceholder(state: SanitizationState, ruleId: string): string {
  const placeholder = `[REDACTED:${ruleId}:${state.placeholders.length + 1}]`
  state.placeholders.push({ placeholder, ruleId })
  return placeholder
}

function sanitizePayloadValue(value: unknown, state: SanitizationState): unknown {
  if (typeof value === 'string') {
    const local = sanitizeReviewerInput(value)
    state.checks.push(local.containsOriginalSecret)
    let sanitized = local.sanitized
    for (const placeholder of local.placeholders) {
      const replacement = nextPlaceholder(state, getSecretLabel(placeholder.ruleId))
      sanitized = sanitized.replaceAll(placeholder.placeholder, replacement)
    }
    return sanitized
  }
  if (Array.isArray(value)) return value.map(item => sanitizePayloadValue(item, state))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (privateToolField(key)) {
        const original = typeof child === 'string' ? child : JSON.stringify(child)
        if (original) state.checks.push((candidate: string) => candidate.includes(original))
        return [key, nextPlaceholder(state, 'PRIVATE_TOOL_OUTPUT')]
      }
      return [key, sanitizePayloadValue(child, state)]
    }))
  }
  return value
}

export function sanitizeReviewerPayload(input: unknown): ReviewerPayloadSanitization {
  const state: SanitizationState = { placeholders: [], checks: [] }
  const sanitized = sanitizePayloadValue(input, state)
  return Object.freeze({
    sanitized,
    placeholders: Object.freeze(state.placeholders),
    containsOriginalSecret: (content: string) => state.checks.some(check => check(content)),
  })
}

function validateEvidence(mutationClass: ReviewerMutationClass, evidence: ReviewerEvidence | undefined): void {
  if (mutationClass === 'observation') return
  if (!evidence || evidence.mutationClass !== mutationClass) {
    throw new ReviewerEvidenceError('Durable reviewer mutations require matching evidence')
  }
  if (evidence.sourceMessageIds.length === 0) {
    throw new ReviewerEvidenceError('Durable reviewer mutations require source message IDs')
  }
  if (!evidence.attachmentsExcluded) {
    throw new ReviewerEvidenceError('Reviewer evidence must exclude attachments')
  }
}

export function createReviewerEnvelope(
  input: Readonly<{
    requestId: string
    projectScopeId: string
    source: unknown
    mutationClass: ReviewerMutationClass
    evidence?: ReviewerEvidence
  }>,
  gates: FeatureGateRequest = {},
): ReviewerEnvelope {
  if (!isFeatureGateEnabled('MEMORY_REVIEWER', gates)) throw new ReviewerDisabledError()
  if (!input.requestId || !input.projectScopeId) throw new TypeError('Reviewer request and project scope are required')
  validateEvidence(input.mutationClass, input.evidence)
  const sanitized = sanitizeReviewerPayload(input.source)
  return Object.freeze({
    requestId: input.requestId,
    projectScopeId: input.projectScopeId,
    mutationClass: input.mutationClass,
    sanitizedInput: sanitized.sanitized,
    placeholders: sanitized.placeholders,
    instructions: REVIEWER_PLACEHOLDER_INSTRUCTIONS,
    ...(input.evidence ? { evidence: Object.freeze({ ...input.evidence, sourceMessageIds: Object.freeze([...input.evidence.sourceMessageIds]) }) } : {}),
  })
}

export function validateReviewerOutput(
  source: Pick<ReviewerPayloadSanitization, 'containsOriginalSecret' | 'placeholders'>,
  output: string,
): { accepted: true; text: string } {
  if (typeof output !== 'string') throw new ReviewerEvidenceError('Reviewer output must be text')
  if (source.containsOriginalSecret(output)) throw new ReviewerEvidenceError('Reviewer output contains a source secret')
  if (scanForSecrets(output).length > 0) throw new ReviewerEvidenceError('Reviewer output contains a detected secret')
  const known = new Set(source.placeholders.map(item => item.placeholder))
  const emitted = output.match(/\[REDACTED:[^\]]+\]/g) ?? []
  if (emitted.some(item => !known.has(item))) throw new ReviewerEvidenceError('Reviewer output changed a secret placeholder')
  return { accepted: true, text: output }
}

export async function reviewWithRetry(
  source: Pick<ReviewerPayloadSanitization, 'containsOriginalSecret' | 'placeholders'>,
  sanitizedInput: unknown,
  send: (input: unknown) => Promise<string>,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return validateReviewerOutput(source, await send(sanitizedInput)).text
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new ReviewerEvidenceError('Reviewer output was rejected')
}

export function createReviewerCursor(input: Readonly<{
  sessionId: string
  messageId: string
  tokenOffset: number
  tokenizerId: string
  chunkIndex?: number
}>): ReviewerCursor {
  if (!input.sessionId || !input.messageId) throw new ReviewerCursorError('Reviewer cursor identity is required')
  if (input.tokenizerId !== REVIEWER_TOKENIZER_ID) throw new ReviewerCursorError('Unsupported reviewer tokenizer identity')
  if (!Number.isSafeInteger(input.tokenOffset) || input.tokenOffset < 0 || input.tokenOffset > MAX_REVIEWER_CURSOR_TOKENS) {
    throw new ReviewerCursorError('Reviewer cursor exceeds the bounded token offset')
  }
  const chunkIndex = input.chunkIndex ?? 0
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new ReviewerCursorError('Reviewer chunk index must be non-negative')
  return Object.freeze({
    sessionId: input.sessionId,
    messageId: input.messageId,
    tokenOffset: input.tokenOffset,
    chunkIndex,
    tokenizerId: REVIEWER_TOKENIZER_ID,
  })
}

export function advanceReviewerCursor(cursor: ReviewerCursor, tokenCount: number): ReviewerCursor {
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) throw new ReviewerCursorError('Reviewer token count must be non-negative')
  return createReviewerCursor({ ...cursor, tokenOffset: cursor.tokenOffset + tokenCount })
}

export function chunkReviewerUnit(input: Readonly<{ messageId: string; text: string; sessionId?: string }>): readonly ReviewerChunk[] {
  if (!input.messageId) throw new ReviewerCursorError('Reviewer message identity is required')
  if (typeof input.text !== 'string') throw new TypeError('Reviewer unit must be text')
  const tokens = Array.from(input.text)
  if (tokens.length === 0) {
    return Object.freeze([{ messageId: input.messageId, chunkIndex: 0, tokenCount: 0, text: '', cursor: createReviewerCursor({ sessionId: input.sessionId ?? 'reviewer', messageId: input.messageId, tokenOffset: 0, chunkIndex: 0, tokenizerId: REVIEWER_TOKENIZER_ID }), nextCursor: createReviewerCursor({ sessionId: input.sessionId ?? 'reviewer', messageId: input.messageId, tokenOffset: 0, chunkIndex: 1, tokenizerId: REVIEWER_TOKENIZER_ID }) }])
  }
  const chunks: ReviewerChunk[] = []
  for (let offset = 0, chunkIndex = 0; offset < tokens.length; offset += MAX_REVIEWER_CURSOR_TOKENS, chunkIndex += 1) {
    const text = tokens.slice(offset, offset + MAX_REVIEWER_CURSOR_TOKENS).join('')
    chunks.push(Object.freeze({
      messageId: input.messageId,
      chunkIndex,
      tokenCount: text.length === 0 ? 0 : Array.from(text).length,
      text,
      cursor: createReviewerCursor({ sessionId: input.sessionId ?? 'reviewer', messageId: input.messageId, tokenOffset: 0, chunkIndex, tokenizerId: REVIEWER_TOKENIZER_ID }),
      nextCursor: createReviewerCursor({ sessionId: input.sessionId ?? 'reviewer', messageId: input.messageId, tokenOffset: 0, chunkIndex: chunkIndex + 1, tokenizerId: REVIEWER_TOKENIZER_ID }),
    }))
  }
  return Object.freeze(chunks)
}
