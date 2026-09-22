import { describe, expect, test } from 'bun:test'

import {
  PromptFence,
  PromptFencePoisonedError,
  PromptFenceStateError,
  SnapshotRevokedError,
  StalePromptFenceError,
  type TransportOwnershipReceipt,
  type PromptSnapshot,
} from './promptFence.js'

const gates = { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true } as const

function makeSnapshot(fence: PromptFence, storeGeneration = 1n): PromptSnapshot {
  return fence.createSnapshot({
    projectScopeId: 'project-a',
    storeGeneration,
    promptEpoch: 0n,
    records: [{ id: 'memory-1', projectScopeId: 'project-a' }],
    maxPromptCharacters: 1_000,
    maxPromptTokens: 100,
  })
}

function makeFence(now = 100): { fence: PromptFence; clock: { value: number } } {
  const clock = { value: now }
  return {
    clock,
    fence: new PromptFence({ gates, now: () => clock.value, leaseDurationMs: 2_000 }),
  }
}

function beginAdmitted(fence: PromptFence, snapshot: PromptSnapshot, requestId = 'request-1') {
  fence.begin({
    requestId,
    payload: { requestId },
    snapshot,
    memoryRecordIds: ['memory-1'],
    budget: { characters: 10, tokens: 2 },
  })
  fence.waitForLease(requestId)
  const lease = fence.acquireLease()
  fence.admit(requestId, lease)
  return lease
}

describe('PromptFence', () => {
  test('revokes an admitted request before it can reach the local queue', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    const lease = beginAdmitted(fence, snapshot)
    fence.forgetMemory('memory-1', 'project-a')

    expect(fence.getRequest('request-1').state).toBe('REVOKED_BEFORE_SEND')
    expect(() => fence.commitSend('request-1', lease, { enqueue: () => null })).toThrow(SnapshotRevokedError)
  })

  test('atomically commits transport ownership before releasing the fence', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    const lease = beginAdmitted(fence, snapshot)
    let observedState: string | undefined
    const accepted = fence.commitSend('request-1', lease, {
      enqueue: (payload, requestId): TransportOwnershipReceipt => {
        observedState = fence.getRequest('request-1').state
        return Object.freeze({ accepted: true, requestId, payload })
      },
    })

    expect(accepted?.accepted).toBe(true)
    expect(observedState).toBe('SEND_COMMITTED')
    expect(fence.getRequest('request-1').state).toBe('SEND_COMMITTED')
    expect(fence.getPreForgetRequests()).toEqual(['request-1'])
    fence.releaseLease(lease)
    fence.markSent('request-1')
    expect(fence.getRequest('request-1').state).toBe('SENT')
  })

  test('queue rejection leaves an admitted request revocable and unsent', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    const lease = beginAdmitted(fence, snapshot)

    expect(fence.commitSend('request-1', lease, { enqueue: () => null })).toBeNull()
    expect(fence.getRequest('request-1').state).toBe('ADMITTED')
    fence.forgetMemory('memory-1', 'project-a')
    expect(fence.getRequest('request-1').state).toBe('REVOKED_BEFORE_SEND')
  })

  test('rejects stale fencing tokens and poisons admission after the deadline', () => {
    const { fence, clock } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'request-1', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.waitForLease('request-1')
    const lease = fence.acquireLease()
    clock.value += 2_001

    expect(() => fence.admit('request-1', lease)).toThrow(PromptFencePoisonedError)
    expect(fence.getRequest('request-1').state).toBe('FENCE_POISONED')
    expect(() => fence.acquireLease()).toThrow(PromptFencePoisonedError)
    expect(() => fence.recoverPoisonedFence(lease.generation)).not.toThrow()
    expect(() => fence.admit('request-1', lease)).toThrow(StalePromptFenceError)
  })

  test('rejects a snapshot whose store generation or prompt epoch is stale', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'request-1', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.waitForLease('request-1')
    const lease = fence.acquireLease()
    fence.forgetMemory('other-memory', 'project-a')

    expect(() => fence.admit('request-1', lease)).toThrow(StalePromptFenceError)
    expect(fence.getRequest('request-1').state).toBe('WAITING_FOR_LEASE')
  })

  test('rejects a forged snapshot clone and mismatched record scope', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    const forged = structuredClone(snapshot)

    expect(() => fence.begin({ requestId: 'forged', payload: {}, snapshot: forged, budget: { characters: 1, tokens: 1 } })).toThrow(StalePromptFenceError)
    expect(() => fence.createSnapshot({
      projectScopeId: 'project-a',
      storeGeneration: 1n,
      promptEpoch: 0n,
      records: [{ id: 'memory-1', projectScopeId: 'project-b' }],
      maxPromptCharacters: 1_000,
      maxPromptTokens: 100,
    })).toThrow(StalePromptFenceError)
  })

  test('closes admission synchronously before history deletion awaits', async () => {
    const { fence } = makeFence()
    let closedDuringCallback = false
    await fence.deleteSessionHistory({
      closePromptAdmission: () => {
        closedDuringCallback = true
        expect(() => makeSnapshot(fence)).toThrow(PromptFenceStateError)
      },
      deleteSessionCrypto: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })

    expect(closedDuringCallback).toBe(true)
  })

  test('invalidates snapshots and request payload access after history deletion', async () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'request-1', payload: { secret: 'value' }, snapshot, budget: { characters: 1, tokens: 1 } })
    await fence.deleteSessionHistory({
      closePromptAdmission: () => {},
      deleteSessionCrypto: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })

    expect(() => fence.getRequest('request-1')).toThrow(PromptFenceStateError)
    expect(() => makeSnapshot(fence)).toThrow(PromptFenceStateError)
    expect(fence.isHistoryDeleted()).toBe(true)
  })

  test('poisons the fence when transport ownership is ambiguous', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    const lease = beginAdmitted(fence, snapshot)

    expect(() => fence.commitSend('request-1', lease, { enqueue: () => { throw new Error('unknown') } })).toThrow(PromptFencePoisonedError)
    expect(fence.getRequest('request-1').state).toBe('FENCE_POISONED')
  })

  test('keeps memory-only forget distinct from session history deletion', async () => {
    const { fence } = makeFence()
    const calls: string[] = []
    await fence.deleteSessionHistory({
      closePromptAdmission: () => { calls.push('close') },
      deleteSessionCrypto: async () => { calls.push('crypto') },
      purgeEncryptedArtifacts: async () => { calls.push('purge') },
    })

    expect(calls).toEqual(['close', 'crypto', 'purge'])
    expect(fence.isHistoryDeleted()).toBe(true)
  })

  test('fails closed when a session history deletion dependency is unavailable', async () => {
    const { fence } = makeFence()
    await expect(
      fence.deleteSessionHistory({
        closePromptAdmission: () => {},
        deleteSessionCrypto: undefined,
        purgeEncryptedArtifacts: async () => {},
      }),
    ).rejects.toBeInstanceOf(PromptFenceStateError)
    expect(fence.isHistoryDeleted()).toBe(false)
    expect(() => makeSnapshot(fence)).toThrow(PromptFenceStateError)
  })

  test('keeps admission closed when history deletion fails after fencing', async () => {
    const { fence } = makeFence()
    await expect(fence.deleteSessionHistory({
      closePromptAdmission: async () => { throw new Error('close failed') },
      deleteSessionCrypto: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })).rejects.toThrow('close failed')
    expect(() => makeSnapshot(fence)).toThrow(PromptFenceStateError)
    expect(fence.isHistoryDeleted()).toBe(false)
  })

  test('cancels waiting and revokes admitted requests at deletion start while retaining committed reports', async () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'building', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.begin({ requestId: 'waiting', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.waitForLease('waiting')
    const lease = beginAdmitted(fence, snapshot, 'admitted')
    const committed = fence.commitSend('admitted', lease, {
      enqueue: (payload, requestId) => Object.freeze({ accepted: true, requestId, payload }),
    })
    expect(committed?.accepted).toBe(true)
    fence.releaseLease(lease)

    await fence.deleteSessionHistory({
      closePromptAdmission: () => {},
      deleteSessionCrypto: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })

    expect(fence.getPreForgetRequests()).toEqual(['admitted'])
    expect(fence.getPreDeleteRequests()).toEqual(['admitted'])
    expect(() => fence.acquireLease()).toThrow(PromptFenceStateError)
    expect(() => fence.isSnapshotLive(snapshot)).not.toThrow()
    expect(fence.isSnapshotLive(snapshot)).toBe(false)
  })

  test('history deletion rejects admission and new transport queues after synchronous closure', async () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'waiting', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.waitForLease('waiting')
    const deletion = fence.deleteSessionHistory({
      closePromptAdmission: () => {},
      deleteSessionCrypto: () => {},
      purgeEncryptedArtifacts: () => {},
    })

    await deletion
    expect(() => fence.admit('waiting', { token: 'stale', generation: 1n, expiresAt: Date.now() + 1_000 })).toThrow(PromptFenceStateError)
    expect(() => fence.commitSend('waiting', { token: 'stale', generation: 1n, expiresAt: Date.now() + 1_000 }, { enqueue: () => null })).toThrow(PromptFenceStateError)
  })

  test('manual admission closure rejects waiting, admission, and send transitions', () => {
    const { fence } = makeFence()
    const snapshot = makeSnapshot(fence)
    fence.begin({ requestId: 'request-1', payload: {}, snapshot, budget: { characters: 1, tokens: 1 } })
    fence.waitForLease('request-1')
    const lease = fence.acquireLease()
    fence.closePromptAdmission()

    expect(() => fence.waitForLease('request-1')).toThrow(PromptFenceStateError)
    expect(() => fence.admit('request-1', lease)).toThrow(PromptFenceStateError)
    expect(() => fence.commitSend('request-1', lease, { enqueue: () => null })).toThrow(PromptFenceStateError)
  })
})
