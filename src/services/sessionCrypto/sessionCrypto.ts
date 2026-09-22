import { randomUUID } from 'node:crypto'

import {
  decryptEncryptedFrame,
  encryptEncryptedFrame,
  type EncryptedFrame,
  type EncryptedFrameMetadataInput,
} from './encryptedFrames.js'
import { sha256Canonical } from '../memoryV2/canonical.js'

export type SessionCryptoEpochState = 'encrypt_and_decrypt' | 'decrypt_only' | 'destroyed'

export type CryptoEpochMaterial = {
  sessionId: string
  keyEpoch: bigint
  keyId: string
  encryptionKey: Uint8Array
  integrityKey: Uint8Array
  noncePrefix32: Uint8Array
  lifecycleGeneration: bigint
  state: SessionCryptoEpochState
  createdAt: number
}

export type SessionCryptoState = {
  sessionId: string
  activeKeyEpoch: bigint | null
  activeKeyId: string | null
  writerOwnerId: string | null
  writerLeaseToken: string | null
  writerLeaseGeneration: bigint | null
  sqliteGeneration: bigint
  lastKeyEpoch: bigint
  committedKeyIds: string[]
  cryptographicallyErasedKeyIds: string[]
  lifecycleGeneration: bigint
  lifecycleState: 'active' | 'deleting' | 'deleted'
  deletionLeaseToken: string | null
  deletionLeaseGeneration: bigint | null
}

export type SessionWriterLease = {
  sessionId: string
  ownerId: string
  token: string
  generation: bigint
  expiresAt: number
  lifecycleGeneration: bigint
  kind: 'writer' | 'deletion'
}

export type SessionWriterFence = {
  token: string
  generation: bigint
}

export type NonceReservation = Readonly<{
  sessionId: string
  keyEpoch: bigint
  keyId: string
  leaseGeneration: bigint
  leaseToken: string
  startCounter: bigint
  count: bigint
  lifecycleGeneration: bigint
}>

export type NonceReservationBackendContract = Readonly<{
  profile: 'secure-store-high-water-v1'
  counterBits: 64
  atomic: true
  durable: true
  rollbackProof: true
  crossProcess: true
}>

export type StateCommitRequest = Readonly<{
  requestId: string
  requestHash: string
  action: 'acquire' | 'close' | 'reconcile' | 'delete'
  state: SessionCryptoState
  expectedFence: SessionWriterFence | null
  lease: SessionWriterLease | null
  epochKeyId: string | null
  epochKeyEpoch: bigint | null
}>

export type StateCommitResult = Readonly<{
  requestId: string
  requestHash: string
  status: 'committed' | 'not_committed'
  state: SessionCryptoState | null
}>

export type StateCommitInput = Omit<StateCommitRequest, 'requestHash'>

export function stateCommitRequestHash(input: StateCommitInput): string {
  return sha256Canonical({
    action: input.action,
    state: input.state,
    expectedFence: input.expectedFence,
    lease: input.lease,
    epochKeyId: input.epochKeyId,
    epochKeyEpoch: input.epochKeyEpoch,
  })
}

export function createStateCommitRequest(input: StateCommitInput): StateCommitRequest {
  return { ...input, requestHash: stateCommitRequestHash(input) }
}

export interface SessionCryptoKeyStore {
  readonly available: boolean
  readonly nonceReservationContract: NonceReservationBackendContract | null
  verifyNonceReservationContract(): Promise<boolean>
  highestEpoch(sessionId: string): Promise<bigint>
  createEpoch(input: { sessionId: string; keyEpoch: bigint; lifecycleGeneration: bigint; now: number }): Promise<CryptoEpochMaterial>
  listEpochs(sessionId: string): Promise<CryptoEpochMaterial[]>
  getEpoch(keyId: string): Promise<CryptoEpochMaterial | null>
  markDecryptOnly(keyId: string): Promise<void>
  markOrphaned(keyId: string): Promise<void>
  destroyEpoch(keyId: string): Promise<void>
  invalidateLifecycle(sessionId: string, lifecycleGeneration: bigint): Promise<void>
  activateEpoch(keyId: string, leaseToken: string): Promise<void>
  deactivateEpoch(keyId: string): Promise<void>
  reserveNonceRange(input: {
    sessionId: string
    keyEpoch: bigint
    keyId: string
    lease: SessionWriterLease
    count: bigint
    lifecycleGeneration: bigint
  }): Promise<NonceReservation>
  validateNonceReservation(reservation: NonceReservation): Promise<void>
}

export interface SessionCryptoStateStore {
  load(sessionId: string): Promise<SessionCryptoState | null>
  commit(request: StateCommitRequest): Promise<StateCommitResult>
  lookupCommit(requestId: string, requestHash: string): Promise<StateCommitResult | null>
  markCryptographicallyErased(sessionId: string, keyId: string): Promise<void>
  delete(sessionId: string): Promise<void>
}

export interface SessionWriterLeaseStore {
  acquire(sessionId: string, ownerId: string, now: number, ttlMs: number): Promise<SessionWriterLease>
  acquireDeletionFence(sessionId: string, ownerId: string, now: number, ttlMs: number): Promise<SessionWriterLease>
  get(sessionId: string): Promise<SessionWriterLease | null>
  release(lease: SessionWriterLease): Promise<void>
}

export type SessionCryptoManagerOptions = {
  keyStore?: SessionCryptoKeyStore
  stateStore?: SessionCryptoStateStore
  leaseStore?: SessionWriterLeaseStore
  ownerId?: string
  now?: () => number
  orphanGraceMs?: number
  leaseTtlMs?: number
}

export class SessionCryptoUnavailableError extends Error {
  constructor() {
    super('Session crypto is unavailable because no native credential and lease primitives are configured')
    this.name = 'SessionCryptoUnavailableError'
  }
}

export class KeyMaterialUnavailableError extends Error {
  readonly keyId: string

  constructor(keyId: string) {
    super(`Session key material is unavailable: ${keyId}`)
    this.name = 'KeyMaterialUnavailableError'
    this.keyId = keyId
  }
}

export class SessionCryptoRollbackError extends Error {
  constructor() {
    super('Session crypto state rolled back and must be reconciled before encryption')
    this.name = 'SessionCryptoRollbackError'
  }
}

export class SessionWriterLeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionWriterLeaseError'
  }
}

export class SessionDeletedError extends Error {
  constructor() {
    super('Session crypto is deleted and cannot encrypt or decrypt')
    this.name = 'SessionDeletedError'
  }
}

export class StateCommitError extends Error {
  readonly requestId: string

  constructor(requestId: string) {
    super(`Session crypto state commit was not committed: ${requestId}`)
    this.name = 'StateCommitError'
    this.requestId = requestId
  }
}

export class StateCommitUncertainError extends Error {
  readonly requestId: string

  constructor(requestId: string) {
    super(`Session crypto state commit outcome is unknown: ${requestId}`)
    this.name = 'StateCommitUncertainError'
    this.requestId = requestId
  }
}

export class StateCommitRequestReuseError extends Error {
  readonly requestId: string

  constructor(requestId: string) {
    super(`Session crypto state request ID was reused with a different request: ${requestId}`)
    this.name = 'StateCommitRequestReuseError'
    this.requestId = requestId
  }
}

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEASE_TTL_MS = 30_000

function unavailableKeyStore(): SessionCryptoKeyStore {
  return {
    available: false,
    nonceReservationContract: null,
    verifyNonceReservationContract: async () => { throw new SessionCryptoUnavailableError() },
    highestEpoch: async () => 0n,
    createEpoch: async () => { throw new SessionCryptoUnavailableError() },
    listEpochs: async () => [],
    getEpoch: async () => null,
    markDecryptOnly: async () => {},
    markOrphaned: async () => {},
    destroyEpoch: async () => {},
    activateEpoch: async () => {},
    deactivateEpoch: async () => {},
    reserveNonceRange: async () => { throw new SessionCryptoUnavailableError() },
    validateNonceReservation: async () => { throw new SessionCryptoUnavailableError() },
    invalidateLifecycle: async () => { throw new SessionCryptoUnavailableError() },
  }
}

function unavailableStateStore(): SessionCryptoStateStore {
  return {
    load: async () => null,
    commit: async () => { throw new SessionCryptoUnavailableError() },
    lookupCommit: async () => null,
    markCryptographicallyErased: async () => {},
    delete: async () => {},
  }
}

function unavailableLeaseStore(): SessionWriterLeaseStore {
  return {
    acquire: async () => { throw new SessionCryptoUnavailableError() },
    acquireDeletionFence: async () => { throw new SessionCryptoUnavailableError() },
    get: async () => null,
    release: async () => {},
  }
}

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) throw new TypeError('sessionId must be nonempty')
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((maximum, value) => value > maximum ? value : maximum, 0n)
}

function cloneState(state: SessionCryptoState): SessionCryptoState {
  return {
    ...state,
    committedKeyIds: [...state.committedKeyIds],
    cryptographicallyErasedKeyIds: [...state.cryptographicallyErasedKeyIds],
  }
}

function stateFence(state: SessionCryptoState | null): SessionWriterFence | null {
  if (!state || state.writerLeaseToken === null || state.writerLeaseGeneration === null) return null
  return { token: state.writerLeaseToken, generation: state.writerLeaseGeneration }
}

function leaseFence(lease: SessionWriterLease): SessionWriterFence {
  return { token: lease.token, generation: lease.generation }
}

function assertLiveLease(lease: SessionWriterLease, now: number): void {
  if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) throw new SessionWriterLeaseError('session writer lease is expired')
}

function assertWriterLease(lease: SessionWriterLease): void {
  if (lease.kind !== 'writer') throw new SessionWriterLeaseError('session writer lease kind is invalid')
}

function assertDeletionLease(lease: SessionWriterLease): void {
  if (lease.kind !== 'deletion') throw new SessionWriterLeaseError('session deletion lease kind is invalid')
}

function assertReservationContract(keyStore: SessionCryptoKeyStore): void {
  const contract = keyStore.nonceReservationContract
  if (!contract || contract.profile !== 'secure-store-high-water-v1' || contract.counterBits !== 64 || contract.atomic !== true || contract.durable !== true || contract.rollbackProof !== true || contract.crossProcess !== true) {
    throw new SessionCryptoUnavailableError()
  }
}

function lifecycleState(state: SessionCryptoState | null): SessionCryptoState['lifecycleState'] {
  return state?.lifecycleState ?? 'active'
}

function isSessionCryptoState(value: unknown): value is SessionCryptoState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<SessionCryptoState>
  return typeof state.sessionId === 'string' &&
    (state.activeKeyEpoch === null || typeof state.activeKeyEpoch === 'bigint') &&
    (state.activeKeyId === null || typeof state.activeKeyId === 'string') &&
    (state.writerOwnerId === null || typeof state.writerOwnerId === 'string') &&
    (state.writerLeaseToken === null || typeof state.writerLeaseToken === 'string') &&
    (state.writerLeaseGeneration === null || typeof state.writerLeaseGeneration === 'bigint') &&
    typeof state.sqliteGeneration === 'bigint' &&
    typeof state.lastKeyEpoch === 'bigint' &&
    Array.isArray(state.committedKeyIds) && state.committedKeyIds.every(value => typeof value === 'string') &&
    Array.isArray(state.cryptographicallyErasedKeyIds) && state.cryptographicallyErasedKeyIds.every(value => typeof value === 'string') &&
    typeof state.lifecycleGeneration === 'bigint' &&
    (state.lifecycleState === 'active' || state.lifecycleState === 'deleting' || state.lifecycleState === 'deleted') &&
    (state.deletionLeaseToken === null || typeof state.deletionLeaseToken === 'string') &&
    (state.deletionLeaseGeneration === null || typeof state.deletionLeaseGeneration === 'bigint')
}

function isStateCommitResult(value: unknown): value is StateCommitResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<StateCommitResult>
  if (typeof result.requestId !== 'string' || typeof result.requestHash !== 'string' || (result.status !== 'committed' && result.status !== 'not_committed') || !('state' in result)) return false
  return result.status === 'committed' ? isSessionCryptoState(result.state) : result.state === null
}

function isAuthoritativeNotCommitted(value: unknown, request: StateCommitRequest): value is StateCommitResult {
  return isStateCommitResult(value) && value.requestId === request.requestId && value.requestHash === request.requestHash && value.status === 'not_committed'
}

function isMatchingCommitted(value: unknown, request: StateCommitRequest): value is StateCommitResult {
  if (!isStateCommitResult(value) || value.requestId !== request.requestId || value.requestHash !== request.requestHash || value.status !== 'committed') return false
  const state = value.state
  if (!state) return false
  return state.sessionId === request.state.sessionId && state.lifecycleGeneration === request.state.lifecycleGeneration && (request.epochKeyId === null || state.committedKeyIds.includes(request.epochKeyId))
}

export type SessionReconciliationResult = {
  downgradedKeyIds: string[]
  cryptographicallyErasedKeyIds: string[]
  orphanedKeyIds: string[]
  destroyedKeyIds: string[]
}

export class SessionCryptoManager {
  private readonly keyStore: SessionCryptoKeyStore
  private readonly stateStore: SessionCryptoStateStore
  private readonly leaseStore: SessionWriterLeaseStore
  private readonly ownerId: string
  private readonly now: () => number
  private readonly orphanGraceMs: number
  private readonly leaseTtlMs: number

  constructor(options: SessionCryptoManagerOptions = {}) {
    this.keyStore = options.keyStore ?? unavailableKeyStore()
    this.stateStore = options.stateStore ?? unavailableStateStore()
    this.leaseStore = options.leaseStore ?? unavailableLeaseStore()
    this.ownerId = options.ownerId ?? randomUUID()
    this.now = options.now ?? Date.now
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.requireAvailable()
      return true
    } catch {
      return false
    }
  }

  async acquireWriter(sessionId: string, sqliteGeneration = 0n): Promise<SessionWriter> {
    validateSessionId(sessionId)
    await this.requireAvailable()
    let lease: SessionWriterLease | null = null
    let material: CryptoEpochMaterial | null = null
    try {
      lease = await this.leaseStore.acquire(sessionId, `${this.ownerId}:${randomUUID()}`, this.now(), this.leaseTtlMs)
      assertLiveLease(lease, this.now())
      assertWriterLease(lease)
      const state = await this.stateStore.load(sessionId)
      if (lifecycleState(state) !== 'active') throw new SessionDeletedError()
      if (state && state.lifecycleGeneration !== lease.lifecycleGeneration) throw new SessionWriterLeaseError('session lifecycle fence is stale')
      const highestEpoch = await this.keyStore.highestEpoch(sessionId)
      const nextEpoch = maxBigInt(highestEpoch, state?.lastKeyEpoch ?? 0n) + 1n
      if (state?.activeKeyId) await this.keyStore.markDecryptOnly(state.activeKeyId)
      material = await this.keyStore.createEpoch({ sessionId, keyEpoch: nextEpoch, lifecycleGeneration: lease.lifecycleGeneration, now: this.now() })
      if (material.keyEpoch !== nextEpoch || material.sessionId !== sessionId || material.noncePrefix32.byteLength !== 4 || material.lifecycleGeneration !== lease.lifecycleGeneration) {
        throw new Error('credential store returned invalid session crypto epoch')
      }
      await this.keyStore.activateEpoch(material.keyId, lease.token)
      const nextState: SessionCryptoState = {
        sessionId,
        activeKeyEpoch: material.keyEpoch,
        activeKeyId: material.keyId,
        writerOwnerId: lease.ownerId,
        writerLeaseToken: lease.token,
        writerLeaseGeneration: lease.generation,
        sqliteGeneration,
        lastKeyEpoch: material.keyEpoch,
        committedKeyIds: [...new Set([...(state?.committedKeyIds ?? []), material.keyId])],
        cryptographicallyErasedKeyIds: [...(state?.cryptographicallyErasedKeyIds ?? [])],
        lifecycleGeneration: lease.lifecycleGeneration,
        lifecycleState: 'active',
        deletionLeaseToken: null,
        deletionLeaseGeneration: null,
      }
      const requestId = `session-crypto-acquire:${sessionId}:${lease.generation}:${material.keyId}`
      await this.commitState({ requestId, action: 'acquire', state: nextState, expectedFence: stateFence(state), lease, epochKeyId: material.keyId, epochKeyEpoch: material.keyEpoch })
      return new SessionWriter(this, sessionId, lease, material, sqliteGeneration)
    } catch (error) {
      if (error instanceof StateCommitUncertainError && lease) {
        const reconciled = await this.reconcile(sessionId).catch(() => null)
        if (reconciled === null) throw error
        const observed = await this.stateStore.load(sessionId).catch(() => null)
        if (material && observed?.activeKeyId === material.keyId && observed.writerLeaseToken === lease.token && observed.writerLeaseGeneration === lease.generation && observed.lifecycleGeneration === lease.lifecycleGeneration) {
          return new SessionWriter(this, sessionId, lease, material, sqliteGeneration)
        }
      }
      if (material) {
        await this.keyStore.deactivateEpoch(material.keyId).catch(() => {})
        await this.keyStore.markOrphaned(material.keyId).catch(() => {})
      }
      if (lease) await this.leaseStore.release(lease).catch(() => {})
      throw error
    }
  }

  async reconcile(sessionId: string): Promise<SessionReconciliationResult> {
    validateSessionId(sessionId)
    await this.requireAvailable()
    const state = await this.stateStore.load(sessionId)
    const liveLease = await this.leaseStore.get(sessionId)
    const result: SessionReconciliationResult = {
      downgradedKeyIds: [],
      cryptographicallyErasedKeyIds: [],
      orphanedKeyIds: [],
      destroyedKeyIds: [],
    }
    const nextState = state ? cloneState(state) : null
    if (!state) {
      const cutoff = this.now() - this.orphanGraceMs
      for (const epoch of await this.keyStore.listEpochs(sessionId)) {
        await this.keyStore.markOrphaned(epoch.keyId)
        result.orphanedKeyIds.push(epoch.keyId)
        if (epoch.createdAt <= cutoff) {
          await this.keyStore.destroyEpoch(epoch.keyId)
          result.destroyedKeyIds.push(epoch.keyId)
        }
      }
      return result
    }
    if (state.lifecycleState === 'deleted') {
      await this.keyStore.invalidateLifecycle(sessionId, state.lifecycleGeneration)
      for (const epoch of await this.keyStore.listEpochs(sessionId)) await this.keyStore.destroyEpoch(epoch.keyId)
      if (liveLease?.kind === 'deletion') await this.leaseStore.release(liveLease)
      return result
    }
    if (state.activeKeyId && (!liveLease || liveLease.token !== state.writerLeaseToken || liveLease.generation !== state.writerLeaseGeneration || liveLease.expiresAt <= this.now())) {
      await this.keyStore.markDecryptOnly(state.activeKeyId)
      nextState!.activeKeyEpoch = null
      nextState!.activeKeyId = null
      nextState!.writerOwnerId = null
      nextState!.writerLeaseToken = null
      nextState!.writerLeaseGeneration = null
      result.downgradedKeyIds.push(state.activeKeyId)
    }
    if (state.activeKeyId && !(await this.keyStore.getEpoch(state.activeKeyId))) {
      await this.stateStore.markCryptographicallyErased(sessionId, state.activeKeyId)
      if (!nextState!.cryptographicallyErasedKeyIds.includes(state.activeKeyId)) nextState!.cryptographicallyErasedKeyIds.push(state.activeKeyId)
      nextState!.activeKeyEpoch = null
      nextState!.activeKeyId = null
      result.cryptographicallyErasedKeyIds.push(state.activeKeyId)
    }
    const committed = new Set(nextState!.committedKeyIds)
    const cutoff = this.now() - this.orphanGraceMs
    for (const epoch of await this.keyStore.listEpochs(sessionId)) {
      if (committed.has(epoch.keyId)) continue
      await this.keyStore.markOrphaned(epoch.keyId)
      result.orphanedKeyIds.push(epoch.keyId)
      if (epoch.createdAt <= cutoff) {
        await this.keyStore.destroyEpoch(epoch.keyId)
        result.destroyedKeyIds.push(epoch.keyId)
      }
    }
    await this.commitState({
      requestId: `session-crypto-reconcile:${sessionId}:${state.lifecycleGeneration}:${randomUUID()}`,
      action: 'reconcile',
      state: nextState!,
      expectedFence: stateFence(state),
      lease: liveLease,
      epochKeyId: nextState!.activeKeyId,
      epochKeyEpoch: nextState!.activeKeyEpoch,
    })
    return result
  }

  async deleteSession(sessionId: string): Promise<void> {
    validateSessionId(sessionId)
    await this.requireAvailable()
    const deletionLease = await this.leaseStore.acquireDeletionFence(sessionId, `${this.ownerId}:${randomUUID()}`, this.now(), this.leaseTtlMs)
    assertLiveLease(deletionLease, this.now())
    assertDeletionLease(deletionLease)
    const state = await this.stateStore.load(sessionId)
    if (state?.lifecycleState === 'deleted') {
      for (const epoch of await this.keyStore.listEpochs(sessionId)) await this.keyStore.destroyEpoch(epoch.keyId)
      await this.leaseStore.release(deletionLease)
      return
    }
    const tombstone: SessionCryptoState = {
      sessionId,
      activeKeyEpoch: null,
      activeKeyId: null,
      writerOwnerId: null,
      writerLeaseToken: null,
      writerLeaseGeneration: null,
      sqliteGeneration: state?.sqliteGeneration ?? 0n,
      lastKeyEpoch: state?.lastKeyEpoch ?? 0n,
      committedKeyIds: [...(state?.committedKeyIds ?? [])],
      cryptographicallyErasedKeyIds: [...(state?.cryptographicallyErasedKeyIds ?? [])],
      lifecycleGeneration: deletionLease.lifecycleGeneration,
      lifecycleState: 'deleted',
      deletionLeaseToken: deletionLease.token,
      deletionLeaseGeneration: deletionLease.generation,
    }
    try {
      await this.commitState({
        requestId: `session-crypto-delete:${sessionId}:${deletionLease.lifecycleGeneration}`,
        action: 'delete',
        state: tombstone,
        expectedFence: stateFence(state),
        lease: deletionLease,
        epochKeyId: null,
        epochKeyEpoch: null,
      })
    } catch (error) {
      if (error instanceof StateCommitError) await this.leaseStore.release(deletionLease)
      throw error
    }
    await this.keyStore.invalidateLifecycle(sessionId, deletionLease.lifecycleGeneration)
    for (const epoch of await this.keyStore.listEpochs(sessionId)) await this.keyStore.destroyEpoch(epoch.keyId)
    await this.leaseStore.release(deletionLease)
  }

  async recoverWriter(writer: SessionWriter, sqliteGeneration: bigint): Promise<SessionWriter> {
    validateSessionId(writer.sessionId)
    await this.requireAvailable()
    const state = await this.stateStore.load(writer.sessionId)
    if (!state || state.activeKeyId !== writer.epoch.keyId || state.writerLeaseToken !== writer.lease.token || state.writerLeaseGeneration !== writer.lease.generation) {
      throw new SessionCryptoRollbackError()
    }
    await this.closeWriter(writer)
    return this.acquireWriter(writer.sessionId, sqliteGeneration)
  }

  async decrypt(sessionId: string, frame: EncryptedFrame): Promise<Uint8Array> {
    validateSessionId(sessionId)
    await this.requireAvailable()
    if (frame.metadata.sessionId !== sessionId) throw new Error('encrypted frame session scope mismatch')
    const state = await this.stateStore.load(sessionId)
    if (lifecycleState(state) !== 'active') throw new SessionDeletedError()
    const epoch = await this.keyStore.getEpoch(frame.metadata.keyId)
    if (!epoch || epoch.state === 'destroyed') {
      await this.stateStore.markCryptographicallyErased(sessionId, frame.metadata.keyId)
      throw new KeyMaterialUnavailableError(frame.metadata.keyId)
    }
    if (epoch.sessionId !== sessionId || epoch.keyId !== frame.metadata.keyId) throw new Error('encrypted frame session identity mismatch')
    if (epoch.keyEpoch.toString(10) !== frame.metadata.keyEpoch) throw new Error('encrypted frame key epoch mismatch')
    return decryptEncryptedFrame({ key: epoch.encryptionKey, frame })
  }

  async closeWriter(writer: SessionWriter): Promise<void> {
    const current = await this.stateStore.load(writer.sessionId)
    await this.keyStore.deactivateEpoch(writer.epoch.keyId)
    await this.keyStore.markDecryptOnly(writer.epoch.keyId)
    if (current?.writerLeaseToken === writer.lease.token && current.writerLeaseGeneration === writer.lease.generation) {
      await this.commitState({
        requestId: `session-crypto-close:${writer.sessionId}:${writer.epoch.keyId}:${writer.lease.generation}`,
        action: 'close',
        state: {
        ...current,
        activeKeyEpoch: null,
        activeKeyId: null,
        writerOwnerId: null,
        writerLeaseToken: null,
        writerLeaseGeneration: null,
        },
        expectedFence: leaseFence(writer.lease),
        lease: writer.lease,
        epochKeyId: writer.epoch.keyId,
        epochKeyEpoch: writer.epoch.keyEpoch,
      })
    }
    await this.leaseStore.release(writer.lease)
  }

  async encryptForWriter(writer: SessionWriter, input: SessionFrameInput): Promise<EncryptedFrame> {
    await this.requireAvailable()
    assertWriterLease(writer.lease)
    assertLiveLease(writer.lease, this.now())
    const liveLease = await this.leaseStore.get(writer.sessionId)
    if (!liveLease || liveLease.token !== writer.lease.token || liveLease.generation !== writer.lease.generation || liveLease.expiresAt !== writer.lease.expiresAt) {
      throw new SessionWriterLeaseError('session writer lease is no longer current')
    }
    const state = await this.stateStore.load(writer.sessionId)
    if (!state || lifecycleState(state) !== 'active' || state.lifecycleGeneration !== writer.epoch.lifecycleGeneration || state.activeKeyId !== writer.epoch.keyId || state.writerLeaseToken !== writer.lease.token || state.writerLeaseGeneration !== writer.lease.generation || state.activeKeyEpoch !== writer.epoch.keyEpoch || state.sqliteGeneration !== writer.sqliteGeneration) {
      throw new SessionCryptoRollbackError()
    }
    const epoch = await this.keyStore.getEpoch(writer.epoch.keyId)
    if (!epoch || epoch.state !== 'encrypt_and_decrypt') throw new KeyMaterialUnavailableError(writer.epoch.keyId)
    const reservation = await this.keyStore.reserveNonceRange({
      sessionId: writer.sessionId,
      keyEpoch: writer.epoch.keyEpoch,
      keyId: writer.epoch.keyId,
      lease: writer.lease,
      count: 1n,
      lifecycleGeneration: writer.epoch.lifecycleGeneration,
    })
    if (reservation.sessionId !== writer.sessionId || reservation.keyEpoch !== writer.epoch.keyEpoch || reservation.keyId !== writer.epoch.keyId || reservation.leaseGeneration !== writer.lease.generation || reservation.leaseToken !== writer.lease.token || reservation.count !== 1n || reservation.lifecycleGeneration !== writer.epoch.lifecycleGeneration) {
      throw new SessionWriterLeaseError('invalid nonce reservation returned by credential store')
    }
    const metadata: EncryptedFrameMetadataInput = {
      formatVersion: 'session-frame-v1',
      sessionId: writer.sessionId,
      projectScopeId: input.projectScopeId,
      keyEpoch: writer.epoch.keyEpoch.toString(10),
      keyId: writer.epoch.keyId,
      artifactKind: input.artifactKind,
      artifactId: input.artifactId,
      contentEncoding: input.contentEncoding ?? 'binary',
      timestamp: (input.timestamp ?? BigInt(this.now())).toString(10),
    }
    const frame = encryptEncryptedFrame({
      key: epoch.encryptionKey,
      noncePrefix32: epoch.noncePrefix32,
      nonceCounter: reservation.startCounter,
      metadata,
      plaintext: input.plaintext,
      maxPlaintextBytes: input.maxPlaintextBytes,
      maxEnvelopeBytes: input.maxEnvelopeBytes,
    })
    await this.keyStore.validateNonceReservation(reservation)
    const finalState = await this.stateStore.load(writer.sessionId)
    if (!finalState || lifecycleState(finalState) !== 'active' || finalState.lifecycleGeneration !== writer.epoch.lifecycleGeneration) throw new SessionDeletedError()
    const finalLease = await this.leaseStore.get(writer.sessionId)
    if (!finalLease || finalLease.token !== writer.lease.token || finalLease.generation !== writer.lease.generation) throw new SessionWriterLeaseError('session writer lease is no longer current')
    return frame
  }

  private async requireAvailable(): Promise<void> {
    if (!this.keyStore.available || !this.optionsConfigured()) throw new SessionCryptoUnavailableError()
    assertReservationContract(this.keyStore)
    if (!(await this.keyStore.verifyNonceReservationContract())) throw new SessionCryptoUnavailableError()
  }

  private async commitState(input: StateCommitInput | StateCommitRequest): Promise<StateCommitResult> {
    const request = 'requestHash' in input ? input : createStateCommitRequest(input)
    let response: unknown
    try {
      response = await this.stateStore.commit(request)
    } catch {
      return this.resolveCommitAfterUnknown(request)
    }
    if (isAuthoritativeNotCommitted(response, request)) throw new StateCommitError(request.requestId)
    if (isMatchingCommitted(response, request)) return response
    return this.resolveCommitAfterUnknown(request)
  }

  private async resolveCommitAfterUnknown(request: StateCommitRequest): Promise<StateCommitResult> {
    let observed: unknown
    try {
      observed = await this.stateStore.lookupCommit(request.requestId, request.requestHash)
    } catch {
      throw new StateCommitUncertainError(request.requestId)
    }
    if (isAuthoritativeNotCommitted(observed, request)) throw new StateCommitError(request.requestId)
    if (isMatchingCommitted(observed, request)) return observed
    throw new StateCommitUncertainError(request.requestId)
  }

  private optionsConfigured(): boolean {
    return this.keyStore.available && this.stateStore !== undefined && this.leaseStore !== undefined
  }
}

export type SessionFrameInput = {
  projectScopeId: string
  artifactKind: string
  artifactId: string
  plaintext: Uint8Array
  contentEncoding?: 'binary' | 'utf8'
  timestamp?: bigint
  maxPlaintextBytes?: number
  maxEnvelopeBytes?: number
}

export class SessionWriter {
  private closed = false

  constructor(
    private readonly manager: SessionCryptoManager,
    readonly sessionId: string,
    readonly lease: SessionWriterLease,
    readonly epoch: CryptoEpochMaterial,
    readonly sqliteGeneration: bigint,
  ) {}

  async encrypt(input: SessionFrameInput): Promise<EncryptedFrame> {
    if (this.closed) throw new SessionWriterLeaseError('session writer is closed')
    return this.manager.encryptForWriter(this, input)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.manager.closeWriter(this)
  }

  async recover(sqliteGeneration: bigint): Promise<SessionWriter> {
    if (this.closed) throw new SessionWriterLeaseError('session writer is closed')
    this.closed = true
    return this.manager.recoverWriter(this, sqliteGeneration)
  }
}
