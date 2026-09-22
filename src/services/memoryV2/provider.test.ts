import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  MemoryProviderContractError,
  NamespaceEpochFence,
  ProviderOutbox,
  ProviderRequestRegistry,
  ProviderRevisionTracker,
  ProviderSequenceHighwater,
  assertProviderCapabilities,
  acceptProviderResponse,
  type MemoryProviderCapabilities,
  type ProviderDurableOutboxEntry,
  type ProviderRequest,
  type ProviderDurability,
} from './provider.js'
import { MemoryV2Store } from './store.js'

const capabilities: MemoryProviderCapabilities = {
  stableEntryIds: true,
  monotonicRevisions: true,
  idempotentUpsert: true,
  idempotentDelete: true,
  durableTombstones: true,
  echoesScopeAndNamespaceEpoch: true,
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    providerId: 'provider-a',
    projectScopeId: 'project-a',
    providerNamespaceId: 'namespace-a',
    namespaceEpoch: 4n,
    operationSequence: 7n,
    requestId: 'request-a',
    operation: 'upsert',
    entryId: 'entry-a',
    revision: 3n,
    payload: 'memory',
    ...overrides,
  }
}

function createDurability(): ProviderDurability {
  const sequences = new Map<string, { sequence: bigint; requestId: string }>()
  const hashes = new Map<string, string>()
  const entries = new Map<string, ProviderDurableOutboxEntry>()
  return {
    readSequenceHighwater: scopeKey => sequences.get(scopeKey)?.sequence,
    readCompletedRequestHash: requestKey => hashes.get(requestKey),
    commitCompletion: (scopeKey, operationSequence, requestKey, requestHash) => {
      const existingHash = hashes.get(requestKey)
      if (existingHash && existingHash !== requestHash) throw new Error('request reuse')
      const existingSequence = sequences.get(scopeKey)
      if (existingSequence && operationSequence < existingSequence.sequence) throw new Error('sequence reuse')
      if (existingSequence && operationSequence === existingSequence.sequence && existingSequence.requestId !== requestKey) throw new Error('sequence reuse')
      sequences.set(scopeKey, { sequence: operationSequence, requestId: requestKey })
      hashes.set(requestKey, requestHash)
      entries.delete(requestKey)
    },
    readOutboxEntries: () => [...entries.values()],
    putOutboxEntry: entry => {
      const key = `${entry.request.providerId}\u0000${entry.request.projectScopeId}\u0000${entry.request.providerNamespaceId}\u0000${entry.request.requestId}`
      const existing = entries.get(key)
      if (existing && existing.requestHash !== entry.requestHash) throw new Error('request reuse')
      if (!existing) entries.set(key, entry)
    },
    setOutboxState: (requestKey, state) => {
      const entry = entries.get(requestKey)
      if (!entry) throw new Error('missing outbox entry')
      entries.set(requestKey, { ...entry, state })
    },
  }
}

function createOutbox(highwater = new ProviderSequenceHighwater(createDurability())): ProviderOutbox {
  return new ProviderOutbox(highwater)
}

describe('Memory V2 provider contract', () => {
  test('requires stable identity and revisions for automatic synchronization', () => {
    expect(() => assertProviderCapabilities(capabilities)).not.toThrow()
    expect(() => assertProviderCapabilities({ ...capabilities, stableEntryIds: false })).toThrow(MemoryProviderContractError)
    expect(() => assertProviderCapabilities({ ...capabilities, monotonicRevisions: false })).toThrow()
  })

  test('rejects late responses from an old namespace epoch', () => {
    const fence = new NamespaceEpochFence(4n)
    const current = request()
    const registry = new ProviderRequestRegistry()
    registry.register(current)
    expect(acceptProviderResponse(current, { ...current, namespaceEpoch: 4n }, fence, registry)).toBe(true)
    fence.advance()
    const next = request({ requestId: 'request-next', namespaceEpoch: 5n })
    registry.register(next)
    expect(() => acceptProviderResponse(next, { ...next, namespaceEpoch: 4n }, fence, registry)).toThrow()
    expect(acceptProviderResponse(next, { ...next, namespaceEpoch: 5n }, fence, registry)).toBe(true)
  })

  test('requires matching provider scope, request identity, and operation sequence', () => {
    const fence = new NamespaceEpochFence(4n)
    const current = request()
    const registry = new ProviderRequestRegistry()
    registry.register(current)
    expect(() => acceptProviderResponse(current, { ...current, projectScopeId: 'project-b' }, fence, registry)).toThrow()
    expect(() => acceptProviderResponse(current, { ...current, requestId: 'request-b' }, fence, registry)).toThrow()
    expect(() => acceptProviderResponse(current, { ...current, operationSequence: 8n }, fence, registry)).toThrow()
  })

  test('outbox preserves sequence and deduplicates request IDs', () => {
    const outbox = createOutbox()
    outbox.enqueue(request({ requestId: 'request-a', operationSequence: 7n }))
    expect(() => outbox.enqueue(request({ requestId: 'request-a', operationSequence: 7n }))).not.toThrow()
    expect(() => outbox.enqueue(request({ requestId: 'request-a', operationSequence: 8n }))).toThrow()
    expect(outbox.claim()?.operationSequence).toBe(7n)
    outbox.ack('request-a')
    expect(outbox.size()).toBe(0)
  })

  test('outbox scopes uniqueness and ordering by provider, project, and namespace', () => {
    const outbox = createOutbox()
    const firstScope = request({ requestId: 'same-id', operationSequence: 1n })
    const secondScope = request({ requestId: 'same-id', projectScopeId: 'project-b', operationSequence: 1n })
    outbox.enqueue(firstScope)
    outbox.enqueue(secondScope)
    expect(outbox.claim()?.projectScopeId).toBe('project-a')
    outbox.ack(firstScope)
    expect(outbox.claim()?.projectScopeId).toBe('project-b')
    outbox.ack(secondScope)
    expect(outbox.size()).toBe(0)
  })

  test('same operation sequence is independent across provider namespaces', () => {
    const outbox = createOutbox()
    const firstNamespace = request({ requestId: 'namespace-a', operationSequence: 1n })
    const secondNamespace = request({ requestId: 'namespace-b', providerNamespaceId: 'namespace-b', operationSequence: 1n })
    outbox.enqueue(firstNamespace)
    outbox.enqueue(secondNamespace)
    expect(outbox.claim()?.providerNamespaceId).toBe('namespace-a')
    outbox.ack(firstNamespace)
    expect(outbox.claim()?.providerNamespaceId).toBe('namespace-b')
    outbox.ack(secondNamespace)
  })

  test('automatic mirroring rejects an outbox without authoritative durability', () => {
    expect(() => new ProviderOutbox().requireDurable()).toThrow(MemoryProviderContractError)
    expect(() => new ProviderOutbox(new ProviderSequenceHighwater())).toThrow(MemoryProviderContractError)
  })

  test('retirement makes late responses unavailable before consumers can cache or log them', () => {
    const registry = new ProviderRequestRegistry()
    const current = request()
    registry.register(current)
    const fence = new NamespaceEpochFence(4n)
    expect(registry.accept(current, { ...current }, fence)).toBe(true)
    expect(registry.state(current.requestId)).toBe('succeeded')
    expect(() => registry.accept(current, { ...current }, fence)).toThrow()
  })

  test('requires the response revision to equal the live request revision', () => {
    const registry = new ProviderRequestRegistry()
    const current = request({ revision: 9n })
    registry.register(current)
    expect(() => registry.accept(current, { ...current, revision: 8n }, new NamespaceEpochFence(4n))).toThrow()
    expect(registry.state(current.requestId)).toBe('pending')
  })

  test('claims immutable requests in sequence and retries the claimed item without reordering', () => {
    const outbox = createOutbox()
    const first = request({ requestId: 'request-1', operationSequence: 1n })
    const second = request({ requestId: 'request-2', operationSequence: 2n })
    outbox.enqueue(second)
    outbox.enqueue(first)
    const claimed = outbox.claim()
    expect(claimed?.requestId).toBe('request-1')
    expect(() => {
      if (claimed) (claimed as { operationSequence: bigint }).operationSequence = 99n
    }).toThrow()
    outbox.retry('request-1')
    expect(outbox.claim()?.requestId).toBe('request-1')
    outbox.ack('request-1')
    expect(outbox.claim()?.requestId).toBe('request-2')
  })

  test('rejects revisions that move backwards for one provider entry', () => {
    const tracker = new ProviderRevisionTracker()
    tracker.observe(request({ revision: 4n }))
    expect(() => tracker.observe(request({ revision: 3n }))).toThrow(MemoryProviderContractError)
    expect(() => tracker.observe(request({ revision: 4n, requestId: 'request-b' }))).not.toThrow()
    expect(() => tracker.observe(request({ revision: 5n }))).not.toThrow()
  })

  test('does not reuse completed operation sequences across outbox instances', () => {
    const highwater = new ProviderSequenceHighwater(createDurability())
    const firstOutbox = new ProviderOutbox(highwater)
    firstOutbox.enqueue(request({ requestId: 'request-1', operationSequence: 11n }))
    const claimed = firstOutbox.claim()
    expect(claimed?.operationSequence).toBe(11n)
    firstOutbox.ack('request-1')
    const secondOutbox = new ProviderOutbox(highwater)
    expect(() => secondOutbox.enqueue(request({ requestId: 'request-2', operationSequence: 11n }))).toThrow()
    expect(() => secondOutbox.enqueue(request({ requestId: 'request-1', operationSequence: 11n }))).not.toThrow()
  })

  test('durable completion permits sequence one independently in another project scope', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-provider-independent-scope-'))
    const dbPath = join(directory, 'memory-v2.db')
    const store = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    try {
      await store.init()
      const firstOutbox = new ProviderOutbox(new ProviderSequenceHighwater(store.providerDurability()))
      const first = request({ requestId: 'same-request-id', operationSequence: 1n })
      firstOutbox.enqueue(first)
      firstOutbox.claim()
      firstOutbox.ack(first)

      const secondOutbox = new ProviderOutbox(new ProviderSequenceHighwater(store.providerDurability()))
      const second = request({ requestId: 'same-request-id', projectScopeId: 'project-b', operationSequence: 1n })
      secondOutbox.enqueue(second)
      expect(secondOutbox.claim()?.projectScopeId).toBe('project-b')
      secondOutbox.ack(second)
    } finally {
      store.close()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true })
          break
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
        }
      }
    }
  })

  test('requires the live registry for public response acceptance', () => {
    const current = request()
    const fence = new NamespaceEpochFence(4n)
    const unsafeAccept = acceptProviderResponse as unknown as (request: ProviderRequest, response: ProviderRequest, fence: NamespaceEpochFence) => true
    expect(() => unsafeAccept(current, { ...current }, fence)).toThrow()
  })

  test('durable provider high-water and request identity survive a store restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-provider-durable-'))
    const dbPath = join(directory, 'memory-v2.db')
    const firstStore = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    const secondStore = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    try {
      await firstStore.init()
      const firstOutbox = new ProviderOutbox(new ProviderSequenceHighwater(firstStore.providerDurability()))
      const completed = request({ requestId: 'durable-request', operationSequence: 11n })
      firstOutbox.enqueue(completed)
      expect(firstOutbox.claim()?.requestId).toBe('durable-request')
      firstOutbox.ack('durable-request')
      firstStore.close()

      await secondStore.init()
      const secondOutbox = new ProviderOutbox(new ProviderSequenceHighwater(secondStore.providerDurability()))
      expect(() => secondOutbox.enqueue(request({ requestId: 'reused-sequence', operationSequence: 11n }))).toThrow()
      expect(() => secondOutbox.enqueue({ ...completed, payload: 'altered' })).toThrow()
      expect(() => secondOutbox.enqueue({ ...completed, operationSequence: 12n })).toThrow()
    } finally {
      firstStore.close()
      secondStore.close()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true })
          break
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
        }
      }
    }
  })

  test('claimed provider work survives restart and is replayed before completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-provider-outbox-recovery-'))
    const dbPath = join(directory, 'memory-v2.db')
    const firstStore = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    const secondStore = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    try {
      await firstStore.init()
      const firstOutbox = new ProviderOutbox(new ProviderSequenceHighwater(firstStore.providerDurability()))
      const pending = request({ requestId: 'crash-request', operationSequence: 21n })
      firstOutbox.enqueue(pending)
      expect(firstOutbox.claim()?.requestId).toBe('crash-request')
      firstStore.close()

      await secondStore.init()
      const recovered = new ProviderOutbox(new ProviderSequenceHighwater(secondStore.providerDurability()))
      expect(recovered.claim()?.requestId).toBe('crash-request')
      recovered.ack('crash-request')
      expect(recovered.size()).toBe(0)
    } finally {
      firstStore.close()
      secondStore.close()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true })
          break
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
        }
      }
    }
  })
})
