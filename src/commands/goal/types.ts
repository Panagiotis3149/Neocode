/**
 * Shared types for the /goal autonomous execution command
 */

export interface GoalConfig {
  /** The goal description provided by the user */
  goal: string
  /** Maximum number of autonomous iterations before stopping (default: 10) */
  maxIterations?: number
  /** Whether to run verification after each iteration (default: true) */
  verifyEachIteration?: boolean
  /** Custom verification commands (default: none — project-agnostic) */
  verificationCommands?: string[]
  /** Custom fallback model chain (default: derived from current model settings) */
  fallbackChain?: FallbackModel[]
  /** 429 retry multiplier (default: 3x) */
  retryMultiplier?: number
  /** Maximum wait time for rate limits in ms (default: 5 minutes) */
  maxRateLimitWaitMs?: number
}

export interface FallbackModel {
  /** Model identifier (e.g., "nvidia/llama-3.1-nemotron-70b-instruct") */
  modelId: string
  /** Human-readable label */
  label: string
  /** Gateway/provider ID this model belongs to */
  gatewayId: string
  /** Whether this is the default model for its gateway */
  isDefault?: boolean
  /** Whether this is a backup model */
  isBackup?: boolean
  /** Previous model that was working before */
  isPrevious?: boolean
}

export interface FallbackChain {
  /** Ordered list of fallback models */
  models: FallbackModel[]
  /** Current index in the chain */
  currentIndex: number
}

export interface GoalExecutionState {
  /** The original goal */
  goal: string
  /** Current iteration number (0-based) */
  iteration: number
  /** Maximum iterations allowed */
  maxIterations: number
  /** Whether the goal is considered complete */
  isComplete: boolean
  /** Whether verification passed */
  verified: boolean
  /** Current model being used */
  currentModel: FallbackModel | null
  /** Fallback chain for model switching */
  fallbackChain: FallbackChain
  /** Execution history */
  history: IterationResult[]
  /** Total 429 errors encountered */
  total429Errors: number
  /** Consecutive 429 errors on current model */
  consecutive429Errors: number
  /** Start time */
  startedAt: number
  /** Last activity time */
  lastActivityAt: number
}

export interface IterationResult {
  iteration: number
  /** The agent prompt used */
  prompt: string
  /** Agent execution result */
  result: AgentResult
  /** Verification result if run */
  verification?: VerificationResult
  /** Model used for this iteration */
  modelUsed: FallbackModel
  /** Whether a 429 occurred */
  had429Error: boolean
  /** Number of retries attempted */
  retriesAttempted: number
  /** Timestamp */
  timestamp: number
}

export interface AgentResult {
  /** Whether the agent completed successfully */
  success: boolean
  /** Agent output/summary */
  output: string
  /** Any error message */
  error?: string
  /** Files modified */
  filesModified?: string[]
  /** Commands run */
  commandsRun?: string[]
}

export interface VerificationResult {
  /** Whether verification passed */
  passed: boolean
  /** Commands that were run */
  commands: VerificationCommandResult[]
  /** Overall summary */
  summary: string
}

export interface VerificationCommandResult {
  command: string
  success: boolean
  output: string
  error?: string
  exitCode: number
}

export interface RateLimitInfo {
  /** Whether this is a rate limit error */
  isRateLimit: boolean
  /** Whether this is NVIDIA NIM "quota exhausted" (soft limit) */
  isNvidiaNimQuotaExhausted: boolean
  /** Retry-after delay in milliseconds */
  retryAfterMs?: number
  /** Raw error message */
  message: string
  /** HTTP status code */
  statusCode?: number
}

export interface FallbackDecision {
  /** Whether to fallback to next model */
  shouldFallback: boolean
  /** Next model to use, or null if exhausted */
  nextModel: FallbackModel | null
  /** Reason for decision */
  reason: string
  /** Wait time before retry/fallback in ms */
  waitMs: number
}