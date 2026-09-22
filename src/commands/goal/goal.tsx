/**
 * /goal command - Autonomous feature execution until verified complete
 *
 * This command uses the LocalJSXCommandModule pattern: it exports a `call`
 * function that receives (onDone, context, userArgs) and returns a React node.
 *
 * The actual autonomous iteration is handled by the system prompt infrastructure
 * — the command's job is to emit the goal-targeting prompt and let the main
 * agent loop execute it.
 */
import type { ReactNode } from 'react'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { getTheme, type ThemeName } from '../../utils/theme.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

interface GoalUIProps {
  goal: string
  themeName: ThemeName
  error?: string
}

const GoalUI = ({ goal, themeName, error }: GoalUIProps) => {
  const theme = getTheme(themeName)

  if (error) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.error}>/goal: {error}</Text>
        <Text color={theme.subtle}>Usage: /goal {'<feature description>'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color={theme.claude}>Goal set: </Text>
      <Text>{goal}</Text>
      <Text color={theme.subtle}>
        The agent will work autonomously toward this goal, verifying progress
        as it goes.
      </Text>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  userArgs: string,
): Promise<ReactNode> {
  const goal = userArgs.trim()
  const themeName = context.options?.theme ?? 'dark'

  if (!goal) {
    onDone('/goal: missing goal description')
    return <GoalUI goal="" themeName={themeName} error="Missing goal description. Usage: /goal <feature description>" />
  }

  onDone(
    [
      `Goal set: ${goal}`,
      ``,
      `Pursue this goal autonomously. Make concrete progress each turn — edit files, run commands,`,
      `and verify your work. Do not ask for confirmation; use your best judgment and keep going`,
      `until the goal is achieved and verified.`,
    ].join('\n'),
    { display: 'system' },
  )

  return <GoalUI goal={goal} themeName={themeName} />
}

export default call