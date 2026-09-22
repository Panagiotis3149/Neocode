/**
 * Autonomous executor - runs the agent loop until goal is complete and verified
 */
import type {
  GoalExecutionState,
  IterationResult,
  FallbackModel,
  FallbackChain,
  GoalConfig,
  AgentResult,
} from './types.js'
import { runVerification, assessGoalCompletion } from './verification.js'
import { getNextFallbackModel, advanceFallbackChain } from './fallbackChain.js'

export interface AutonomousExecutorCallbacks {
  onIterationComplete: (result: IterationResult) => void
  onModelFallback: (newModel: FallbackModel) => void
}

export interface AutonomousExecutorOptions {
  config: GoalConfig
  state: GoalExecutionState
  callbacks: AutonomousExecutorCallbacks
}

/**
 * Build the agent prompt for a goal iteration
 */
function buildAgentPrompt(state: GoalExecutionState, config: GoalConfig): string {
  const historySummary = state.history
    .slice(-3)
    .map(
      (h) =>
        `Iteration ${h.iteration + 1}: ${h.result.success ? '✓' : '✗'} ${h.result.output.slice(0, 100)}`
    )
    .join('\n')

  const fallbackInfo =
    state.fallbackChain.currentIndex > 0
      ? `\nCurrent model: ${state.currentModel?.label} (fallback #${state.fallbackChain.currentIndex})`
      : ''

  return `AUTONOMOUS GOAL EXECUTION - Iteration ${state.iteration + 1} of ${config.maxIterations}

GOAL: ${state.goal}

${fallbackInfo}

PREVIOUS ITERATIONS:
${historySummary || '(first iteration)'}

TOTAL 429 ERRORS: ${state.total429Errors} (${state.consecutive429Errors} consecutive on current model)

INSTRUCTIONS:
1. Continue working on the goal from where you left off
2. Make concrete progress - edit files, run commands, create tests
3. If you encounter rate limits (429 errors), the system will handle fallback automatically
4. Be specific about what you accomplish in this iteration
5. Output a clear summary of what you did

REQUIRED OUTPUT FORMAT:
- List files modified/created
- Commands run
- Brief summary of progress
- Whether goal is complete

Start working on the goal now.`
}

/**
 * Run a single iteration of the autonomous executor
 */
async function runIteration(
  state: GoalExecutionState,
  config: GoalConfig,
  model: FallbackModel
): Promise<IterationResult> {
  const prompt = buildAgentPrompt(state, config)
  let had429Error = false
  let retriesAttempted = 0

  try {
    // Execute agent with the current model.
    // NOTE: AgentTool is a tool def, not a callable. Real autonomous execution
    // requires wiring through the tool framework (toolUseContext, canUseTool,
    // etc.). Until that's wired up, this stub returns a placeholder so the
    // command compiles and the UI renders. The verification step still runs.
    const agentResult = `[stub] Iteration ${state.iteration + 1} for goal: ${state.goal}`

    // Check if agent output mentions 429 errors
    if (agentResult.includes('429') || agentResult.includes('rate limit')) {
      had429Error = true
      retriesAttempted = 1 // Will be tracked by rate limit handler
    }

    const result: AgentResult = {
      success: !agentResult.includes('error') && !agentResult.includes('failed'),
      output: agentResult,
      filesModified: extractFilesModified(agentResult),
      commandsRun: extractCommandsRun(agentResult),
    }

    // Run verification if enabled
    let verificationResult
    if (config.verifyEachIteration) {
      verificationResult = await runVerification(config.verificationCommands)
    }

    // Assess goal completion
    const completion = assessGoalCompletion(state.goal, agentResult, result.filesModified || [])

    return {
      iteration: state.iteration,
      prompt,
      result,
      verification: verificationResult,
      modelUsed: model,
      had429Error,
      retriesAttempted,
      timestamp: Date.now(),
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    // Check if it's a rate limit error
    if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
      had429Error = true
      retriesAttempted = 1
    }

    const result: AgentResult = {
      success: false,
      output: errorMsg,
      error: errorMsg,
    }

    return {
      iteration: state.iteration,
      prompt,
      result,
      modelUsed: model,
      had429Error,
      retriesAttempted,
      timestamp: Date.now(),
    }
  }
}

/**
 * Extract files mentioned as modified from agent output
 */
function extractFilesModified(output: string): string[] {
  const files: string[] = []
  const patterns = [
    /(?:created|modified|updated|edited|wrote)\s+([\w\/\\.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|py|rs|go|java))/gi,
    /(?:file|path)[:\s]+([\w\/\\.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|py|rs|go|java))/gi,
    /['"]([\w\/\\.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|py|rs|go|java))['"]/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1]
      if (file && !files.includes(file)) {
        files.push(file)
      }
    }
  }

  return files
}

/**
 * Extract commands run from agent output
 */
function extractCommandsRun(output: string): string[] {
  const commands: string[] = []
  const patterns = [
    /(?:ran|executed|running)\s+[`"']?([^`"'\n]+)[`"']?/gi,
    /\$\s+([^\n]+)/g,
    />\s+([^\n]+)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(output)) !== null) {
      const cmd = match[1]?.trim()
      if (cmd && !commands.includes(cmd)) {
        commands.push(cmd)
      }
    }
  }

  return commands
}

/**
 * Main autonomous execution loop
 */
export async function autonomousExecute(
  initialState: GoalExecutionState,
  callbacks: AutonomousExecutorCallbacks
): Promise<{ isComplete: boolean; finalState: GoalExecutionState }> {
  let state = { ...initialState }
  const config: GoalConfig = {
    goal: state.goal,
    maxIterations: state.maxIterations,
    verifyEachIteration: true,
    verificationCommands: ['bun run build', 'bun test'],
    retryMultiplier: 3,
    maxRateLimitWaitMs: 5 * 60 * 1000,
  }

  while (!state.isComplete && state.iteration < state.maxIterations) {
    const currentModel = state.currentModel
    if (!currentModel) {
      throw new Error('No current model available')
    }

    // Run iteration
    const iterationResult = await runIteration(state, config, currentModel)

    // Callback with result
    callbacks.onIterationComplete(iterationResult)

    // Update state
    state = {
      ...state,
      iteration: state.iteration + 1,
      history: [...state.history, iterationResult],
      lastActivityAt: Date.now(),
      isComplete: iterationResult.result.success && (iterationResult.verification?.passed ?? false),
      verified: iterationResult.verification?.passed ?? false,
      total429Errors: state.total429Errors + (iterationResult.had429Error ? 1 : 0),
      consecutive429Errors: iterationResult.had429Error
        ? state.consecutive429Errors + 1
        : 0,
    }

    // Check if we need to fallback model
    if (iterationResult.had429Error && state.consecutive429Errors >= 3) {
      const nextModel = getNextFallbackModel(state.fallbackChain)
      if (nextModel) {
        state = {
          ...state,
          currentModel: nextModel,
          fallbackChain: advanceFallbackChain(state.fallbackChain),
          consecutive429Errors: 0,
        }
        callbacks.onModelFallback(nextModel)
      }
    }

    // Small delay between iterations
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return {
    isComplete: state.isComplete,
    finalState: state,
  }
}

