import React from 'react'
import { Box, Text } from '../ink.js'
import type { SupervisorEvent } from '../tools/AgentTool/subagentEventBus.js'

function compact(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 180 ? `${text.slice(0, 177)}...` : text
  } catch {
    return String(value)
  }
}

function textContent(content: unknown[]): string {
  const text = content.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string'
      ? [record.text]
      : []
  }).join('')
  return text || compact(content)
}

function eventAgentId(event: SupervisorEvent): string {
  return event.type === 'subagent_message' ? event.fromAgentId : event.agentId
}

function EventLine({ event }: { event: SupervisorEvent }): React.ReactNode {
  switch (event.type) {
    case 'subagent_spawned':
      return <Text dimColor>[Subagent: {event.agentName}] started ({event.modelConfig.model})</Text>
    case 'subagent_status':
      return <Text dimColor>[Subagent: {event.agentName}] {event.status}</Text>
    case 'subagent_token_delta':
      return <Text><Text color="cyan">[Subagent: {event.agentName}]</Text> {event.delta}</Text>
    case 'subagent_assistant_message':
      return <Text><Text color="cyan">[Subagent: {event.agentName}]</Text> {textContent(event.content)}</Text>
    case 'subagent_tool_call':
      return <Text><Text color="cyan">[Subagent: {event.agentName}]</Text> {event.tool}({compact(event.params)})</Text>
    case 'subagent_tool_result':
      return <Text><Text color="cyan">[Subagent: {event.agentName}]</Text> {event.tool} → {compact(event.result)}{event.isError ? ' [error]' : ''}</Text>
    case 'subagent_permission_request':
      return <Text color="yellow"><Text color="cyan">[Subagent: {event.agentName}]</Text> permission requested for {event.tool}</Text>
    case 'subagent_permission_response':
      return <Text dimColor><Text color="cyan">[Subagent: {event.agentName}]</Text> permission {event.decision}{event.reason ? `: ${event.reason}` : ''}</Text>
    case 'subagent_message':
      return <Text><Text color="cyan">[Subagent: {event.fromAgentName}]</Text> → {event.toAgentName}: {event.content}{event.status === 'failed' ? ` (${event.reason ?? 'failed'})` : ''}</Text>
    case 'subagent_terminated':
      return <Text color="yellow"><Text color="cyan">[Subagent: {event.agentName}]</Text> terminated{event.reason ? `: ${event.reason}` : ''}</Text>
    case 'subagent_warning':
      return <Text color="yellow"><Text color="cyan">[Subagent: {event.agentName}]</Text> {event.reason}</Text>
  }
}

export function SubagentEventStream({ events }: { events: SupervisorEvent[] }): React.ReactNode {
  if (events.length === 0) return null

  return (
    <Box flexDirection="column" width="100%">
      {events.map((event, index) => <Box key={`${event.type}-${eventAgentId(event)}-${index}`}><EventLine event={event} /></Box>)}
    </Box>
  )
}
