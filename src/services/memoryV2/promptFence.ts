import { randomUUID } from 'node:crypto'

import { isFeatureGateEnabled, type FeatureGateRequest } from './featureGates.js'

const MAX_GENERATION = (1n << 63n) - 1n

export type PromptFenceState =
  | 'BUILDING'
  | 'WAITING_FOR_LEASE'
  | 'ADMITTED'
  | 'SEND_COMMITTED'
  | 'SENT'
  | 'CANCELLED'
  | 'REVOKED_BEFORE_SEND'
  | 'FENCE_POISONED'

export type PromptSnapshotRecord = Readonly<{
  id: string
  projectScopeId: string
  content?: string
}>

export type PromptSnapshot = Readonly<{
  snapshotId: string
  projectScopeId: string
  storeGeneration: bigint
  snapshotGeneration: bigint
  promptEpoch: bigint
  records: readonly PromptSnapshotRecord[]
  maxPromptCharacters: number
  maxPromptTokens: number
}>

export type PromptFenceLease = Readonly<{
  token: string
  generation: bigint
  expiresAt: number
}>

export type PromptBudget = Readonly<{
  characters: number
  tokens: number
}>

export type PromptRequestInput = Readonly<{
  requestId: string
  payload: unknown
  snapshot: PromptSnapshot
  memoryRecordIds?: readonly string[]
  budget: PromptBudget
}>

export type PromptRequest = Readonly<{
  requestId: string
  payload: unknown
  snapshotId: string
  projectScopeId: string
  memoryRecordIds: readonly string[]
  budget: PromptBudget
  state: PromptFenceState
  preForget: boolean
}>

export type TransportOwnershipReceipt = Readonly<{
  accepted: true
  requestId: string
  payload: unknown
}>

export type SynchronousTransportQueue = Readonly<{
  enqueue(payload: unknown, requestId: string): TransportOwnershipReceipt | null
}>

export type PromptFenceOptions = Readonly<{
  gates?: FeatureGateRequest
  now?: () => number
  leaseDurationMs?: number
}>

export type MemoryForgetResult = Readonly<{
  storeGeneration: bigint
  promptEpoch: bigint
  revokedSnapshotIds: readonly string[]
  revokedRequestIds: readonly string[]
}>

export type SessionHistoryDeletion = Readonly<{
  closePromptAdmission: () => void | Promise<void>
  deleteSessionCrypto?: () => void | Promise<void>
  purgeEncryptedArtifacts?: () => void | Promise<void>
}>

type RequestRecord = {
  requestId: string
  payload: unknown
  snapshot: PromptSnapshot
  projectScopeId: string
  memoryRecordIds: readonly string[]
  budget: PromptBudget
  state: PromptFenceState
  preForget: boolean
}

export class PromptFenceDisabledError extends Error {
  constructor() {
    super('Memory V2 prompt snapshots are not enabled')
    this.name = 'PromptFenceDisabledError'
  }
}

export class PromptFenceStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptFenceStateError'
  }
}

export class StalePromptFenceError extends PromptFenceStateError {
  constructor() {
    super('Prompt admission fencing token or snapshot generation is stale')
    this.name = 'StalePromptFenceError'
  }
}

export class SnapshotRevokedError extends PromptFenceStateError {
  constructor() {
    super('Prompt snapshot was revoked by memory forgetting')
    this.name = 'SnapshotRevokedError'
  }
}

export class PromptFencePoisonedError extends PromptFenceStateError {
  constructor() {
    super('Prompt fence is poisoned and requires controlled session recovery')
    this.name = 'PromptFencePoisonedError'
  }
}

function assertGeneration(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_GENERATION) {
    throw new RangeError(`${field} must fit the bounded non-negative generation range`)
  }
}

function assertBudget(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`)
}

function freezePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const clone = structuredClone(payload)
  return deepFreeze(clone)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value as object)) {
    seen.add(value as object)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  }
  return value
}

export class PromptFence {
  private readonly gates: FeatureGateRequest
  private readonly now: () => number
  private readonly leaseDurationMs: number
  private readonly requests = new Map<string, RequestRecord>()
  private readonly snapshots = new Map<string, PromptSnapshot>()
  private readonly revokedSnapshots = new Set<string>()
  private readonly preDeleteRequestIds = new Set<string>()
  private currentStoreGeneration = 0n
  private currentPromptEpoch = 0n
  private nextSnapshotGeneration = 0n
  private nextFenceGeneration = 0n
  private lease: PromptFenceLease | null = null
  private poisoned = false
  private admissionClosed = false
  private historyDeleted = false

  constructor(options: PromptFenceOptions = {}) {
    this.gates = options.gates ?? {}
    this.now = options.now ?? Date.now
    this.leaseDurationMs = options.leaseDurationMs ?? 2_000
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0 || this.leaseDurationMs > 2_000) {
      throw new RangeError('Prompt fence lease duration must be between 1 and 2000 milliseconds')
    }
  }

  createSnapshot(input: {
    projectScopeId: string
    storeGeneration: bigint
    promptEpoch: bigint
    records: readonly PromptSnapshotRecord[]
    maxPromptCharacters: number
    maxPromptTokens: number
  }): PromptSnapshot {
    this.requireEnabled()
    this.requireAdmissionOpen()
    if (!input.projectScopeId) throw new TypeError('Prompt snapshot project scope is required')
    assertGeneration(input.storeGeneration, 'storeGeneration')
    assertGeneration(input.promptEpoch, 'promptEpoch')
    assertBudget(input.maxPromptCharacters, 'maxPromptCharacters')
    assertBudget(input.maxPromptTokens, 'maxPromptTokens')
    if (input.storeGeneration > this.currentStoreGeneration) this.currentStoreGeneration = input.storeGeneration
    if (input.promptEpoch > this.currentPromptEpoch) this.currentPromptEpoch = input.promptEpoch
    this.nextSnapshotGeneration = this.nextGeneration(this.nextSnapshotGeneration)
    const snapshotId = `snapshot-${this.nextSnapshotGeneration.toString(10)}-${randomUUID()}`
    if (input.records.some(record => !record.id || record.projectScopeId !== input.projectScopeId)) throw new StalePromptFenceError()
    const records = input.records.map(record => Object.freeze({
      id: record.id,
      projectScopeId: record.projectScopeId,
      ...(record.content === undefined ? {} : { content: record.content }),
    }))
    const snapshot = Object.freeze({
      snapshotId,
      projectScopeId: input.projectScopeId,
      storeGeneration: input.storeGeneration,
      snapshotGeneration: this.nextSnapshotGeneration,
      promptEpoch: input.promptEpoch,
      records: Object.freeze(records),
      maxPromptCharacters: input.maxPromptCharacters,
      maxPromptTokens: input.maxPromptTokens,
    })
    this.snapshots.set(snapshotId, snapshot)
    return snapshot
  }

  begin(input: PromptRequestInput): PromptRequest {
    this.requireEnabled()
    this.requireAdmissionOpen()
    if (!input.requestId || this.requests.has(input.requestId)) throw new PromptFenceStateError(`Prompt request already exists: ${input.requestId}`)
    if (this.snapshots.get(input.snapshot.snapshotId) !== input.snapshot) throw new StalePromptFenceError()
    assertBudget(input.budget.characters, 'prompt characters')
    assertBudget(input.budget.tokens, 'prompt tokens')
    const request: RequestRecord = {
      requestId: input.requestId,
      payload: freezePayload(input.payload),
      snapshot: input.snapshot,
      projectScopeId: input.snapshot.projectScopeId,
      memoryRecordIds: Object.freeze([...(input.memoryRecordIds ?? [])]),
      budget: Object.freeze({ ...input.budget }),
      state: 'BUILDING',
      preForget: false,
    }
    this.requests.set(request.requestId, request)
    return this.getRequest(request.requestId)
  }

  waitForLease(requestId: string): PromptRequest {
    this.requireAdmissionOpen()
    const request = this.requireRequest(requestId)
    if (request.state !== 'BUILDING') throw new PromptFenceStateError(`Request ${requestId} is not building`)
    request.state = 'WAITING_FOR_LEASE'
    return this.getRequest(requestId)
  }

  acquireLease(): PromptFenceLease {
    this.requireEnabled()
    this.requireAdmissionOpen()
    this.checkPoisoned()
    if (this.lease) {
      if (this.lease.expiresAt <= this.now()) {
        this.poisonFence()
        throw new PromptFencePoisonedError()
      }
      throw new PromptFenceStateError('Prompt fence lease is already held')
    }
    this.nextFenceGeneration = this.nextGeneration(this.nextFenceGeneration)
    this.lease = Object.freeze({
      token: randomUUID(),
      generation: this.nextFenceGeneration,
      expiresAt: this.now() + this.leaseDurationMs,
    })
    return this.lease
  }

  admit(requestId: string, lease: PromptFenceLease): PromptRequest {
    this.requireAdmissionOpen()
    const request = this.requireRequest(requestId)
    this.assertLease(lease)
    if (request.state !== 'WAITING_FOR_LEASE') throw new PromptFenceStateError(`Request ${requestId} is not waiting for a lease`)
    this.validateAdmission(request)
    request.state = 'ADMITTED'
    return this.getRequest(requestId)
  }

  commitSend(requestId: string, lease: PromptFenceLease, queue: SynchronousTransportQueue): TransportOwnershipReceipt | null {
    this.requireAdmissionOpen()
    const request = this.requireRequest(requestId)
    this.assertLease(lease)
    if (request.state !== 'ADMITTED') {
      if (request.state === 'REVOKED_BEFORE_SEND') throw new SnapshotRevokedError()
      throw new PromptFenceStateError(`Request ${requestId} is not admitted`)
    }
    this.validateAdmission(request)
    request.state = 'SEND_COMMITTED'
    try {
      const receipt = queue.enqueue(request.payload, request.requestId)
      if (receipt === null) {
        request.state = 'ADMITTED'
        return null
      }
      if (!Object.isFrozen(receipt) || receipt.accepted !== true || receipt.requestId !== request.requestId || receipt.payload !== request.payload) {
        request.preForget = true
        this.poisonFence()
        request.state = 'FENCE_POISONED'
        throw new PromptFencePoisonedError()
      }
      request.preForget = true
      return receipt
    } catch (error) {
      if (error instanceof PromptFencePoisonedError) throw error
      request.preForget = true
      this.poisonFence()
      request.state = 'FENCE_POISONED'
      throw new PromptFencePoisonedError()
    }
  }

  releaseLease(lease: PromptFenceLease): void {
    if (!this.lease || !this.sameLease(this.lease, lease)) throw new StalePromptFenceError()
    if (this.lease.expiresAt <= this.now()) {
      this.poisonFence()
      throw new PromptFencePoisonedError()
    }
    this.lease = null
  }

  markSent(requestId: string): PromptRequest {
    const request = this.requireRequest(requestId)
    if (request.state !== 'SEND_COMMITTED') throw new PromptFenceStateError(`Request ${requestId} is not send committed`)
    request.state = 'SENT'
    return this.getRequest(requestId)
  }

  forgetMemory(recordId: string, projectScopeId: string): MemoryForgetResult {
    this.requireEnabled()
    this.requireAdmissionOpen()
    if (!recordId || !projectScopeId) throw new TypeError('Memory record and project scope are required')
    this.currentStoreGeneration = this.nextGeneration(this.currentStoreGeneration)
    this.currentPromptEpoch = this.nextGeneration(this.currentPromptEpoch)
    const revokedSnapshotIds: string[] = []
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.projectScopeId !== projectScopeId) continue
      if (snapshot.records.some(record => record.id === recordId && record.projectScopeId === projectScopeId)) {
        this.revokedSnapshots.add(snapshot.snapshotId)
        revokedSnapshotIds.push(snapshot.snapshotId)
      }
    }
    const revokedRequestIds: string[] = []
    for (const request of this.requests.values()) {
      if (request.state !== 'ADMITTED') continue
      const affected = request.memoryRecordIds.includes(recordId) || this.revokedSnapshots.has(request.snapshot.snapshotId)
      if (affected && request.projectScopeId === projectScopeId) {
        request.state = 'REVOKED_BEFORE_SEND'
        revokedRequestIds.push(request.requestId)
      }
    }
    return Object.freeze({
      storeGeneration: this.currentStoreGeneration,
      promptEpoch: this.currentPromptEpoch,
      revokedSnapshotIds: Object.freeze(revokedSnapshotIds),
      revokedRequestIds: Object.freeze(revokedRequestIds),
    })
  }

  recoverPoisonedFence(expectedGeneration: bigint): void {
    assertGeneration(expectedGeneration, 'fence generation')
    if (!this.poisoned || this.nextFenceGeneration !== expectedGeneration) throw new StalePromptFenceError()
    this.poisoned = false
    this.lease = null
    this.nextFenceGeneration = this.nextGeneration(this.nextFenceGeneration)
  }

  async deleteSessionHistory(deletion: SessionHistoryDeletion): Promise<void> {
    if (this.historyDeleted) return
    this.admissionClosed = true
    for (const request of this.requests.values()) {
      if (request.state === 'SEND_COMMITTED' || request.state === 'SENT' || request.preForget) {
        this.preDeleteRequestIds.add(request.requestId)
      } else if (request.state === 'ADMITTED') {
        request.state = 'REVOKED_BEFORE_SEND'
      } else if (request.state !== 'FENCE_POISONED' && request.state !== 'CANCELLED') {
        request.state = 'CANCELLED'
      }
    }
    if (typeof deletion.closePromptAdmission !== 'function' || typeof deletion.deleteSessionCrypto !== 'function' || typeof deletion.purgeEncryptedArtifacts !== 'function') {
      throw new PromptFenceStateError('Session history deletion is unavailable and has been refused')
    }
    try {
      await deletion.closePromptAdmission()
      await deletion.deleteSessionCrypto()
      await deletion.purgeEncryptedArtifacts()
      this.historyDeleted = true
      this.requests.clear()
      this.snapshots.clear()
      this.revokedSnapshots.clear()
    } catch (error) {
      this.admissionClosed = true
      throw error
    }
  }

  getRequest(requestId: string): PromptRequest {
    if (this.admissionClosed || this.historyDeleted) throw new PromptFenceStateError('Prompt request access is closed')
    const request = this.requireRequest(requestId)
    return Object.freeze({
      requestId: request.requestId,
      payload: request.payload,
      snapshotId: request.snapshot.snapshotId,
      projectScopeId: request.projectScopeId,
      memoryRecordIds: request.memoryRecordIds,
      budget: request.budget,
      state: request.state,
      preForget: request.preForget,
    })
  }

  getPreForgetRequests(): string[] {
    return [...new Set([
      ...this.preDeleteRequestIds,
      ...[...this.requests.values()].filter(request => request.preForget).map(request => request.requestId),
    ])]
  }

  getPreDeleteRequests(): string[] {
    return [...this.preDeleteRequestIds]
  }

  isHistoryDeleted(): boolean {
    return this.historyDeleted
  }

  isAdmissionOpen(): boolean {
    return !this.admissionClosed && !this.historyDeleted
  }

  getGenerations(): Readonly<{ storeGeneration: bigint; promptEpoch: bigint }> {
    return Object.freeze({ storeGeneration: this.currentStoreGeneration, promptEpoch: this.currentPromptEpoch })
  }

  isSnapshotLive(snapshot: PromptSnapshot): boolean {
    return !this.admissionClosed && !this.historyDeleted && this.snapshots.get(snapshot.snapshotId) === snapshot && !this.revokedSnapshots.has(snapshot.snapshotId) && snapshot.storeGeneration === this.currentStoreGeneration && snapshot.promptEpoch === this.currentPromptEpoch
  }

  closePromptAdmission(): void {
    this.admissionClosed = true
  }

  private requireEnabled(): void {
    if (!isFeatureGateEnabled('MEMORY_HOT_SNAPSHOT', this.gates)) throw new PromptFenceDisabledError()
  }

  private requireAdmissionOpen(): void {
    if (this.admissionClosed || this.historyDeleted) throw new PromptFenceStateError('Prompt admission is closed')
  }

  private checkPoisoned(): void {
    if (this.poisoned) throw new PromptFencePoisonedError()
  }

  private requireRequest(requestId: string): RequestRecord {
    const request = this.requests.get(requestId)
    if (!request) throw new PromptFenceStateError(`Unknown prompt request: ${requestId}`)
    return request
  }

  private assertLease(lease: PromptFenceLease): void {
    this.checkPoisoned()
    if (!this.lease || !this.sameLease(this.lease, lease)) throw new StalePromptFenceError()
    if (this.lease.expiresAt <= this.now()) {
      this.poisonFence()
      throw new PromptFencePoisonedError()
    }
  }

  private validateAdmission(request: RequestRecord): void {
    if (this.revokedSnapshots.has(request.snapshot.snapshotId)) {
      request.state = 'REVOKED_BEFORE_SEND'
      throw new SnapshotRevokedError()
    }
    if (request.snapshot.storeGeneration !== this.currentStoreGeneration || request.snapshot.promptEpoch !== this.currentPromptEpoch) {
      throw new StalePromptFenceError()
    }
    if (request.snapshot.projectScopeId !== request.projectScopeId || request.budget.characters > request.snapshot.maxPromptCharacters || request.budget.tokens > request.snapshot.maxPromptTokens) {
      throw new StalePromptFenceError()
    }
  }

  private sameLease(left: PromptFenceLease, right: PromptFenceLease): boolean {
    return left.token === right.token && left.generation === right.generation && left.expiresAt === right.expiresAt
  }

  private poisonFence(): void {
    this.poisoned = true
    this.lease = null
    for (const request of this.requests.values()) {
      if (request.state === 'BUILDING' || request.state === 'WAITING_FOR_LEASE' || request.state === 'ADMITTED') request.state = 'FENCE_POISONED'
    }
  }

  private nextGeneration(value: bigint): bigint {
    if (value >= MAX_GENERATION) throw new PromptFenceStateError('Prompt fence generation exhausted')
    return value + 1n
  }
}
