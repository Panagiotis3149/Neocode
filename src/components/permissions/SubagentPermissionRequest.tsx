import React, { useMemo } from 'react'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { SubagentSupervisor } from '../../tools/AgentTool/subagentSupervisor.js'
import type { SupervisorEvent } from '../../tools/AgentTool/subagentEventBus.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { PermissionRequest } from './PermissionRequest.js'

type PermissionEvent = Extract<SupervisorEvent, { type: 'subagent_permission_request' }>

export function SubagentPermissionRequest({
  event,
  supervisor,
  toolUseContext,
}: {
  event: PermissionEvent
  supervisor: SubagentSupervisor
  toolUseContext: ToolUseContext
}): React.ReactNode {
  const tool = useMemo(() => ({
    name: event.tool,
    userFacingName: () => event.tool,
    renderToolUseMessage: () => JSON.stringify(event.params),
  }) as unknown as Tool, [event.params, event.tool])

  const toolUseConfirm = useMemo(() => ({
    assistantMessage: { message: { id: event.requestId } },
    tool,
    description: `[Subagent: ${event.agentName}] requests permission to use ${event.tool}`,
    input: event.params,
    toolUseContext,
    toolUseID: event.requestId,
    permissionResult: {
      behavior: 'ask',
      message: `Subagent ${event.agentName} is waiting for permission`,
    },
    onUserInteraction: () => {},
    onAbort: () => supervisor.resolvePermission(event.requestId, {
      behavior: 'deny',
      message: 'User aborted',
    }),
    onAllow: async (updatedInput: Record<string, unknown>) => {
      supervisor.resolvePermission(event.requestId, {
        behavior: 'allow',
        updatedInput,
      })
    },
    onReject: (feedback?: string) => supervisor.resolvePermission(event.requestId, {
      behavior: 'deny',
      message: feedback ?? 'User denied permission',
    }),
    recheckPermission: async () => {},
  }) as unknown as ToolUseConfirm, [event, supervisor, tool, toolUseContext])

  return <PermissionRequest
    toolUseConfirm={toolUseConfirm}
    toolUseContext={toolUseContext}
    onDone={() => {}}
    onReject={() => {}}
    verbose={true}
    workerBadge={undefined}
  />
}
