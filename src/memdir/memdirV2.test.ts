import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildMemoryPrompt,
  buildMemoryPromptForTransport,
  commitRegisteredMemoryPrompt,
  configureMemoryPromptV2BindingProvider,
  configureMemoryPromptV2Transport,
  createMemoryPromptTransportQueue,
  createMemoryPromptSnapshot,
  hasRegisteredMemoryPrompt,
  invalidateMemoryPromptRegistrations,
  loadMemoryPrompt,
  registerMemoryPromptSnapshot,
  registerMemoryPromptSystemPrompt,
} from './memdir.js'
import { PromptFence } from '../services/memoryV2/promptFence.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

const gates = { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true } as const

function binding(content: string) {
  return {
    fence: new PromptFence({ gates }),
    projectScopeId: 'project-a',
    storeGeneration: 0n,
    promptEpoch: 0n,
    records: [{ id: 'MEMORY.md', projectScopeId: 'project-a', content }],
    maxPromptCharacters: 20_000,
    maxPromptTokens: 4_000,
  } as const
}

describe('memory V2 prompt binding', () => {
  const directories: string[] = []

  afterEach(() => {
    configureMemoryPromptV2BindingProvider(null)
    configureMemoryPromptV2Transport(null)
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test('does not expose an unfenced V2 prompt string', () => {
    expect(() => buildMemoryPrompt({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      v2: binding('- frozen snapshot entry'),
    })).toThrow()
  })

  test('returns a transport-committed envelope for a frozen V2 prompt', () => {
    const current = binding('- frozen snapshot entry')
    const result = buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      v2: current,
      transport: {
        enqueue: (payload, requestId) => Object.freeze({ accepted: true, requestId, payload }),
      },
    })

    expect(result.text).toContain('- frozen snapshot entry')
    expect(result.request.state).toBe('SEND_COMMITTED')
    expect(result.receipt.payload).toBe(result.request.payload)
  })

  test('uses the configured V2 provider for the production build path', () => {
    configureMemoryPromptV2BindingProvider(() => binding('- provider snapshot entry'))

    expect(() => buildMemoryPrompt({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
    })).toThrow()

    const result = buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      transport: {
        enqueue: (payload, requestId) => Object.freeze({ accepted: true, requestId, payload }),
      },
    })
    expect(result.text).toContain('- provider snapshot entry')
  })

  test('commits a registered production snapshot at the API handoff', () => {
    const current = binding('- handoff snapshot entry')
    const snapshot = createMemoryPromptSnapshot({
      fence: current.fence,
      projectScopeId: current.projectScopeId,
      storeGeneration: current.storeGeneration,
      promptEpoch: current.promptEpoch,
      records: current.records,
      maxPromptCharacters: current.maxPromptCharacters,
      maxPromptTokens: current.maxPromptTokens,
    })
    const text = buildMemoryPrompt({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      v2: current,
      v2Snapshot: snapshot,
    })
    let enqueued = 0
    configureMemoryPromptV2Transport({
      enqueue: (payload, requestId) => {
        enqueued += 1
        return Object.freeze({ accepted: true, requestId, payload })
      },
    })
    const registeredText = registerMemoryPromptSnapshot({ binding: current, snapshot, text })

    const committed = commitRegisteredMemoryPrompt(
      registerMemoryPromptSystemPrompt(asSystemPrompt([registeredText])),
    )

    expect(committed?.request.state).toBe('SEND_COMMITTED')
    expect(committed?.receipt.payload).toBe(text)
    expect(enqueued).toBe(1)
    expect(() => commitRegisteredMemoryPrompt(asSystemPrompt([text]))).toThrow()
  })

  test('forget before API handoff prevents enqueueing the revoked snapshot', () => {
    const current = binding('- revoked handoff entry')
    const snapshot = createMemoryPromptSnapshot({
      fence: current.fence,
      projectScopeId: current.projectScopeId,
      storeGeneration: current.storeGeneration,
      promptEpoch: current.promptEpoch,
      records: current.records,
      maxPromptCharacters: current.maxPromptCharacters,
      maxPromptTokens: current.maxPromptTokens,
    })
    const text = buildMemoryPrompt({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      v2: current,
      v2Snapshot: snapshot,
    })
    let enqueued = 0
    configureMemoryPromptV2Transport({
      enqueue: () => {
        enqueued += 1
        return null
      },
    })
    const registeredText = registerMemoryPromptSnapshot({ binding: current, snapshot, text })
    const systemPrompt = registerMemoryPromptSystemPrompt(asSystemPrompt([registeredText]))
    current.fence.forgetMemory('MEMORY.md', 'project-a')
    invalidateMemoryPromptRegistrations('MEMORY.md', 'project-a')

    expect(hasRegisteredMemoryPrompt(systemPrompt)).toBe(false)
    expect(() =>
      commitRegisteredMemoryPrompt(
        systemPrompt,
      ),
    ).toThrow()
    expect(enqueued).toBe(0)
  })

  test('forget after send commit preserves the owned receipt for the model handoff', () => {
    const current = binding('- committed handoff entry')
    const queue = createMemoryPromptTransportQueue()
    const committed = buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/path-that-must-not-be-read/',
      v2: current,
      transport: queue,
    })

    current.fence.forgetMemory('MEMORY.md', 'project-a')

    expect(committed.request.state).toBe('SEND_COMMITTED')
    expect(queue.consume(committed.receipt)).toBe(committed.request.payload)
    expect(queue.pendingCount()).toBe(0)
    queue.close()
  })

  test('the production memory loader registers a snapshot for the query handoff', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-loader-'))
    directories.push(directory)
    writeFileSync(join(directory, 'MEMORY.md'), '- loader memory entry\n', 'utf8')
    const memoryDir = `${directory}/`
    const current = binding('- loader memory entry')
    const previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
    configureMemoryPromptV2BindingProvider(() => ({ ...current, records: [{ id: 'MEMORY.md', projectScopeId: 'project-a', content: '- loader memory entry\n' }] }))
    configureMemoryPromptV2Transport(createMemoryPromptTransportQueue())

    try {
      const text = await loadMemoryPrompt()
      expect(text).toContain('- loader memory entry')
      const systemPrompt = registerMemoryPromptSystemPrompt(asSystemPrompt([text!]))
      expect(hasRegisteredMemoryPrompt(systemPrompt)).toBe(true)
      expect(hasRegisteredMemoryPrompt(asSystemPrompt([text!]))).toBe(false)
    } finally {
      if (previousOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
    }
  })

  test('transport queue retains and consumes immutable ownership receipts exactly once', () => {
    const queue = createMemoryPromptTransportQueue()
    const payload = Object.freeze({ prompt: 'memory payload' })
    const receipt = queue.enqueue(payload, 'request-1')
    if (!receipt) throw new Error('queue rejected test payload')

    expect(queue.pendingCount()).toBe(1)
    expect(queue.consume(receipt)).toBe(payload)
    expect(queue.pendingCount()).toBe(0)
    expect(() => queue.consume(receipt)).toThrow()
  })

  test('transport queue fails closed for forged receipts and releases bounded ownership', () => {
    const queue = createMemoryPromptTransportQueue()
    const receipt = queue.enqueue('memory payload', 'request-1')
    if (!receipt) throw new Error('queue rejected test payload')

    expect(() => queue.consume({ ...receipt, payload: 'forged payload' })).toThrow()
    expect(queue.pendingCount()).toBe(1)
    queue.release(receipt)
    expect(queue.pendingCount()).toBe(0)
    expect(() => queue.release(receipt)).toThrow()

    const receipts: Array<NonNullable<ReturnType<typeof queue.enqueue>>> = []
    for (let index = 0; index < 32; index += 1) {
      const next = queue.enqueue(`payload-${index}`, `request-${index}`)
      if (!next) throw new Error('queue rejected bounded payload')
      receipts.push(next)
    }
    expect(queue.enqueue('overflow', 'overflow')).toBeNull()
    queue.release(receipts[0]!)
    const replacement = queue.enqueue('replacement', 'replacement')
    expect(replacement).not.toBeNull()
    for (const ownedReceipt of receipts.slice(1)) queue.release(ownedReceipt)
    if (!replacement) throw new Error('queue rejected replacement payload')
    queue.release(replacement)
    queue.release(queue.enqueue('replacement-2', 'replacement-2')!)
    queue.close()
    expect(queue.enqueue('closed', 'closed')).toBeNull()
  })

  test('registration eviction removes old prompt payloads', () => {
    const current = binding('- bounded registration')
    const snapshot = createMemoryPromptSnapshot({ ...current })
    let firstPrompt: readonly string[] = asSystemPrompt([])
    for (let index = 0; index < 129; index += 1) {
      const text = buildMemoryPrompt({
        displayName: 'Persistent Agent Memory',
        memoryDir: 'C:/path-that-must-not-be-read/',
        extraGuidelines: [`registration-${index}`],
        v2: current,
        v2Snapshot: snapshot,
      })
      registerMemoryPromptSnapshot({ binding: current, snapshot, text })
      const systemPrompt = registerMemoryPromptSystemPrompt(asSystemPrompt([text]))
      if (index === 0) firstPrompt = systemPrompt
    }

    expect(hasRegisteredMemoryPrompt(firstPrompt)).toBe(false)
  })
})
