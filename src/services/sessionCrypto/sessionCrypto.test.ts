import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  KeyMaterialUnavailableError,
  createStateCommitRequest,
  SessionCryptoManager,
  SessionCryptoUnavailableError,
  StateCommitError,
  StateCommitRequestReuseError,
  StateCommitUncertainError,
  stateCommitRequestHash,
  type CryptoEpochMaterial,
  type SessionCryptoKeyStore,
  type SessionCryptoState,
  type SessionCryptoStateStore,
  type NonceReservation,
  type SessionWriterLease,
  type SessionWriterFence,
  type SessionWriterLeaseStore,
  type StateCommitRequest,
  type StateCommitResult,
} from './sessionCrypto.js'

class TestKeyStore implements SessionCryptoKeyStore {
  readonly available = true
  readonly nonceReservationContract = { profile: 'secure-store-high-water-v1', counterBits: 64, atomic: true, durable: true, rollbackProof: true, crossProcess: true } as const
  readonly records = new Map<string, CryptoEpochMaterial>()
  readonly counters = new Map<string, bigint>()
  readonly active = new Map<string, string>()
  readonly deletedLifecycle = new Map<string, bigint>()
  beforeReservation: (() => Promise<void>) | null = null
  private nextEpoch = 0n
  verified = true

  async verifyNonceReservationContract(): Promise<boolean> { return this.verified }

  async highestEpoch(): Promise<bigint> {
    return this.nextEpoch
  }

  async createEpoch(input: { sessionId: string; keyEpoch: bigint; lifecycleGeneration: bigint; now: number }): Promise<CryptoEpochMaterial> {
    this.nextEpoch = input.keyEpoch > this.nextEpoch ? input.keyEpoch : this.nextEpoch
    const material: CryptoEpochMaterial = {
      sessionId: input.sessionId,
      keyEpoch: input.keyEpoch,
      keyId: `key-${input.keyEpoch}`,
      encryptionKey: randomBytes(32),
      integrityKey: randomBytes(32),
      noncePrefix32: randomBytes(4),
      lifecycleGeneration: input.lifecycleGeneration,
      state: 'encrypt_and_decrypt',
      createdAt: input.now,
    }
    this.records.set(material.keyId, material)
    this.counters.set(material.keyId, 0n)
    return material
  }

  async listEpochs(sessionId: string): Promise<CryptoEpochMaterial[]> {
    return [...this.records.values()].filter(record => record.sessionId === sessionId)
  }

  async getEpoch(keyId: string): Promise<CryptoEpochMaterial | null> {
    return this.records.get(keyId) ?? null
  }

  async markDecryptOnly(keyId: string): Promise<void> {
    const record = this.records.get(keyId)
    if (record) record.state = 'decrypt_only'
  }

  async markOrphaned(keyId: string): Promise<void> {
    await this.markDecryptOnly(keyId)
  }

  async destroyEpoch(keyId: string): Promise<void> {
    this.records.delete(keyId)
    this.counters.delete(keyId)
    this.active.delete(keyId)
  }

  async activateEpoch(keyId: string, leaseToken: string): Promise<void> {
    const record = this.records.get(keyId)
    if (!record) throw new Error('missing key')
    record.state = 'encrypt_and_decrypt'
    this.active.set(keyId, leaseToken)
  }

  async deactivateEpoch(keyId: string): Promise<void> {
    this.active.delete(keyId)
    await this.markDecryptOnly(keyId)
  }

  async reserveNonceRange(input: { sessionId: string; keyEpoch: bigint; keyId: string; lease: SessionWriterLease; count: bigint; lifecycleGeneration: bigint }): Promise<NonceReservation> {
    if (this.active.get(input.keyId) !== input.lease.token) throw new Error('epoch is not writable')
    if ((this.deletedLifecycle.get(input.sessionId) ?? -1n) >= input.lifecycleGeneration) throw new Error('nonce reservation invalidated')
    if (this.beforeReservation) await this.beforeReservation()
    if ((this.deletedLifecycle.get(input.sessionId) ?? -1n) >= input.lifecycleGeneration) throw new Error('nonce reservation invalidated')
    const record = this.records.get(input.keyId)
    if (!record || record.sessionId !== input.sessionId || record.keyEpoch !== input.keyEpoch) throw new Error('nonce reservation identity mismatch')
    if (record.lifecycleGeneration !== input.lifecycleGeneration || input.lease.lifecycleGeneration !== input.lifecycleGeneration) throw new Error('nonce reservation lifecycle mismatch')
    if (input.count !== 1n) throw new Error('test store only supports one counter')
    const counter = this.counters.get(input.keyId)
    if (counter === undefined) throw new Error('missing key')
    this.counters.set(input.keyId, counter + input.count)
    return Object.freeze({ sessionId: input.sessionId, keyEpoch: input.keyEpoch, keyId: input.keyId, leaseGeneration: input.lease.generation, leaseToken: input.lease.token, startCounter: counter, count: input.count, lifecycleGeneration: input.lifecycleGeneration })
  }

  async validateNonceReservation(reservation: NonceReservation): Promise<void> {
    const record = this.records.get(reservation.keyId)
    if (!record || record.lifecycleGeneration !== reservation.lifecycleGeneration || this.active.get(reservation.keyId) !== reservation.leaseToken || (this.deletedLifecycle.get(reservation.sessionId) ?? -1n) >= reservation.lifecycleGeneration) throw new Error('nonce reservation invalidated')
  }

  async invalidateLifecycle(sessionId: string, lifecycleGeneration: bigint): Promise<void> {
    this.deletedLifecycle.set(sessionId, lifecycleGeneration)
  }
}

class TestStateStore implements SessionCryptoStateStore {
  state: SessionCryptoState | null = null
  commitMode: 'normal' | 'commit_then_throw' | 'throw_before_commit' = 'normal'
  commitResponseMode: 'normal' | 'malformed' = 'normal'
  lookupMode: 'normal' | 'throw' = 'normal'
  lookupResponseMode: 'stored' | 'not_committed' = 'stored'
  lookupCalls = 0
  lastRequest: StateCommitRequest | null = null
  async load(_sessionId?: string): Promise<SessionCryptoState | null> {
    return this.state ? structuredClone(this.state) : null
  }
  readonly commits = new Map<string, StateCommitResult>()
  async commit(request: StateCommitRequest): Promise<StateCommitResult> {
    if (this.commitMode === 'throw_before_commit') throw new Error('state commit transport failure')
    if (request.requestHash !== stateCommitRequestHash(request)) throw new StateCommitRequestReuseError(request.requestId)
    const prior = this.commits.get(request.requestId)
    if (prior && prior.requestHash !== request.requestHash) throw new StateCommitRequestReuseError(request.requestId)
    if (prior) return prior
    const currentFence = this.state && this.state.writerLeaseToken && this.state.writerLeaseGeneration !== null
      ? { token: this.state.writerLeaseToken, generation: this.state.writerLeaseGeneration }
      : null
    if (currentFence?.token !== request.expectedFence?.token || currentFence?.generation !== request.expectedFence?.generation) throw new Error('state fence mismatch')
    this.lastRequest = request
    this.state = structuredClone(request.state)
    const result = { requestId: request.requestId, requestHash: request.requestHash, status: 'committed' as const, state: structuredClone(this.state) }
    this.commits.set(request.requestId, result)
    if (this.commitMode === 'commit_then_throw') throw new Error('state commit acknowledgement lost')
    if (this.commitResponseMode === 'malformed') return { requestId: 'wrong-request', requestHash: 'wrong-hash', status: 'committed', state: null } as unknown as StateCommitResult
    return result
  }
  async lookupCommit(requestId: string, requestHash: string): Promise<StateCommitResult | null> {
    this.lookupCalls += 1
    if (this.lookupMode === 'throw') throw new Error('lookup transport failure')
    if (this.lookupResponseMode === 'not_committed' && this.lastRequest?.requestId === requestId && this.lastRequest.requestHash === requestHash) {
      return { requestId, requestHash, status: 'not_committed', state: null }
    }
    const result = this.commits.get(requestId) ?? null
    if (result && result.requestHash !== requestHash) throw new StateCommitRequestReuseError(requestId)
    return result
  }
  async overwrite(state: SessionCryptoState, expectedFence: SessionWriterFence | null): Promise<void> {
    await this.commit(createStateCommitRequest({ requestId: `test-overwrite-${Math.random()}`, action: 'reconcile', state, expectedFence, lease: null, epochKeyId: state.activeKeyId, epochKeyEpoch: state.activeKeyEpoch }))
  }
  async markCryptographicallyErased(_sessionId: string, keyId: string): Promise<void> {
    if (this.state && !this.state.cryptographicallyErasedKeyIds.includes(keyId)) this.state.cryptographicallyErasedKeyIds.push(keyId)
  }
  async delete(): Promise<void> {
    this.state = null
  }
}

class TestLeaseStore implements SessionWriterLeaseStore {
  lease: SessionWriterLease | null = null
  private nextGeneration = 0n
  private lifecycleGeneration = 0n
  async acquire(sessionId: string, ownerId: string, now: number, ttlMs: number): Promise<SessionWriterLease> {
    if (this.lease) throw new Error('writer lease unavailable')
    this.nextGeneration += 1n
    this.lease = { sessionId, ownerId, token: `lease-${ownerId}`, generation: this.nextGeneration, expiresAt: now + ttlMs, lifecycleGeneration: this.lifecycleGeneration, kind: 'writer' }
    return this.lease
  }
  async acquireDeletionFence(sessionId: string, ownerId: string, now: number, ttlMs: number): Promise<SessionWriterLease> {
    this.nextGeneration += 1n
    this.lifecycleGeneration += 1n
    this.lease = { sessionId, ownerId, token: `delete-${ownerId}`, generation: this.nextGeneration, expiresAt: now + ttlMs, lifecycleGeneration: this.lifecycleGeneration, kind: 'deletion' }
    return this.lease
  }
  async get(sessionId: string): Promise<SessionWriterLease | null> {
    return this.lease?.sessionId === sessionId ? this.lease : null
  }
  async release(lease: SessionWriterLease): Promise<void> {
    if (this.lease?.token === lease.token) this.lease = null
  }
}

function makeManager() {
  const keyStore = new TestKeyStore()
  const stateStore = new TestStateStore()
  const leaseStore = new TestLeaseStore()
  return { manager: new SessionCryptoManager({ keyStore, stateStore, leaseStore, ownerId: 'owner-1', now: () => 100, leaseTtlMs: 1_000 }), keyStore, stateStore, leaseStore }
}

describe('session crypto epochs', () => {
  test('creates a fresh epoch for every writer ownership acquisition', async () => {
    const { manager, keyStore } = makeManager()
    const first = await manager.acquireWriter('session-1')
    const firstEpoch = first.epoch.keyEpoch
    await first.close()
    const second = await manager.acquireWriter('session-1')

    expect(second.epoch.keyEpoch).toBe(firstEpoch + 1n)
    expect((await keyStore.getEpoch(first.epoch.keyId))?.state).toBe('decrypt_only')
  })

  test('does not reuse a nonce after persisted state is restored', async () => {
    const { manager, stateStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const before = structuredClone(await stateStore.load())
    const first = await writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([1]) })
    if (before) await stateStore.overwrite(before, { token: before.writerLeaseToken!, generation: before.writerLeaseGeneration! })
    const second = await writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '2', plaintext: new Uint8Array([2]) })

    expect(second.metadata.nonceCounter).not.toBe(first.metadata.nonceCounter)
  })

  test('rejects encryption when persisted SQLite generation changes under a live writer', async () => {
    const { manager, stateStore } = makeManager()
    const writer = await manager.acquireWriter('session-1', 4n)
    const state = await stateStore.load()
    if (!state) throw new Error('expected state')
    await stateStore.overwrite({ ...state, sqliteGeneration: 3n }, { token: writer.lease.token, generation: writer.lease.generation })

    await expect(writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([1]) })).rejects.toThrow(
      'rolled back',
    )
  })

  test('fails closed when no credential/key primitive is configured', async () => {
    const manager = new SessionCryptoManager()
    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(SessionCryptoUnavailableError)
  })

  test('reports secure-store readiness without claiming unavailable deletion support', async () => {
    const manager = new SessionCryptoManager()
    await expect(manager.isAvailable()).resolves.toBe(false)
  })

  test('rejects a nonce backend without an explicit rollback-proof contract', async () => {
    const { keyStore, stateStore, leaseStore } = makeManager()
    ;(keyStore as unknown as { nonceReservationContract: null }).nonceReservationContract = null
    const manager = new SessionCryptoManager({ keyStore, stateStore, leaseStore })

    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(SessionCryptoUnavailableError)
  })

  test('rejects a nonce backend that fails runtime verification', async () => {
    const { manager, keyStore } = makeManager()
    keyStore.verified = false

    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(SessionCryptoUnavailableError)
  })

  test('resolves a commit-then-error as committed before retaining the epoch', async () => {
    const { manager, stateStore, keyStore } = makeManager()
    stateStore.commitMode = 'commit_then_throw'

    const writer = await manager.acquireWriter('session-1')

    expect((await stateStore.load())?.activeKeyId).toBe(writer.epoch.keyId)
    expect((await keyStore.getEpoch(writer.epoch.keyId))?.state).toBe('encrypt_and_decrypt')
  })

  test('looks up a malformed commit response and preserves the epoch and lease when lookup is uncertain', async () => {
    const { manager, stateStore, keyStore, leaseStore } = makeManager()
    stateStore.commitResponseMode = 'malformed'
    stateStore.lookupMode = 'throw'

    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(StateCommitUncertainError)

    expect(stateStore.lookupCalls).toBeGreaterThan(0)
    const epoch = (await keyStore.listEpochs('session-1'))[0]
    expect(epoch?.state).toBe('encrypt_and_decrypt')
    expect((await leaseStore.get('session-1'))?.kind).toBe('writer')
  })

  test('resolves a malformed commit response from a matching committed lookup', async () => {
    const { manager, stateStore, keyStore } = makeManager()
    stateStore.commitResponseMode = 'malformed'

    const writer = await manager.acquireWriter('session-1')

    expect(stateStore.lookupCalls).toBe(1)
    expect((await stateStore.load('session-1'))?.activeKeyId).toBe(writer.epoch.keyId)
    expect((await keyStore.getEpoch(writer.epoch.keyId))?.state).toBe('encrypt_and_decrypt')
  })

  test('cleans up after a malformed commit response and authoritative not-committed lookup', async () => {
    const { manager, stateStore, keyStore, leaseStore } = makeManager()
    stateStore.commitResponseMode = 'malformed'
    stateStore.lookupResponseMode = 'not_committed'

    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(StateCommitError)

    expect(stateStore.lookupCalls).toBe(1)
    const epoch = (await keyStore.listEpochs('session-1'))[0]
    expect(epoch?.state).toBe('decrypt_only')
    expect(await leaseStore.get('session-1')).toBeNull()
  })

  test('leaves epoch and lease untouched when commit and lookup outcomes are both uncertain', async () => {
    const { manager, stateStore, keyStore, leaseStore } = makeManager()
    stateStore.commitMode = 'commit_then_throw'
    stateStore.lookupMode = 'throw'

    await expect(manager.acquireWriter('session-1')).rejects.toBeInstanceOf(StateCommitUncertainError)

    const epoch = (await keyStore.listEpochs('session-1'))[0]
    expect(epoch?.state).toBe('encrypt_and_decrypt')
    expect((await stateStore.load('session-1'))?.activeKeyId).toBe(epoch?.keyId)
    expect((await leaseStore.get('session-1'))?.kind).toBe('writer')
  })

  test('rejects altered request reuse and hash-mismatched commit lookup without mutation', async () => {
    const { manager, stateStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const entry = [...stateStore.commits.entries()][0]
    if (!entry || !entry[1].state) throw new Error('expected committed state')
    const [requestId, committed] = entry
    const committedState = committed.state!
    const alteredState: SessionCryptoState = { ...committedState, sqliteGeneration: committedState.sqliteGeneration + 1n }
    const altered = createStateCommitRequest({
      requestId,
      action: 'acquire',
      state: alteredState,
      expectedFence: { token: writer.lease.token, generation: writer.lease.generation },
      lease: writer.lease,
      epochKeyId: writer.epoch.keyId,
      epochKeyEpoch: writer.epoch.keyEpoch,
    })

    await expect(stateStore.commit(altered)).rejects.toBeInstanceOf(StateCommitRequestReuseError)
    await expect(stateStore.lookupCommit(requestId, 'altered-hash')).rejects.toBeInstanceOf(StateCommitRequestReuseError)
    expect((await stateStore.load('session-1'))?.sqliteGeneration).toBe(0n)
  })

  test('reconciles a noncommitted acquire before deactivating its epoch', async () => {
    const { manager, stateStore, keyStore } = makeManager()
    stateStore.commitMode = 'throw_before_commit'

    await expect(manager.acquireWriter('session-1')).rejects.toThrow('outcome is unknown')

    const epoch = (await keyStore.listEpochs('session-1'))[0]
    expect(epoch?.state).toBe('decrypt_only')
  })

  test('surfaces key material loss instead of creating a replacement key', async () => {
    const { manager, keyStore, stateStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    await keyStore.destroyEpoch(writer.epoch.keyId)
    await expect(writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      KeyMaterialUnavailableError,
    )
    expect((await stateStore.load())?.activeKeyEpoch).toBe(writer.epoch.keyEpoch)
  })

  test('concurrent frame encryption receives distinct reserved counters', async () => {
    const { manager } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const frames = await Promise.all(Array.from({ length: 16 }, (_, index) => writer.encrypt({
      projectScopeId: 'project-1',
      artifactKind: 'raw',
      artifactId: `${index}`,
      plaintext: new Uint8Array([index]),
    })))

    expect(new Set(frames.map(frame => frame.metadata.nonceCounter)).size).toBe(frames.length)
  })

  test('a revoked or stale lease cannot reserve another nonce', async () => {
    const { manager, leaseStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    await leaseStore.release(writer.lease)

    await expect(writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: 'revoked', plaintext: new Uint8Array([1]) })).rejects.toThrow(
      'lease is no longer current',
    )
  })

  test('deletion tombstone invalidates loaded writers and retained-frame decryption', async () => {
    const { manager, stateStore, keyStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const frame = await writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: 'before-delete', plaintext: new Uint8Array([1]) })

    await manager.deleteSession('session-1')

    expect((await stateStore.load())?.lifecycleState).toBe('deleted')
    expect(await keyStore.getEpoch(writer.epoch.keyId)).toBeNull()
    await expect(writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: 'after-delete', plaintext: new Uint8Array([2]) })).rejects.toThrow()
    await expect(manager.decrypt('session-1', frame)).rejects.toBeInstanceOf(Error)
    await expect(manager.acquireWriter('session-1')).rejects.toThrow('deleted')
  })

  test('deletion resolves an acknowledgement error before destroying keys', async () => {
    const { manager, stateStore, keyStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    stateStore.commitMode = 'commit_then_throw'

    await manager.deleteSession('session-1')

    expect((await stateStore.load())?.lifecycleState).toBe('deleted')
    expect(await keyStore.getEpoch(writer.epoch.keyId)).toBeNull()
  })

  test('deletion keeps the lifecycle fence and keys when commit lookup is uncertain', async () => {
    const { manager, stateStore, keyStore, leaseStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    stateStore.commitMode = 'commit_then_throw'
    stateStore.lookupMode = 'throw'

    await expect(manager.deleteSession('session-1')).rejects.toBeInstanceOf(StateCommitUncertainError)

    expect(await keyStore.getEpoch(writer.epoch.keyId)).not.toBeNull()
    expect((await stateStore.load('session-1'))?.lifecycleState).toBe('deleted')
    expect((await leaseStore.get('session-1'))?.kind).toBe('deletion')

    stateStore.commitMode = 'normal'
    stateStore.lookupMode = 'normal'
    await manager.reconcile('session-1')
    expect(await keyStore.getEpoch(writer.epoch.keyId)).toBeNull()
  })

  test('deletion interleaving invalidates a pre-delete reservation before a frame is returned', async () => {
    const { manager, keyStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    let deleting = false
    keyStore.beforeReservation = async () => {
      if (!deleting) {
        deleting = true
        await manager.deleteSession('session-1')
      }
    }

    await expect(writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: 'race', plaintext: new Uint8Array([3]) })).rejects.toThrow('invalidated')
  })

  test('reconciles secure-store epochs even when rollback removed SQLite state', async () => {
    const { manager, keyStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const orphanKeyId = 'key-99'
    await keyStore.createEpoch({ sessionId: 'session-1', keyEpoch: 99n, lifecycleGeneration: 0n, now: -2_000 })
    await writer.close()
    const stateStore = new TestStateStore()
    const orphanManager = new SessionCryptoManager({ keyStore, stateStore, leaseStore: new TestLeaseStore(), ownerId: 'owner-2', now: () => 100, orphanGraceMs: 1_000 })

    const result = await orphanManager.reconcile('session-1')

    expect(result.orphanedKeyIds).toContain(orphanKeyId)
    expect(result.destroyedKeyIds).toContain(orphanKeyId)
  })

  test('rotates into a fresh epoch through controlled writer recovery after rollback', async () => {
    const { manager, stateStore } = makeManager()
    const writer = await manager.acquireWriter('session-1', 4n)
    const state = await stateStore.load()
    if (!state) throw new Error('expected state')
    await stateStore.overwrite({ ...state, sqliteGeneration: 3n }, { token: writer.lease.token, generation: writer.lease.generation })

    const recovered = await manager.recoverWriter(writer, 3n)
    expect(recovered.epoch.keyEpoch).toBeGreaterThan(writer.epoch.keyEpoch)
    await expect(recovered.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([1]) })).resolves.toBeDefined()
  })

  test('rejects frame decryption when secure epoch identity differs', async () => {
    const { manager, keyStore } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const frame = await writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([4]) })
    const epoch = await keyStore.getEpoch(writer.epoch.keyId)
    if (!epoch) throw new Error('expected epoch')
    epoch.sessionId = 'other-session'

    await expect(manager.decrypt('session-1', frame)).rejects.toThrow('session identity mismatch')
  })

  test('decrypts retained frames after their writer epoch becomes decrypt-only', async () => {
    const { manager } = makeManager()
    const writer = await manager.acquireWriter('session-1')
    const frame = await writer.encrypt({ projectScopeId: 'project-1', artifactKind: 'raw', artifactId: '1', plaintext: new Uint8Array([4, 5]) })
    await writer.close()

    expect(await manager.decrypt('session-1', frame)).toEqual(new Uint8Array([4, 5]))
  })
})
