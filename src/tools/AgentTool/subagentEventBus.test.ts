import { describe, expect, test } from 'bun:test'
import type { SupervisorEvent } from './subagentEventBus.js'
import {
  createSubagentEventBus,
  type Unsubscribe,
} from './subagentEventBus.js'

function makeSpawnedEvent(agentId = 'agent-1'): SupervisorEvent {
  return {
    type: 'subagent_spawned',
    agentId,
    agentName: 'worker-a',
    modelConfig: { model: 'deepseek-chat' },
    verbosity: 'outputs_and_calls',
    mode: 'sync',
  }
}

describe('createSubagentEventBus', () => {
  test('publish delivers event to every subscriber', () => {
    const bus = createSubagentEventBus()
    const receivedA: SupervisorEvent[] = []
    const receivedB: SupervisorEvent[] = []

    bus.subscribe(e => receivedA.push(e))
    const unsubB = bus.subscribe(e => receivedB.push(e))

    const event = makeSpawnedEvent()
    bus.publish(event)

    expect(receivedA).toEqual([event])
    expect(receivedB).toEqual([event])

    unsubB()
  })

  test('unsubscribe stops delivery for that subscriber only', () => {
    const bus = createSubagentEventBus()
    const received: SupervisorEvent[] = []

    const unsub = bus.subscribe(e => received.push(e))

    unsub()
    bus.publish(makeSpawnedEvent())

    expect(received).toEqual([])
  })

  test('unsubscribe is idempotent', () => {
    const bus = createSubagentEventBus()
    const received: SupervisorEvent[] = []
    const unsub: Unsubscribe = bus.subscribe(e => received.push(e))

    expect(() => {
      unsub()
      unsub()
      unsub()
    }).not.toThrow()

    bus.publish(makeSpawnedEvent())
    expect(received).toEqual([])
  })

  test('subscriber filter receives events matching the filter and drops others', () => {
    const bus = createSubagentEventBus()
    const received: SupervisorEvent[] = []

    bus.subscribe(
      e => received.push(e),
      event => event.type === 'subagent_status',
    )

    bus.publish(makeSpawnedEvent()) // spawned → filtered out
    bus.publish({
      type: 'subagent_status',
      agentId: 'agent-1',
      agentName: 'worker-a',
      status: 'running',
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('subagent_status')
  })

  test('filter is idempotent: same filter applied once, not per publish mutation', () => {
    const bus = createSubagentEventBus()
    let callCount = 0
    const received: SupervisorEvent[] = []

    bus.subscribe(
      e => received.push(e),
      event => {
        callCount++
        return event.type === 'subagent_message'
      },
    )

    bus.publish(makeSpawnedEvent())
    bus.publish({
      type: 'subagent_message',
      fromAgentId: 'a',
      fromAgentName: 'worker-a',
      toAgentId: 'main',
      toAgentName: 'main',
      content: 'hello',
    })

    // Filter runs exactly once per published event (2 publishes → 2 calls).
    expect(callCount).toBe(2)
    expect(received).toHaveLength(1)
  })

  test('listener throwing does not prevent other subscribers from receiving the event', () => {
    const bus = createSubagentEventBus()
    const received: SupervisorEvent[] = []

    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe(e => received.push(e))

    const event = makeSpawnedEvent()
    expect(() => bus.publish(event)).not.toThrow()
    expect(received).toEqual([event])
  })

  test('covers full SupervisorEvent union shapes without runtime error', () => {
    const bus = createSubagentEventBus()
    const received: SupervisorEvent[] = []
    bus.subscribe(e => received.push(e))

    const events: SupervisorEvent[] = [
      makeSpawnedEvent(),
      {
        type: 'subagent_status',
        agentId: 'a1',
        agentName: 'w',
        status: 'paused',
      },
      {
        type: 'subagent_token_delta',
        agentId: 'a1',
        agentName: 'w',
        delta: 'tok',
      },
      {
        type: 'subagent_assistant_message',
        agentId: 'a1',
        agentName: 'w',
        content: [{ type: 'text', text: 'hi' }],
      },
      {
        type: 'subagent_tool_call',
        agentId: 'a1',
        agentName: 'w',
        tool: 'Bash',
        params: { command: 'ls' },
      },
      {
        type: 'subagent_tool_result',
        agentId: 'a1',
        agentName: 'w',
        tool: 'Bash',
        result: 'file.txt',
        isError: false,
      },
      {
        type: 'subagent_permission_request',
        agentId: 'a1',
        agentName: 'w',
        tool: 'Bash',
        params: { command: 'rm' },
        requestId: 'req-1',
      },
      {
        type: 'subagent_permission_response',
        agentId: 'a1',
        agentName: 'w',
        requestId: 'req-1',
        decision: 'allow',
        reason: 'ok',
      },
      {
        type: 'subagent_message',
        fromAgentId: 'a1',
        fromAgentName: 'w',
        toAgentId: 'main',
        toAgentName: 'main',
        content: 'msg',
      },
      {
        type: 'subagent_terminated',
        agentId: 'a1',
        agentName: 'w',
        reason: 'user requested',
      },
    ]

    for (const e of events) bus.publish(e)
    expect(received).toEqual(events)
  })
})
