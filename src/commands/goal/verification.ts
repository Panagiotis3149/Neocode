/**
 * Verification logic for goal completion
 */
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

export const DEFAULT_VERIFICATION_COMMANDS: string[] = []

export interface VerificationResult {
  passed: boolean
  commands: VerificationCommandResult[]
  summary: string
}

export interface VerificationCommandResult {
  command: string
  success: boolean
  output: string
  error?: string
  exitCode: number
}

/**
 * Run verification commands
 */
export async function runVerification(
  commands: string[] = DEFAULT_VERIFICATION_COMMANDS
): Promise<VerificationResult> {
  const results: VerificationCommandResult[] = []

  for (const command of commands) {
    try {
      const parts = command.split(' ')
      const proc = await execFileNoThrow(parts[0], parts.slice(1), {
        timeout: 120000,
        useCwd: true,
      })
      results.push({
        command,
        success: proc.code === 0,
        output: proc.stdout,
        error: proc.stderr || undefined,
        exitCode: proc.code,
      })
    } catch (error) {
      const err = error as any
      results.push({
        command,
        success: false,
        output: err.stdout?.toString() || '',
        error: err.stderr?.toString() || err.message,
        exitCode: err.exitCode ?? 1,
      })
    }
  }

  const allPassed = results.every((r) => r.success)
  const summary = allPassed
    ? `All ${results.length} verification commands passed`
    : `${results.filter((r) => !r.success).length}/${results.length} verification commands failed`

  return { passed: allPassed, commands: results, summary }
}

/**
 * Quick verification — runs default commands (project-agnostic, no hardcoded tools)
 */
export async function runQuickVerification(): Promise<VerificationResult> {
  return runVerification(DEFAULT_VERIFICATION_COMMANDS)
}

/**
 * Assess if a goal is complete based on agent output and files modified
 */
export interface GoalAssessment {
  complete: boolean
  confidence: number
  reasons: string[]
}

export function assessGoalCompletion(
  goal: string,
  agentOutput: string,
  filesModified: string[]
): GoalAssessment {
  const reasons: string[] = []
  let confidence = 0

  // Check for completion keywords in output
  const completionKeywords = [
    'completed',
    'finished',
    'done',
    'implemented',
    'created',
    'successfully',
    'working',
    'verified',
    'tested',
    'deployed',
  ]

  const ongoingKeywords = [
    'working on',
    'in progress',
    'starting',
    'beginning',
    'attempting',
    'trying',
    'still',
    'continue',
    'need to',
    'next',
  ]

  const outputLower = agentOutput.toLowerCase()

  // Positive signals
  for (const keyword of completionKeywords) {
    if (outputLower.includes(keyword)) {
      confidence += 0.15
      reasons.push(`Found completion keyword: "${keyword}"`)
    }
  }

  // Negative signals
  for (const keyword of ongoingKeywords) {
    if (outputLower.includes(keyword)) {
      confidence -= 0.1
      reasons.push(`Found ongoing keyword: "${keyword}"`)
    }
  }

  // File modifications are strong positive signal
  if (filesModified.length > 0) {
    confidence += Math.min(filesModified.length * 0.1, 0.5)
    reasons.push(`Modified ${filesModified.length} file(s)`)
  }

  // Goal relevance - check if output mentions goal-related terms
  const goalWords = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  let relevantWords = 0
  for (const word of goalWords) {
    if (outputLower.includes(word)) {
      relevantWords++
    }
  }
  if (relevantWords > 0) {
    confidence += Math.min(relevantWords * 0.15, 0.3)
    reasons.push(`Output mentions ${relevantWords} goal-related terms`)
  }

  // Clamp confidence
  confidence = Math.max(0, Math.min(1, confidence))

  // Consider complete if confidence > 0.6 and no strong negative signals
  const hasStrongNegative = outputLower.includes('failed') || outputLower.includes('error')
  const complete = confidence > 0.6 && !hasStrongNegative

  if (complete) {
    reasons.push('Assessed as complete based on confidence and signals')
  } else {
    reasons.push(`Confidence: ${Math.round(confidence * 100)}% ${hasStrongNegative ? '(negative signals present)' : ''}`)
  }

  return { complete, confidence, reasons }
}
