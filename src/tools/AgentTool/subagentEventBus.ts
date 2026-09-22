/**
 * In-memory typed pub/sub bus for SubagentSupervisor events.
 *
 * The supervisor publishes lifecycle, streaming, permission, and messaging
 * events here; subscribers (REPL renderer, permission UI) filter by type.
 * See docs/superpowers/specs/2026-08-10-subagents-v2-design.md §3.
 */

/** Verbosity level controlling which streaming events a subagent emits. */
export type Verbosity = 'outputs_and_calls' | 'calls_only' | 'none'

/** Spawn mode: supervisor awaits completion (sync) or returns immediately (async). */
export type SpawnMode = 'sync' | 'async'

/** Resolved model configuration carried on spawn events. */
export interface SubagentModelConfig {
  model: string
  temperature?: number
  reasoning_effort?: 'low' | 'medium' | 'high'
  provider?: string
  providerOverride?: {
    model: string
    baseURL: string
  }
}

/** Typed event union emitted by the SubagentSupervisor. */
export type SupervisorEvent =
  | {
      type: 'subagent_spawned'
      agentId: string
      agentName: string
      modelConfig: SubagentModelConfig
      verbosity: Verbosity
      mode: SpawnMode
    }
  | {
      type: 'subagent_status'
      agentId: string
      agentName: string
      status: 'running' | 'paused' | 'done' | 'failed'
    }
  | {
      type: 'subagent_token_delta'
      agentId: string
      agentName: string
      delta: string
    }
  | {
      type: 'subagent_assistant_message'
      agentId: string
      agentName: string
      content: unknown[]
    }
  | {
      type: 'subagent_tool_call'
      agentId: string
      agentName: string
      tool: string
      params: Record<string, unknown>
    }
  | {
      type: 'subagent_tool_result'
      agentId: string
      agentName: string
      tool: string
      result: unknown
      isError: boolean
    }
  | {
      type: 'subagent_permission_request'
      agentId: string
      agentName: string
      tool: string
      params: Record<string, unknown>
      requestId: string
    }
  | {
      type: 'subagent_permission_response'
      agentId: string
      agentName: string
      requestId: string
      decision: 'allow' | 'deny'
      reason?: string
    }
  | {
      type: 'subagent_message'
      fromAgentId: string
      fromAgentName: string
      toAgentId: string
      toAgentName: string
      content: string
      status?: 'delivered' | 'failed'
      reason?: string
    }
  | {
      type: 'subagent_terminated'
      agentId: string
      agentName: string
      reason?: string
    }
  | {
      type: 'subagent_warning'
      agentId: string
      agentName: string
      reason: string
    }

export type SupervisorEventListener = (event: SupervisorEvent) => void

/** Optional predicate applied before delivery to a subscriber's listener. */
export type SupervisorEventFilter = (
  event: SupervisorEvent,
) => boolean

export type Unsubscribe = () => void

interface Subscription {
  listener: SupervisorEventListener
  filter?: SupervisorEventFilter
  active: boolean
}

export interface SubagentEventBus {
  subscribe(
    listener: SupervisorEventListener,
    filter?: SupervisorEventFilter,
  ): Unsubscribe
  publish(event: SupervisorEvent): void
}

/**
 * Create an isolated event bus instance. The supervisor owns one per session;
 * tests create their own to avoid cross-suite leakage.
 */
export function createSubagentEventBus(): SubagentEventBus {
  const subscriptions = new Set<Subscription>()

  return {
    subscribe(listener, filter) {
      const subscription: Subscription = {
        listener,
        filter,
        active: true,
      }
      subscriptions.add(subscription)
      return () => {
        // Idempotent unsubscribe: repeat calls are no-ops.
        subscription.active = false
        subscriptions.delete(subscription)
      }
    },

    publish(event) {
      for (const subscription of [...subscriptions]) {
        if (!subscription.active) continue
        try {
          if (subscription.filter && !subscription.filter(event)) continue
          subscription.listener(event)
        } catch {
          // A misbehaving subscriber must not break other subscribers or the
          // publisher.
        }
      }
    },
  }
}
