import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type {
  SupervisorEvent,
  SpawnMode,
  SubagentModelConfig,
  Verbosity,
} from './subagentEventBus.js'
import type { Benchmarks } from '../../utils/model/benchmarkRegistry.js'

export type SubagentStatus = 'running' | 'paused' | 'done' | 'failed'

export type SubagentModelOverrides = {
  model?: string
  provider?: string
  temperature?: number
  reasoning_effort?: 'low' | 'medium' | 'high'
}

export type QueuedSubagentMessage = {
  fromAgentId: string
  fromAgentName: string
  content: string
}

export type SubagentInbox = {
  push(message: QueuedSubagentMessage): boolean
  take(): QueuedSubagentMessage | undefined
  close(): void
}

export type SubagentInstance = {
  agentId: string
  agentName: string
  agentDefinition: AgentDefinition
  toolUseContext: ToolUseContext
  abortController: AbortController
  modelConfig: SubagentModelConfig
  spawnedAt: number
  status: SubagentStatus
  verbosity: Verbosity
  mode: SpawnMode
  inbox: SubagentInbox
  done: Promise<void>
  result: Promise<unknown[]>
  eventWindowStartedAt: number
  eventWindowCount: number
  rateLimitWarningSent: boolean
}

export type SubagentSummary = {
  agentId: string
  agentName: string
  agentType: string
  modelConfig: SubagentModelConfig
  spawnedAt: number
  status: SubagentStatus
  verbosity: Verbosity
  mode: SpawnMode
}

export type SubagentHandle = {
  agentId: string
  agentName: string
  done: Promise<void>
  result: Promise<unknown[]>
  benchmarks?: Benchmarks
}

export function createSubagentInbox(): SubagentInbox {
  const messages: QueuedSubagentMessage[] = []
  let closed = false

  return {
    push(message) {
      if (closed) return false
      messages.push(message)
      return true
    },
    take() {
      return messages.shift()
    },
    close() {
      closed = true
      messages.length = 0
    },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function mapSubagentQueryMessage(
  message: unknown,
  agentId: string,
  agentName: string,
): SupervisorEvent[] {
  const messageRecord = record(message)
  if (!messageRecord) return []

  if (messageRecord.type === 'stream_event') {
    const event = record(messageRecord.event)
    if (!event) return []

    if (event.type === 'content_block_delta') {
      const delta = record(event.delta)
      const text = stringValue(delta?.text) ?? stringValue(delta?.thinking)
      return delta && text
        ? [
            {
              type: 'subagent_token_delta',
              agentId,
              agentName,
              delta: text,
            },
          ]
        : []
    }

    if (event.type === 'content_block_start') {
      const block = record(event.content_block)
      if (block?.type !== 'tool_use') return []
      return [
        {
          type: 'subagent_tool_call',
          agentId,
          agentName,
          tool: stringValue(block.name) ?? 'unknown',
          params: record(block.input) ?? {},
        },
      ]
    }

    return []
  }

  if (messageRecord.type === 'assistant') {
    const assistant = record(messageRecord.message)
    const content = Array.isArray(assistant?.content) ? assistant.content : []
    return [
      {
        type: 'subagent_assistant_message',
        agentId,
        agentName,
        content,
      },
    ]
  }

  if (messageRecord.type === 'user') {
    const user = record(messageRecord.message)
    const content = Array.isArray(user?.content) ? user.content : []
    return content.flatMap(blockValue => {
      const block = record(blockValue)
      if (block?.type !== 'tool_result') return []
      return [
        {
          type: 'subagent_tool_result' as const,
          agentId,
          agentName,
          tool:
            stringValue(block.tool_name) ??
            stringValue(block.name) ??
            stringValue(block.tool_use_id) ??
            'unknown',
          result: block.content,
          isError: block.is_error === true,
        },
      ]
    })
  }

  return []
}
