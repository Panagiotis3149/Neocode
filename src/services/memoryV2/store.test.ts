import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AsyncTransactionError,
  MemoryV2DisabledError,
  MemoryV2Store,
  MemoryBudgetError,
  MemoryConflictError,
  RequestReuseError,
  SecretMemoryError,
  type MemoryMutation,
} from './store.js'

describe('MemoryV2Store', () => {
  const directories: string[] = []
  const stores: MemoryV2Store[] = []

  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const directory of directories.splice(0)) {
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

  function createStore(options: ConstructorParameters<typeof MemoryV2Store>[0] = {}) {
    const store = new MemoryV2Store({ gates: { MEMORY_STORE_V2: true }, dbPath: ':memory:', ...options })
    stores.push(store)
    return store
  }

  type CreateMutation = Extract<MemoryMutation, { operation: 'create' }>

  function createMutation(
    overrides: Partial<Omit<CreateMutation, 'record'>> & { record?: Partial<CreateMutation['record']> } = {},
  ): CreateMutation {
    return {
      requestId: 'request-1',
      operation: 'create',
      ...overrides,
      record: {
        id: 'memory-1',
        projectScopeId: 'project-a',
        type: 'user',
        name: 'Preference',
        content: 'Use concise explanations.',
        pinned: false,
        ...overrides.record,
      },
    }
  }

  it('replays an identical request without creating a second mutation', async () => {
    const store = createStore()
    await store.init()
    const mutation = createMutation()
    const first = await store.mutate(mutation)
    const second = await store.mutate({ ...mutation })

    expect(second.requestHash).toBe(first.requestHash)
    expect(second.record).toEqual({
      id: first.record.id,
      projectScopeId: first.record.projectScopeId,
      version: first.record.version,
      status: first.record.status,
    })
    expect(second.replayed).toBe(true)
    expect((await store.list({ projectScopeId: 'project-a' })).map(record => record.id)).toEqual(['memory-1'])
  })

  it('rejects reuse of a request id with an altered request hash', async () => {
    const store = createStore()
    await store.init()
    await store.mutate(createMutation())
    await expect(
      store.mutate(createMutation({ record: { ...createMutation().record, content: 'A different request.' } })),
    ).rejects.toBeInstanceOf(RequestReuseError)
  })

  it('rejects writes that exceed aggregate record or character budgets', async () => {
    const store = createStore({ maxRecords: 1, maxTotalCharacters: 15 })
    await store.init()
    await expect(
      store.mutate(createMutation({ record: { ...createMutation().record, content: 'too long' } })),
    ).rejects.toBeInstanceOf(MemoryBudgetError)
    const short = createMutation({ record: { ...createMutation().record, content: 'x' } })
    await store.mutate(short)
    await expect(
      store.mutate({ ...short, requestId: 'request-2', record: { ...short.record, id: 'memory-2', content: 'more' } }),
    ).rejects.toBeInstanceOf(MemoryBudgetError)
  })

  it('tombstones records and suppresses them from active retrieval', async () => {
    const store = createStore()
    await store.init()
    await store.mutate(createMutation())
    const deleted = await store.mutate({
      requestId: 'request-2',
      operation: 'delete',
      recordId: 'memory-1',
      projectScopeId: 'project-a',
      expectedVersion: 1,
    })

    expect(deleted.record.status).toBe('tombstoned')
    expect(await store.get('memory-1', 'project-a')).toBeNull()
    expect(await store.list({ projectScopeId: 'project-a' })).toEqual([])
    expect(await store.getIncludingTombstone('memory-1', 'project-a')).toMatchObject({ id: 'memory-1', status: 'tombstoned' })
  })

  it('uses optimistic versions for conflicting updates', async () => {
    const store = createStore()
    await store.init()
    await store.mutate(createMutation())
    await store.mutate({
      requestId: 'request-2',
      operation: 'update',
      recordId: 'memory-1',
      projectScopeId: 'project-a',
      expectedVersion: 1,
      changes: { content: 'Updated once.' },
    })
    await expect(
      store.mutate({
        requestId: 'request-3',
        operation: 'update',
        recordId: 'memory-1',
        projectScopeId: 'project-a',
        expectedVersion: 1,
        changes: { content: 'Stale update.' },
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('persists authoritative state across store instances', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-persist-'))
    directories.push(directory)
    const dbPath = join(directory, 'memory-v2.db')
    const first = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    stores.push(first)
    await first.init()
    await first.mutate(createMutation())
    first.close()
    const second = new MemoryV2Store({ dbPath, gates: { MEMORY_STORE_V2: true } })
    stores.push(second)
    await second.init()
    expect(await second.get('memory-1', 'project-a')).toMatchObject({ content: 'Use concise explanations.' })
  })

  it('rejects access without an effective store gate', async () => {
    const store = new MemoryV2Store({ dbPath: ':memory:' })
    stores.push(store)
    await store.init()
    await expect(store.mutate(createMutation())).rejects.toBeInstanceOf(MemoryV2DisabledError)
    await expect(store.get('memory-1', 'project-a')).rejects.toBeInstanceOf(MemoryV2DisabledError)
  })

  it('requires and enforces project scope for record mutations', async () => {
    const store = createStore()
    await store.init()
    await store.mutate(createMutation())
    await expect(
      store.mutate({
        requestId: 'wrong-scope',
        operation: 'update',
        recordId: 'memory-1',
        projectScopeId: 'project-b',
        expectedVersion: 1,
        changes: { content: 'Must not cross scopes.' },
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect(await store.get('memory-1', 'project-b')).toBeNull()
  })

  it('rejects async transaction callbacks before their mutations escape', async () => {
    const store = createStore()
    await store.init()
    await expect(
      store.transaction(async transaction => {
        transaction.mutate(createMutation())
      }),
    ).rejects.toBeInstanceOf(AsyncTransactionError)
    expect(await store.get('memory-1', 'project-a')).toBeNull()
  })

  it('rejects secret-bearing automated mutations and exposes an explicit manual bypass', async () => {
    const store = createStore()
    await store.init()
    const secretMutation = createMutation({
      record: { ...createMutation().record, content: 'token ghp_123456789012345678901234567890123456' },
    })
    await expect(store.mutate(secretMutation)).rejects.toBeInstanceOf(SecretMemoryError)
    const manual = await store.mutateManual(secretMutation)
    expect('content' in manual.record ? manual.record.content : '').toContain('ghp_')
  })

  it('uses Unicode code points for character budgets', async () => {
    const store = createStore({ maxTotalCharacters: 10 })
    await store.init()
    await expect(
      store.mutate(createMutation({ record: { ...createMutation().record, name: '😀', content: '😀😀😀😀😀😀😀😀😀😀' } })),
    ).rejects.toBeInstanceOf(MemoryBudgetError)
  })

  it('bounds maintenance of old tombstones and request records', async () => {
    const store = createStore({ tombstoneRetentionMs: 10, requestRetentionMs: 10 })
    await store.init()
    await store.mutate(createMutation())
    await store.mutate({ requestId: 'request-2', operation: 'delete', recordId: 'memory-1', projectScopeId: 'project-a' })
    const result = await store.maintain(Date.now() + 1000)
    expect(result.tombstonesRemoved).toBe(1)
    expect(result.requestsRemoved).toBeGreaterThanOrEqual(1)
    expect(await store.getIncludingTombstone('memory-1', 'project-a')).toBeNull()
  })

  it('burns tombstoned ids so cleanup cannot permit ABA recreation', async () => {
    const store = createStore({ tombstoneRetentionMs: 10 })
    await store.init()
    await store.mutate(createMutation())
    await store.mutate({ requestId: 'request-2', operation: 'delete', recordId: 'memory-1', projectScopeId: 'project-a' })
    await store.maintain(Date.now() + 1000)

    await expect(store.mutate(createMutation({ requestId: 'request-3' }))).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('rejects project scope changes through normal updates', async () => {
    const store = createStore()
    await store.init()
    await store.mutate(createMutation())

    await expect(
      store.mutate({
        requestId: 'request-2',
        operation: 'update',
        recordId: 'memory-1',
        projectScopeId: 'project-a',
        expectedVersion: 1,
        changes: { projectScopeId: 'project-b' },
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect(await store.get('memory-1', 'project-a')).toMatchObject({ projectScopeId: 'project-a', version: 1 })
  })

  it('does not replay deleted memory plaintext from idempotency rows', async () => {
    const store = createStore()
    await store.init()
    const created = await store.mutate(createMutation())
    await store.mutate({
      requestId: 'request-2',
      operation: 'update',
      recordId: 'memory-1',
      projectScopeId: 'project-a',
      expectedVersion: created.record.version,
      changes: { content: 'Updated private content.' },
    })
    await store.mutate({ requestId: 'request-3', operation: 'delete', recordId: 'memory-1', projectScopeId: 'project-a' })

    for (const request of [createMutation(), {
      requestId: 'request-2',
      operation: 'update' as const,
      recordId: 'memory-1',
      projectScopeId: 'project-a',
      expectedVersion: 1,
      changes: { content: 'Updated private content.' },
    }, { requestId: 'request-3', operation: 'delete' as const, recordId: 'memory-1', projectScopeId: 'project-a' }]) {
      const replay = await store.mutate(request)
      expect(replay.record.status).toBe('tombstoned')
      expect('content' in replay.record).toBe(false)
      expect('name' in replay.record).toBe(false)
    }
  })
})
