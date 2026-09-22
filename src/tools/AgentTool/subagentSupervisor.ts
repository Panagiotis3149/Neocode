import { randomUUID } from 'crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { QuerySource } from '../../constants/querySource.js'
import { createUserMessage } from '../../utils/messages.js'
import { asAgentId } from '../../types/ids.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import {
  resolveAgentProviderProfile,
  type ProviderOverride,
} from '../../services/api/agentRouting.js'
import {
  lookupModelBenchmarks as lookupModelBenchmarksImpl,
  type Benchmarks,
} from '../../utils/model/benchmarkRegistry.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import {
  createSubagentEventBus,
  type SubagentEventBus,
  type SupervisorEvent,
  type SupervisorEventListener,
  type Verbosity,
  type SpawnMode,
} from './subagentEventBus.js'
import {
  createSubagentInbox,
  mapSubagentQueryMessage,
  type SubagentHandle,
  type SubagentInstance,
  type SubagentModelOverrides,
  type SubagentSummary,
} from './subagentInstance.js'
import { runAgent } from './runAgent.js'

type RunAgent = typeof runAgent

export type { SubagentHandle, SubagentModelOverrides, SubagentSummary }

export type SubagentSpawnParams = {
  agentDefinition: AgentDefinition
  prompt: string
  toolUseContext: ToolUseContext
  availableTools: import('../../Tool.js').Tools
  querySource: QuerySource
  runAgentParams?: Parameters<RunAgent>[0]
  agentName?: string
  modelOverrides?: SubagentModelOverrides
  provider?: string
  verbosity?: Verbosity
  mode?: SpawnMode
  allowedTools?: string[]
  canUseTool?: CanUseToolFn
  lookup_benchmarks?: boolean
}

export type SubagentSupervisorOptions = {
  runAgent?: RunAgent
  lookupModelBenchmarks?: (
    modelId: string,
  ) => Promise<Benchmarks | null>
  permissionTimeoutMs?: number
  maxEventsPerSecond?: number
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
    }

type PendingPermission = {
  agentId: string
  agentName: string
  timer: ReturnType<typeof setTimeout>
  resolve: (decision: PermissionDecision) => void
  reject: (reason: Error) => void
}

export interface SubagentSupervisor {
  readonly events: SubagentEventBus
  subscribe(
    listener: SupervisorEventListener,
    filter?: (event: SupervisorEvent) => boolean,
  ): () => void
  spawn(params: SubagentSpawnParams): Promise<SubagentHandle>
  terminate(agentId: string, reason?: string): Promise<void>
  list(): SubagentSummary[]
  sendMessage(
    fromAgentId: string,
    toAgent: string,
    content: string,
  ): Promise<void>
  setVerbosity(agentId: string, verbosity: Verbosity): void
  requestPermission(
    agentId: string,
    agentName: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<PermissionDecision>
  resolvePermission(requestId: string, decision: PermissionDecision): void
  lookupModelBenchmarks(modelId: string): Promise<Benchmarks | null>
}

function summarize(instance: SubagentInstance): SubagentSummary {
  return {
    agentId: instance.agentId,
    agentName: instance.agentName,
    agentType: instance.agentDefinition.agentType,
    modelConfig: instance.modelConfig,
    spawnedAt: instance.spawnedAt,
    status: instance.status,
    verbosity: instance.verbosity,
    mode: instance.mode,
  }
}

function isTextEvent(event: SupervisorEvent): boolean {
  return (
    event.type === 'subagent_token_delta' ||
    event.type === 'subagent_assistant_message'
  )
}

function isCallEvent(event: SupervisorEvent): boolean {
  return (
    event.type === 'subagent_tool_call' ||
    event.type === 'subagent_tool_result'
  )
}

function shouldForward(event: SupervisorEvent, verbosity: Verbosity): boolean {
  if (isTextEvent(event)) return verbosity === 'outputs_and_calls'
  if (isCallEvent(event)) return verbosity !== 'none'
  return true
}

function agentNameFor(
  requestedName: string | undefined,
  agentDefinition: AgentDefinition,
  registry: Map<string, SubagentInstance>,
): string {
  const name = requestedName?.trim()
  if (name) return name
  if (agentDefinition.agentType !== 'general-purpose') {
    return agentDefinition.agentType
  }
  return `worker-${registry.size + 1}`
}

function providerOverrideFor(
  selector: string | undefined,
): ProviderOverride | undefined {
  if (!selector?.trim()) return undefined
  return resolveAgentProviderProfile({ provider: selector }) ?? undefined
}

export function createSubagentSupervisor(
  options: SubagentSupervisorOptions = {},
): SubagentSupervisor {
  const bus = createSubagentEventBus()
  const registry = new Map<string, SubagentInstance>()
  const pendingPermissions = new Map<string, PendingPermission>()
  const executeRunAgent = options.runAgent ?? runAgent
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 60_000
  const maxEventsPerSecond = options.maxEventsPerSecond ?? 10_000
  const lookupBenchmarks =
    options.lookupModelBenchmarks ?? lookupModelBenchmarksImpl

  function publish(event: SupervisorEvent): void {
    bus.publish(event)
  }

  function publishForInstance(
    instance: SubagentInstance,
    event: SupervisorEvent,
  ): void {
    if (!shouldForward(event, instance.verbosity)) return

    const now = Date.now()
    if (now - instance.eventWindowStartedAt >= 1000) {
      instance.eventWindowStartedAt = now
      instance.eventWindowCount = 0
      instance.rateLimitWarningSent = false
    }

    if (isTextEvent(event) || isCallEvent(event)) {
      if (instance.eventWindowCount >= maxEventsPerSecond) {
        if (!instance.rateLimitWarningSent) {
          instance.rateLimitWarningSent = true
          publish({
            type: 'subagent_warning',
            agentId: instance.agentId,
            agentName: instance.agentName,
            reason: `event rate exceeded ${maxEventsPerSecond}/sec`,
          })
        }
        return
      }
      instance.eventWindowCount += 1
    }

    publish(event)
  }

  function requestPermission(
    agentId: string,
    agentName: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const requestId = randomUUID()

    const promise = new Promise<PermissionDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingPermissions.get(requestId)
        if (!pending) return
        pendingPermissions.delete(requestId)
        publish({
          type: 'subagent_permission_response',
          agentId: pending.agentId,
          agentName: pending.agentName,
          requestId,
          decision: 'deny',
          reason: 'timeout',
        })
        pending.reject(new Error('Permission request timed out'))
      }, permissionTimeoutMs)

      pendingPermissions.set(requestId, {
        agentId,
        agentName,
        timer,
        resolve,
        reject,
      })
    })

    publish({
      type: 'subagent_permission_request',
      agentId,
      agentName,
      tool,
      params,
      requestId,
    })

    return promise
  }

  function resolvePermission(
    requestId: string,
    decision: PermissionDecision,
  ): void {
    const pending = pendingPermissions.get(requestId)
    if (!pending) return
    pendingPermissions.delete(requestId)
    clearTimeout(pending.timer)

    publish({
      type: 'subagent_permission_response',
      agentId: pending.agentId,
      agentName: pending.agentName,
      requestId,
      decision: decision.behavior,
      reason: decision.behavior === 'deny' ? decision.message : undefined,
    })

    if (decision.behavior === 'allow') {
      pending.resolve(decision)
    } else {
      pending.reject(new Error(decision.message))
    }
  }

  async function sendMessage(
    fromAgentId: string,
    toAgent: string,
    content: string,
  ): Promise<void> {
    const from = registry.get(fromAgentId)
    const fromAgentName = from?.agentName ?? 'main'

    if (toAgent === 'main') {
      publish({
        type: 'subagent_message',
        fromAgentId,
        fromAgentName,
        toAgentId: 'main',
        toAgentName: 'main',
        content,
        status: 'delivered',
      })
      return
    }

    const selector = toAgent.startsWith('subagent:')
      ? toAgent.slice('subagent:'.length)
      : toAgent
    const target =
      registry.get(selector) ??
      [...registry.values()].find(
        instance => instance.agentName.toLowerCase() === selector.toLowerCase(),
      )

    if (!target || target.status !== 'running') {
      publish({
        type: 'subagent_message',
        fromAgentId,
        fromAgentName,
        toAgentId: target?.agentId ?? selector,
        toAgentName: target?.agentName ?? selector,
        content,
        status: 'failed',
        reason: 'not_found',
      })
      throw new Error(`Subagent '${toAgent}' is not active`)
    }

    if (
      !target.inbox.push({
        fromAgentId,
        fromAgentName,
        content,
      })
    ) {
      throw new Error(`Subagent '${toAgent}' is not accepting messages`)
    }

    publish({
      type: 'subagent_message',
      fromAgentId,
      fromAgentName,
      toAgentId: target.agentId,
      toAgentName: target.agentName,
      content,
      status: 'delivered',
    })
  }

  async function spawn(
    params: SubagentSpawnParams,
  ): Promise<SubagentHandle> {
    const verbosity = params.verbosity ?? 'calls_only'
    const mode = params.mode ?? 'async'
    const agentName = agentNameFor(
      params.agentName,
      params.agentDefinition,
      registry,
    )

    if (
      [...registry.values()].some(
        instance =>
          instance.status === 'running' &&
          instance.agentName.toLowerCase() === agentName.toLowerCase(),
      )
    ) {
      throw new Error(`Subagent name '${agentName}' is already active`)
    }

    const agentId = randomUUID()
    const abortController = new AbortController()
    const modelOverrides = params.modelOverrides ?? {}
    const baseParams = params.runAgentParams
    const inheritedModel =
      baseParams?.model ?? params.toolUseContext.options.mainLoopModel
    const providerSelector = modelOverrides.provider ?? params.provider
    const resolvedProviderOverride = providerOverrideFor(providerSelector)
    const effectiveModel =
      modelOverrides.model ?? resolvedProviderOverride?.model ?? inheritedModel

    let resolveDone!: () => void
    let rejectDone!: (reason: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    let resolveResult!: (messages: unknown[]) => void
    const result = new Promise<unknown[]>(resolve => {
      resolveResult = resolve
    })

    const spawnedAt = Date.now()
    const modelConfig = {
      model: effectiveModel,
      ...(providerSelector ? { provider: providerSelector } : {}),
      ...(modelOverrides.temperature !== undefined
        ? { temperature: modelOverrides.temperature }
        : {}),
      ...(modelOverrides.reasoning_effort
        ? { reasoning_effort: modelOverrides.reasoning_effort }
        : {}),
      ...(resolvedProviderOverride
        ? {
            providerOverride: {
              model: resolvedProviderOverride.model,
              baseURL: resolvedProviderOverride.baseURL,
            },
          }
        : {}),
    }

    const instance: SubagentInstance = {
      agentId,
      agentName,
      agentDefinition: params.agentDefinition,
      toolUseContext: params.toolUseContext,
      abortController,
      modelConfig,
      spawnedAt,
      status: 'running',
      verbosity,
      mode,
      inbox: createSubagentInbox(),
      done,
      result,
      eventWindowStartedAt: Date.now(),
      eventWindowCount: 0,
      rateLimitWarningSent: false,
    }
    registry.set(agentId, instance)

    if (providerSelector && !resolvedProviderOverride) {
      publish({
        type: 'subagent_warning',
        agentId,
        agentName,
        reason: `provider profile '${providerSelector}' not found; using inherited routing`,
      })
    }

    let benchmarks: Benchmarks | undefined
    if (params.lookup_benchmarks) {
      try {
        benchmarks = (await lookupBenchmarks(effectiveModel)) ?? undefined
      } catch {
        publish({
          type: 'subagent_warning',
          agentId,
          agentName,
          reason: `benchmark lookup failed for ${effectiveModel}`,
        })
      }
    }

    publish({
      type: 'subagent_spawned',
      agentId,
      agentName,
      modelConfig,
      verbosity,
      mode,
    })
    publish({
      type: 'subagent_status',
      agentId,
      agentName,
      status: 'running',
    })

    const defaultCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
    ) => {
      try {
        const permission = await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseId,
        )
        if (permission.behavior === 'allow') {
          return {
            behavior: 'allow' as const,
            updatedInput: permission.updatedInput ?? input,
          }
        }
        if (permission.behavior === 'deny') {
          return {
            behavior: 'deny' as const,
            message: permission.message,
            decisionReason: permission.decisionReason,
          }
        }
        return await requestPermission(
          agentId,
          agentName,
          tool.name,
          input,
        ).then(decision => decision.behavior === 'allow'
          ? {
              behavior: 'allow' as const,
              updatedInput: decision.updatedInput,
            }
          : {
              behavior: 'deny' as const,
              message: decision.message,
              decisionReason: {
                type: 'other' as const,
                reason: decision.message,
              },
            })
      } catch (error) {
        return {
          behavior: 'deny' as const,
          message: error instanceof Error ? error.message : String(error),
          decisionReason: {
            type: 'other' as const,
            reason: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }

    void (async () => {
      const messages: unknown[] = []
      let nextPrompt = params.prompt
      let firstRun = true
      let conversationContext: unknown[] = []

      try {
        while (!abortController.signal.aborted) {
          const promptMessages = firstRun
            ? baseParams?.promptMessages ?? [createUserMessage({ content: nextPrompt })]
            : [createUserMessage({ content: nextPrompt })]
          const runMessages: unknown[] = []
          const runParams: Parameters<RunAgent>[0] = {
            ...(baseParams ?? {}),
            agentDefinition: params.agentDefinition,
            promptMessages,
            ...(firstRun ? {} : { forkContextMessages: conversationContext as never }),
            toolUseContext: params.toolUseContext,
            availableTools: baseParams?.availableTools ?? params.availableTools,
            querySource: baseParams?.querySource ?? params.querySource,
            canUseTool: params.canUseTool ?? defaultCanUseTool,
            canShowPermissionPrompts: true,
            isAsync: mode === 'async',
            override: {
              ...baseParams?.override,
              agentId: asAgentId(agentId),
              abortController,
            },
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(providerSelector ? { provider: providerSelector } : {}),
            ...(modelOverrides.temperature !== undefined
              ? { temperatureOverride: modelOverrides.temperature }
              : {}),
            ...(modelOverrides.reasoning_effort
              ? { effortValue: modelOverrides.reasoning_effort }
              : {}),
            subagentRuntime: {
              supervisor: {
                sendMessage,
              },
              agentId,
              agentName,
            },
            onQueryMessage: message => {
              for (const event of mapSubagentQueryMessage(
                message,
                agentId,
                agentName,
              )) {
                publishForInstance(instance, event)
              }
            },
          }

          for await (const message of executeRunAgent(runParams)) {
            messages.push(message)
            runMessages.push(message)
          }

          conversationContext = [
            ...(firstRun
              ? baseParams?.forkContextMessages ?? []
              : conversationContext),
            ...promptMessages,
            ...runMessages,
          ]

          firstRun = false
          const queued = instance.inbox.take()
          if (!queued) break
          nextPrompt = queued.content
        }

        if (!abortController.signal.aborted) {
          instance.status = 'done'
          publish({
            type: 'subagent_status',
            agentId,
            agentName,
            status: 'done',
          })
        }
        resolveResult(messages)
        resolveDone()
      } catch (error) {
        if (abortController.signal.aborted) {
          resolveResult(messages)
          resolveDone()
          return
        }
        instance.status = 'failed'
        publish({
          type: 'subagent_warning',
          agentId,
          agentName,
          reason: `execution failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        publish({
          type: 'subagent_status',
          agentId,
          agentName,
          status: 'failed',
        })
        resolveResult(messages)
        rejectDone(error)
      }
    })()

    done.catch(() => {})
    return { agentId, agentName, done, result, benchmarks }
  }

  return {
    events: bus,
    subscribe(listener, filter) {
      return bus.subscribe(listener, filter)
    },
    spawn,
    async terminate(agentId, reason) {
      const instance = registry.get(agentId)
      if (!instance) return

      instance.abortController.abort()
      instance.inbox.close()
      registry.delete(agentId)

      for (const [requestId, pending] of pendingPermissions) {
        if (pending.agentId !== agentId) continue
        clearTimeout(pending.timer)
        pendingPermissions.delete(requestId)
        pending.reject(new Error(reason ?? 'Subagent terminated'))
      }

      publish({
        type: 'subagent_terminated',
        agentId,
        agentName: instance.agentName,
        reason,
      })

      await instance.done.catch(() => {})
    },
    list() {
      return [...registry.values()].map(summarize)
    },
    sendMessage,
    setVerbosity(agentId, verbosity) {
      const instance = registry.get(agentId)
      if (instance) instance.verbosity = verbosity
    },
    requestPermission,
    resolvePermission,
    lookupModelBenchmarks: lookupBenchmarks,
  }
}
