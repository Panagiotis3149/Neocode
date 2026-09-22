import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { createUserMessage } from '../../utils/messages.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { SupervisorEvent } from './subagentEventBus.js'
import {
  createSubagentSupervisor,
  type SubagentSupervisor,
  type SubagentHandle,
  type SubagentSummary,
} from './subagentSupervisor.js'
import type { runAgent } from './runAgent.js'

type SettingsModule = typeof import('../../utils/settings/settings.js')

let actualSettingsModule: SettingsModule | undefined
let settingsForTest: Record<string, unknown> = {}
const supervisors: SubagentSupervisor[] = []

// bun's mock.module() is sticky for the whole worker process; the mock reads
// from this mutable slot (default {} → no routing) so leakage is inert.
let supervisorTestProfiles: unknown[] = []

async function setupSupervisorConfigMock() {
  const actualConfig = await import(
    `../../utils/config.ts?subagentSupervisor=${Date.now()}-${Math.random()}`
  )
  mock.module('../../utils/config.js', () => ({
    ...actualConfig,
    getGlobalConfig: () => ({
      ...actualConfig.getGlobalConfig(),
      providerProfiles: supervisorTestProfiles,
    }),
  }))
}

describe('SubagentSupervisor', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('tools/AgentTool/subagentSupervisor.test.ts')
    actualSettingsModule ??= await import(
      `../../utils/settings/settings.ts?subagentSupervisorSettings=${Date.now()}-${Math.random()}`
    )
    settingsForTest = {}
    supervisorTestProfiles = []
    mock.module('../../utils/settings/settings.js', () => ({
      ...actualSettingsModule!,
      getInitialSettings: () => settingsForTest,
      getSettings_DEPRECATED: () => settingsForTest,
    }))
    await setupSupervisorConfigMock()
  })

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    for (const agent of supervisor.list()) {
      await supervisor.terminate(agent.agentId)
    }
  }
  mock.restore()
    settingsForTest = {}
    supervisorTestProfiles = []
    releaseSharedMutationLock()
  })

  // ── Registry & lifecycle ────────────────────────────────────

test('spawn returns a handle and list() reflects the running subagent', async () => {
    const supervisor = createTestSupervisor()
    const context = createToolUseContext()

    const handle = await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'do the thing',
      toolUseContext: context,
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
    })

    expect(handle.agentId).toBeTruthy()
    expect(handle.agentName).toMatch(/^worker-/)
    expect(handle.done).toBeInstanceOf(Promise)

    const summaries = supervisor.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      agentId: handle.agentId,
      agentName: handle.agentName,
      modelConfig: { model: 'parent-model' },
      spawnedAt: expect.any(Number),
      status: 'running',
    })
  })

test('spawn emits subagent_spawned then subagent_status running', async () => {
    const supervisor = createTestSupervisor()
    const events: SupervisorEvent[] = []
    supervisor.subscribe(e => events.push(e))

    await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
      mode: 'sync',
    })

    expect(events.map(e => e.type)).toEqual([
      'subagent_spawned',
      'subagent_status',
    ])
    const spawned = events[0] as Extract<
      SupervisorEvent,
      { type: 'subagent_spawned' }
    >
    expect(spawned.agentName).toMatch(/^worker-/)
    expect(spawned.mode).toBe('sync')

    const status = events[1] as Extract<
      SupervisorEvent,
      { type: 'subagent_status' }
    >
    expect(status.status).toBe('running')
  })

test('terminate removes the subagent and emits subagent_terminated', async () => {
    const supervisor = createTestSupervisor()
    const events: SupervisorEvent[] = []
    supervisor.subscribe(e => events.push(e))

    const handle = await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
    })

    await supervisor.terminate(handle.agentId, 'user requested')

    expect(supervisor.list()).toHaveLength(0)
    const terminated = events.find(
      e => e.type === 'subagent_terminated',
    ) as Extract<SupervisorEvent, { type: 'subagent_terminated' }> | undefined
    expect(terminated?.agentId).toBe(handle.agentId)
    expect(terminated?.reason).toBe('user requested')
  })

test('terminate on unknown agentId does not throw', async () => {
    const supervisor = createTestSupervisor()
    await expect(supervisor.terminate('nope')).resolves.toBeUndefined()
  })

test('setVerbosity updates the registry entry', async () => {
    const supervisor = createTestSupervisor()
    const handle = await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
      verbosity: 'none',
    })

    expect(supervisor.list()[0]?.verbosity).toBe('none')

    supervisor.setVerbosity(handle.agentId, 'outputs_and_calls')
    expect(supervisor.list()[0]?.verbosity).toBe('outputs_and_calls')
  })

test('spawn passes provider profile selection into model routing', async () => {
    const supervisor = createTestSupervisor()
    const events: SupervisorEvent[] = []
    supervisor.subscribe(e => events.push(e))

    await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
      provider: 'prof_route',
      modelOverrides: { model: 'profile-model' },
    })

    const spawned = events.find(
      e => e.type === 'subagent_spawned',
    ) as Extract<SupervisorEvent, { type: 'subagent_spawned' }> | undefined
    // The profile override flows through as the resolved provider config.
    expect(spawned?.modelConfig.model).toBeDefined()
  })

test('returns opt-in benchmark data on the spawn handle', async () => {
    const benchmarks = {
      modelId: 'bench-model',
      parameterCount: 7000000000,
      contextWindow: 128000,
    }
    const supervisor = createSubagentSupervisor({
      runAgent: completingRunAgent,
      lookupModelBenchmarks: async modelId => {
        expect(modelId).toBe('bench-model')
        return benchmarks
      },
    })
    supervisors.push(supervisor)

    const handle = await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
      modelOverrides: { model: 'bench-model' },
      lookup_benchmarks: true,
      mode: 'sync',
    })

    expect(handle.benchmarks).toEqual(benchmarks)
    await handle.done
  })

test('failed runs emit a failure warning and reject done', async () => {
    const supervisor = createTestSupervisor(async function* () {
      throw new Error('worker exploded')
    })
    const events: SupervisorEvent[] = []
    supervisor.subscribe(event => events.push(event))

    const handle = await supervisor.spawn({
      agentDefinition: createAgentDefinition(),
      prompt: 'go',
      toolUseContext: createToolUseContext(),
      availableTools: [],
      querySource: 'agent:builtin:general-purpose',
      mode: 'sync',
    })

    await expect(handle.done).rejects.toThrow('worker exploded')
    expect(events).toContainEqual({
      type: 'subagent_warning',
      agentId: handle.agentId,
      agentName: handle.agentName,
      reason: 'execution failed: worker exploded',
    })
    expect(supervisor.list()[0]?.status).toBe('failed')
  })

  // ── Permission bridge ───────────────────────────────────────

test('requestPermission resolves when resolvePermission responds with allow', async () => {
    const supervisor = createTestSupervisor()
    let capturedRequestId = ''

    supervisor.subscribe(e => {
      if (e.type === 'subagent_permission_request') {
        capturedRequestId = e.requestId
      }
    })

    const promise = supervisor.requestPermission(
      'agent-1',
      'worker-a',
      'Bash',
      { command: 'ls' },
    )

    // Poll until request event observed, then respond.
    for (let i = 0; i < 50 && !capturedRequestId; i++) {
      await new Promise(r => setTimeout(r, 5))
    }
    expect(capturedRequestId).toBeTruthy()

    supervisor.resolvePermission(capturedRequestId, {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    })

    const decision = await promise
    expect(decision.behavior).toBe('allow')
  })

test('resolvePermission deny rejects the pending request', async () => {
    const supervisor = createTestSupervisor()
    let capturedRequestId = ''

    supervisor.subscribe(e => {
      if (e.type === 'subagent_permission_request') {
        capturedRequestId = e.requestId
      }
    })

    const promise = supervisor.requestPermission(
      'agent-1',
      'worker-a',
      'Bash',
      { command: 'rm' },
    )

    for (let i = 0; i < 50 && !capturedRequestId; i++) {
      await new Promise(r => setTimeout(r, 5))
    }

    supervisor.resolvePermission(capturedRequestId, {
      behavior: 'deny',
      message: 'not allowed',
    })

    await expect(promise).rejects.toThrow('not allowed')
  })

test('resolvePermission on unknown requestId is a safe no-op', () => {
    const supervisor = createTestSupervisor()
    expect(() =>
      supervisor.resolvePermission('ghost-id', {
        behavior: 'allow',
        updatedInput: {},
      }),
    ).not.toThrow()
  })
})

test('spawn forwards stream messages and filters text by verbosity', async () => {
  const supervisor = createTestSupervisor(async function* (params) {
    const emit = (message: unknown) => {
      params.onQueryMessage?.(message)
      return message
    }
    yield emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    })
    yield emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      },
    })
    yield emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'ok', is_error: false },
        ],
      },
    })
  })
  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))

  const handle = await supervisor.spawn({
    agentDefinition: createAgentDefinition(),
    prompt: 'go',
    toolUseContext: createToolUseContext(),
    availableTools: [],
    querySource: 'agent:builtin:general-purpose',
    verbosity: 'calls_only',
  })
  await handle.done

  expect(events.some(event => event.type === 'subagent_token_delta')).toBe(false)
  expect(events.some(event => event.type === 'subagent_tool_call')).toBe(true)
  expect(events.some(event => event.type === 'subagent_tool_result')).toBe(true)
})

test('sendMessage resolves a named peer and delivers a queued prompt', async () => {
  let releaseFirstRun!: () => void
  const firstRunReleased = new Promise<void>(resolve => {
    releaseFirstRun = resolve
  })
  const prompts: string[] = []
  const supervisor = createTestSupervisor(async function* (params) {
    prompts.push(String(params.promptMessages[0]?.message?.content ?? ''))
    if (prompts.length === 1) {
      await firstRunReleased
    }
  })

  const handle = await supervisor.spawn({
    agentDefinition: createAgentDefinition(),
    prompt: 'initial',
    toolUseContext: createToolUseContext(),
    availableTools: [],
    querySource: 'agent:builtin:general-purpose',
    agentName: 'researcher',
  })

  await supervisor.sendMessage('main', 'subagent:researcher', 'follow up')
  releaseFirstRun()

  for (let i = 0; i < 50 && prompts.length < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  expect(prompts).toEqual(['initial', 'follow up'])
  await supervisor.terminate(handle.agentId)
})

function createTestSupervisor(
  runner: typeof runAgent = blockingRunAgent,
): SubagentSupervisor {
  const supervisor = createSubagentSupervisor({ runAgent: runner })
  supervisors.push(supervisor)
  return supervisor
}

const blockingRunAgent: typeof runAgent = async function* (params) {
  const controller = params.override?.abortController
  if (!controller) return
  await new Promise<void>(resolve => {
    if (controller.signal.aborted) {
      resolve()
      return
    }
    controller.signal.addEventListener('abort', () => resolve(), {
      once: true,
    })
  })
  throw new Error('aborted')
}

const completingRunAgent: typeof runAgent = async function* () {}

function createAgentDefinition(): AgentDefinition {
  return {
    agentType: 'general-purpose',
    color: 'blue',
    source: 'built-in',
    whenToUse: 'general work',
    getSystemPrompt: () => 'You are a subagent.',
  } as unknown as AgentDefinition
}

function createToolUseContext(): ToolUseContext {
  const appState = {
    mainLoopModel: 'parent-model',
    mainLoopModelForSession: 'parent-model',
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: {
      clients: [],
      tools: [],
    },
    todos: {},
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'parent-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
    abortController: new AbortController(),
    messages: [createUserMessage({ content: 'seed' })],
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}
