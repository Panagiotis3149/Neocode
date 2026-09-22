import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { SendMessageTool } from './SendMessageTool.js'

test('routes subagent messages through the supervisor runtime', async () => {
  const calls: Array<[string, string, string]> = []
  const context = {
    subagentRuntime: {
      agentId: 'agent-a',
      agentName: 'explorer',
      supervisor: {
        sendMessage: async (
          fromAgentId: string,
          toAgent: string,
          content: string,
        ) => {
          calls.push([fromAgentId, toAgent, content])
        },
      },
    },
  } as unknown as ToolUseContext

  const result = await SendMessageTool.call(
    { to: 'subagent:researcher', message: 'Summarize the auth flow' },
    context,
    undefined as never,
    undefined as never,
  )

  expect(calls).toEqual([
    ['agent-a', 'subagent:researcher', 'Summarize the auth flow'],
  ])
  expect(result.data).toMatchObject({
    success: true,
    routing: {
      sender: 'explorer',
      target: '@subagent:researcher',
    },
  })
})

test('routes main messages through the session supervisor', async () => {
  const calls: Array<[string, string, string]> = []
  const context = {
    subagentSupervisor: {
      sendMessage: async (
        fromAgentId: string,
        toAgent: string,
        content: string,
      ) => {
        calls.push([fromAgentId, toAgent, content])
      },
    },
  } as unknown as ToolUseContext

  await SendMessageTool.call(
    { to: 'subagent:researcher', message: 'Please check the tests' },
    context,
    undefined as never,
    undefined as never,
  )

  expect(calls).toEqual([
    ['main', 'subagent:researcher', 'Please check the tests'],
  ])
})
