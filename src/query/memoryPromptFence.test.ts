import { afterEach, expect, mock, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  buildMemoryPrompt,
  configureMemoryPromptV2Transport,
  configureMemoryPromptV2BindingProvider,
  createMemoryPromptSnapshot,
  createMemoryPromptTransportQueue,
  hasRegisteredMemoryPrompt,
  registerMemoryPromptSnapshot,
  registerMemoryPromptSystemPrompt,
} from '../memdir/memdir.js'
import { PromptFence } from '../services/memoryV2/promptFence.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import { query } from '../query.js'
import type { Message } from '../types/message.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

const gates = { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true } as const
const testMemoryDir = `${join(tmpdir(), 'neocode-memory-prompt-fence')}${sep}`

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'query-memory-user',
    timestamp: new Date().toISOString(),
  }
}

function toolUseContext() {
  const abortController = new AbortController()
  return {
    abortController,
    agentId: undefined,
    contentReplacementState: undefined,
    options: {
      agentDefinitions: { activeAgents: [] },
      allowedAgentTypes: undefined,
      appendSystemPrompt: undefined,
      isNonInteractiveSession: false,
      mainLoopModel: 'claude-sonnet-4',
      mcpClients: [],
      providerOverride: undefined,
      thinkingConfig: undefined,
      tools: [],
    },
    readFileState: {},
    getAppState: () => ({
      fastMode: false,
      effortValue: undefined,
      advisorModel: undefined,
      mainLoopModel: 'claude-sonnet-4',
      mainLoopModelForSession: undefined,
      mcp: { tools: [], clients: [] },
      toolPermissionContext: { mode: 'default' },
    }),
    setInProgressToolUseIDs: () => {},
  } as never
}

async function drain<T, TReturn>(generator: AsyncGenerator<T, TReturn>): Promise<TReturn> {
  while (true) {
    const next = await generator.next()
    if (next.done) return next.value
  }
}

function registerPrompt() {
  const fence = new PromptFence({ gates })
  const binding = {
    fence,
    projectScopeId: 'project-a',
    storeGeneration: 0n,
    promptEpoch: 0n,
    records: [{ id: 'MEMORY.md', projectScopeId: 'project-a', content: '- query memory\n' }],
    maxPromptCharacters: 20_000,
    maxPromptTokens: 4_000,
  } as const
  const snapshot = createMemoryPromptSnapshot({ ...binding })
  const text = buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir: testMemoryDir,
    v2: binding,
    v2Snapshot: snapshot,
  })
  const registeredText = registerMemoryPromptSnapshot({ binding, snapshot, text })
  const systemPrompt = registerMemoryPromptSystemPrompt(asSystemPrompt([registeredText]))
  return { fence, text: registeredText, systemPrompt }
}

function deps(seen: string[], callCount: { value: number }) {
  return {
    callModel: mock(async function* ({ systemPrompt }: { systemPrompt: readonly string[] }) {
      callCount.value += 1
      seen.push(...systemPrompt)
      yield {
        type: 'assistant' as const,
        message: { id: 'assistant-query-memory', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
        uuid: 'assistant-query-memory',
        timestamp: new Date().toISOString(),
      }
    }),
    microcompact: mock(async (input: Message[]) => ({ messages: input })),
    autocompact: mock(async () => ({ wasCompacted: false })),
    uuid: () => 'query-memory-request',
  } as never
}

afterEach(() => {
  configureMemoryPromptV2BindingProvider(null)
  configureMemoryPromptV2Transport(null)
})

test('query sends the committed immutable memory payload through the model handoff', async () => {
  const { fence, text, systemPrompt } = registerPrompt()
  const startupQueue = createMemoryPromptTransportQueue()
  configureMemoryPromptV2Transport(startupQueue)
  const seen: string[] = []
  const callCount = { value: 0 }

  await drain(query({
    messages: [userMessage('hello')],
    systemPrompt: asSystemPrompt(systemPrompt),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    toolUseContext: toolUseContext(),
    querySource: 'repl_main_thread',
    maxTurns: 1,
    deps: deps(seen, callCount),
  }))

  expect(callCount.value).toBe(1)
  expect(startupQueue.pendingCount()).toBe(0)
  expect(seen).toContain(text)
  const preForgetRequestIds = fence.getPreForgetRequests()
  expect(preForgetRequestIds).toHaveLength(1)
  expect(fence.getRequest(preForgetRequestIds[0]!).state).toBe('SENT')
})

test('query reuses the committed envelope across fallback after forget', async () => {
  const { fence, text, systemPrompt } = registerPrompt()
  const startupQueue = createMemoryPromptTransportQueue()
  configureMemoryPromptV2Transport(startupQueue)
  const seen: string[][] = []
  let callCount = 0
  const callModel = mock((input: { systemPrompt: readonly string[] }) => {
    callCount += 1
    seen.push([...input.systemPrompt])
    if (callCount === 1) {
      return (async function* () {
        throw new FallbackTriggeredError('claude-sonnet-4', 'claude-haiku-4')
      })()
    }
    fence.forgetMemory('MEMORY.md', 'project-a')
    return (async function* () {
      yield {
        type: 'assistant' as const,
        message: { id: 'assistant-query-memory-retry', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
        uuid: 'assistant-query-memory-retry',
        timestamp: new Date().toISOString(),
      }
    })()
  })

  await drain(query({
    messages: [userMessage('hello')],
    systemPrompt: asSystemPrompt(systemPrompt),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    toolUseContext: toolUseContext(),
    fallbackModel: 'claude-haiku-4',
    querySource: 'repl_main_thread',
    maxTurns: 1,
    deps: {
      callModel,
      microcompact: mock(async (input: Message[]) => ({ messages: input })),
      autocompact: mock(async () => ({ wasCompacted: false })),
      uuid: () => 'query-memory-retry',
    } as never,
  }))

  expect(callCount).toBe(2)
  expect(seen[0]).toContain(text)
  expect(seen[1]).toContain(text)
  expect(startupQueue.pendingCount()).toBe(0)
  const preForgetRequestIds = fence.getPreForgetRequests()
  expect(preForgetRequestIds).toHaveLength(1)
  expect(fence.getRequest(preForgetRequestIds[0]!).state).toBe('SENT')
})

test('query leaves a committed prompt unsent when the transport fails before first advancement', async () => {
  const { fence, systemPrompt } = registerPrompt()
  configureMemoryPromptV2Transport(createMemoryPromptTransportQueue())
  const callModel = mock(() => (async function* () {
    throw new Error('transport failed before first response')
  })())

  await drain(query({
    messages: [userMessage('hello')],
    systemPrompt: asSystemPrompt(systemPrompt),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    toolUseContext: toolUseContext(),
    querySource: 'repl_main_thread',
    maxTurns: 1,
    deps: {
      callModel,
      microcompact: mock(async (input: Message[]) => ({ messages: input })),
      autocompact: mock(async () => ({ wasCompacted: false })),
      uuid: () => 'query-memory-transport-error',
    } as never,
  }))

  const preForgetRequestIds = fence.getPreForgetRequests()
  expect(preForgetRequestIds).toHaveLength(1)
  expect(fence.getRequest(preForgetRequestIds[0]!).state).toBe('SEND_COMMITTED')
})

test('query refuses a revoked memory snapshot before model handoff', async () => {
  const { fence, systemPrompt } = registerPrompt()
  let queueCalls = 0
  configureMemoryPromptV2Transport({
    enqueue: () => {
      queueCalls += 1
      throw new Error('revoked memory reached transport')
    },
  })
  fence.forgetMemory('MEMORY.md', 'project-a')
  const callCount = { value: 0 }

  await drain(query({
    messages: [userMessage('hello')],
    systemPrompt: asSystemPrompt(systemPrompt),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    toolUseContext: toolUseContext(),
    querySource: 'repl_main_thread',
    maxTurns: 1,
    deps: deps([], callCount),
  }))

  expect(callCount.value).toBe(0)
  expect(queueCalls).toBe(0)
})

test('production system prompt assembly preserves the fenced memory identity', async () => {
  const previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  const globals = globalThis as Record<string, unknown>
  const hadMacro = Object.hasOwn(globals, 'MACRO')
  const previousMacro = globals.MACRO
  globals.MACRO = { ISSUES_EXPLAINER: 'report issues' }
  const { clearSystemPromptSections } = await import('../constants/systemPromptSections.js')
  const { getSystemPrompt } = await import('../constants/prompts.js')
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = testMemoryDir
  const current = registerPrompt()
  configureMemoryPromptV2Transport(createMemoryPromptTransportQueue())
  configureMemoryPromptV2BindingProvider(() => ({
    fence: current.fence,
    projectScopeId: 'project-a',
    storeGeneration: 0n,
    promptEpoch: 0n,
    records: [{ id: 'MEMORY.md', projectScopeId: 'project-a', content: '- query memory\n' }],
    maxPromptCharacters: 20_000,
    maxPromptTokens: 4_000,
  }))
  try {
    clearSystemPromptSections()
    const systemPrompt = asSystemPrompt(await getSystemPrompt([], 'claude-sonnet-4'))
    expect(hasRegisteredMemoryPrompt(systemPrompt)).toBe(true)
    expect(hasRegisteredMemoryPrompt(asSystemPrompt([...systemPrompt]))).toBe(false)
  } finally {
    clearSystemPromptSections()
    if (previousOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
    if (hadMacro) globals.MACRO = previousMacro
    else delete globals.MACRO
  }
})
