import { sha256Canonical } from './canonical.js'

export type MemoryProviderCapabilities = Readonly<{
  stableEntryIds: boolean
  monotonicRevisions: boolean
  idempotentUpsert: boolean
  idempotentDelete: boolean
  durableTombstones: boolean
  echoesScopeAndNamespaceEpoch: boolean
}>

export type ProviderOperation = 'upsert' | 'delete'

export type ProviderRequest = Readonly<{
  providerId: string
  projectScopeId: string
  providerNamespaceId: string
  namespaceEpoch: bigint
  operationSequence: bigint
  requestId: string
  operation: ProviderOperation
  entryId: string
  revision: bigint
  payload?: unknown
}>

export type ProviderResponse = Readonly<{
  providerId: string
  projectScopeId: string
  providerNamespaceId: string
  namespaceEpoch: bigint
  operationSequence: bigint
  requestId: string
  entryId: string
  revision: bigint
}>

export type ProviderRequestState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export type ProviderOutboxState = 'queued' | 'claimed'

export type ProviderDurableOutboxEntry = Readonly<{
  request: ProviderRequest
  requestHash: string
  state: ProviderOutboxState
}>

export type ProviderDurability = Readonly<{
  readSequenceHighwater(scopeKey: string): bigint | undefined
  readCompletedRequestHash(requestKey: string): string | undefined
  commitCompletion(scopeKey: string, operationSequence: bigint, requestKey: string, requestHash: string): void
  readOutboxEntries(): readonly ProviderDurableOutboxEntry[]
  putOutboxEntry(entry: ProviderDurableOutboxEntry): void
  setOutboxState(requestKey: string, state: ProviderOutboxState): void
}>

export class MemoryProviderContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryProviderContractError'
  }
}

export function assertProviderCapabilities(capabilities: MemoryProviderCapabilities): void {
  const missing = Object.entries(capabilities).filter(([, supported]) => supported !== true).map(([name]) => name)
  if (missing.length > 0) throw new MemoryProviderContractError(`Automatic memory mirroring requires: ${missing.join(', ')}`)
}

export function canAutomaticallyMirrorProvider(capabilities: MemoryProviderCapabilities): boolean {
  try {
    assertProviderCapabilities(capabilities)
    return true
  } catch {
    return false
  }
}

function assertNonNegativeInteger(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw new MemoryProviderContractError(`${field} must be a non-negative integer`)
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new MemoryProviderContractError(`${field} is required`)
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value as object)) {
    seen.add(value as object)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child, seen)
  }
  return value
}

function immutableRequest(request: ProviderRequest): ProviderRequest {
  const copy = structuredClone(request)
  return freezeValue(copy)
}

function hashRequest(request: ProviderRequest): string {
  return sha256Canonical({
    ...request,
    namespaceEpoch: request.namespaceEpoch.toString(10),
    operationSequence: request.operationSequence.toString(10),
    revision: request.revision.toString(10),
  })
}

function assertRequest(request: ProviderRequest): void {
  assertIdentity(request.providerId, 'provider ID')
  assertIdentity(request.projectScopeId, 'project scope ID')
  assertIdentity(request.providerNamespaceId, 'provider namespace ID')
  assertIdentity(request.requestId, 'request ID')
  assertIdentity(request.entryId, 'entry ID')
  assertNonNegativeInteger(request.namespaceEpoch, 'namespace epoch')
  assertNonNegativeInteger(request.operationSequence, 'operation sequence')
  assertNonNegativeInteger(request.revision, 'revision')
}

export function providerScopeKey(request: Pick<ProviderRequest, 'providerId' | 'projectScopeId' | 'providerNamespaceId'>): string {
  return `${request.providerId}\u0000${request.projectScopeId}\u0000${request.providerNamespaceId}`
}

export function providerRequestKey(request: Pick<ProviderRequest, 'providerId' | 'projectScopeId' | 'providerNamespaceId' | 'requestId'>): string {
  return `${providerScopeKey(request)}\u0000${request.requestId}`
}

export class NamespaceEpochFence {
  private epoch: bigint

  constructor(initialEpoch = 0n) {
    assertNonNegativeInteger(initialEpoch, 'namespace epoch')
    this.epoch = initialEpoch
  }

  current(): bigint {
    return this.epoch
  }

  advance(): bigint {
    this.epoch += 1n
    return this.epoch
  }
}

export function acceptProviderResponse(
  request: ProviderRequest,
  response: ProviderResponse,
  fence: NamespaceEpochFence,
  registry: ProviderRequestRegistry,
): true {
  if (!registry) throw new MemoryProviderContractError('A live provider request registry is required')
  return registry.accept(request, response, fence)
}

function validateProviderResponse(
  request: ProviderRequest,
  response: ProviderResponse,
  fence: NamespaceEpochFence,
): true {
  for (const [field, value] of Object.entries(request)) {
    if (field === 'operation' || field === 'payload') continue
    if (!Object.is(value, response[field as keyof ProviderResponse])) {
      throw new MemoryProviderContractError(`Provider response mismatch for ${field}`)
    }
  }
  if (response.namespaceEpoch !== fence.current()) throw new MemoryProviderContractError('Provider response namespace epoch is stale')
  return true
}

export function acceptAndRetireProviderResponse(
  registry: ProviderRequestRegistry,
  request: ProviderRequest,
  response: ProviderResponse,
  fence: NamespaceEpochFence,
): true {
  return registry.accept(request, response, fence)
}

export class ProviderRevisionTracker {
  private readonly revisions = new Map<string, bigint>()

  observe(request: ProviderRequest): void {
    assertRequest(request)
    const key = `${request.providerId}\u0000${request.projectScopeId}\u0000${request.providerNamespaceId}\u0000${request.entryId}`
    const previous = this.revisions.get(key)
    if (previous !== undefined && request.revision < previous) {
      throw new MemoryProviderContractError('Provider revision moved backwards')
    }
    if (previous === undefined || request.revision > previous) this.revisions.set(key, request.revision)
  }

  revisionFor(request: ProviderRequest): bigint | undefined {
    const key = `${request.providerId}\u0000${request.projectScopeId}\u0000${request.providerNamespaceId}\u0000${request.entryId}`
    return this.revisions.get(key)
  }

  assertResponseRevision(request: ProviderRequest, response: ProviderResponse): void {
    const current = this.revisionFor(request)
    if (response.revision !== request.revision || current !== request.revision) {
      throw new MemoryProviderContractError('Provider response revision does not match the live high-water revision')
    }
  }
}

type PendingProviderRequest = Readonly<{
  request: ProviderRequest
  hash: string
  state: ProviderRequestState
}>

export class ProviderRequestRegistry {
  private readonly entries = new Map<string, PendingProviderRequest>()
  private readonly revisions: ProviderRevisionTracker

  constructor(revisions = new ProviderRevisionTracker()) {
    this.revisions = revisions
  }

  register(request: ProviderRequest): void {
    assertRequest(request)
    const immutable = immutableRequest(request)
    const hash = hashRequest(immutable)
    const existing = this.entries.get(request.requestId)
    if (existing) {
      if (existing.hash !== hash) throw new MemoryProviderContractError('Provider request ID was reused with a different request')
      return
    }
    this.revisions.observe(immutable)
    this.entries.set(request.requestId, Object.freeze({ request: immutable, hash, state: 'pending' }))
  }

  accept(request: ProviderRequest, response: ProviderResponse, fence: NamespaceEpochFence): true {
    const pending = this.entries.get(request.requestId)
    if (!pending || pending.state !== 'pending') throw new MemoryProviderContractError('Provider request is no longer pending')
    if (pending.hash !== hashRequest(request)) throw new MemoryProviderContractError('Provider request does not match the registered request')
    this.revisions.assertResponseRevision(pending.request, response)
    validateProviderResponse(pending.request, response, fence)
    this.entries.set(request.requestId, Object.freeze({ ...pending, state: 'succeeded' }))
    return true
  }

  retire(requestId: string, state: Exclude<ProviderRequestState, 'pending' | 'succeeded'>): void {
    const pending = this.entries.get(requestId)
    if (!pending || pending.state !== 'pending') throw new MemoryProviderContractError('Provider request is no longer pending')
    this.entries.set(requestId, Object.freeze({ ...pending, state }))
  }

  state(requestId: string): ProviderRequestState | undefined {
    return this.entries.get(requestId)?.state
  }
}

export class ProviderSequenceHighwater {
  private readonly values = new Map<string, bigint>()
  private readonly requestHashes = new Map<string, string>()
  private readonly durability: ProviderDurability | undefined

  constructor(durability?: ProviderDurability) {
    this.durability = durability
  }

  isDurable(): boolean {
    return this.durability !== undefined
  }

  current(request: ProviderRequest): bigint | undefined {
    const key = this.key(request)
    const local = this.values.get(key)
    if (local !== undefined) return local
    const persisted = this.durability?.readSequenceHighwater(key)
    if (persisted !== undefined) this.values.set(key, persisted)
    return persisted
  }

  assertAvailable(request: ProviderRequest): void {
    const current = this.current(request)
    if (current !== undefined && request.operationSequence <= current) {
      throw new MemoryProviderContractError('Provider operation sequence is not above the permanent high-water mark')
    }
  }

  advance(request: ProviderRequest): void {
    this.assertAvailable(request)
    this.values.set(this.key(request), request.operationSequence)
  }

  completedHash(request: ProviderRequest): string | undefined {
    const key = providerRequestKey(request)
    const local = this.requestHashes.get(key)
    if (local !== undefined) return local
    const persisted = this.durability?.readCompletedRequestHash(key)
    if (persisted !== undefined) this.requestHashes.set(key, persisted)
    return persisted
  }

  remember(request: ProviderRequest, hash: string): void {
    const key = providerRequestKey(request)
    if (this.durability) {
      this.durability.commitCompletion(this.key(request), request.operationSequence, key, hash)
      this.values.set(this.key(request), request.operationSequence)
    }
    this.requestHashes.set(key, hash)
  }

  readOutboxEntries(): readonly ProviderDurableOutboxEntry[] {
    return this.durability?.readOutboxEntries() ?? []
  }

  putOutboxEntry(entry: ProviderDurableOutboxEntry): void {
    this.durability?.putOutboxEntry(entry)
  }

  setOutboxState(request: ProviderRequest, state: ProviderOutboxState): void {
    this.durability?.setOutboxState(providerRequestKey(request), state)
  }

  private key(request: ProviderRequest): string {
    return providerScopeKey(request)
  }
}

export class ProviderOutbox {
  private readonly entries = new Map<string, { request: ProviderRequest; hash: string; state: 'queued' | 'claimed' }>()
  private readonly completed = new Map<string, string>()
  private readonly highwater: ProviderSequenceHighwater
  private claimedRequestKey: string | null = null

  constructor(highwater?: ProviderSequenceHighwater) {
    if (!highwater) throw new MemoryProviderContractError('Automatic provider mirroring requires authoritative durable replay state')
    this.highwater = highwater
    this.requireDurable()
    for (const persisted of this.highwater.readOutboxEntries()) {
      assertRequest(persisted.request)
      const request = immutableRequest(persisted.request)
      const hash = hashRequest(request)
      if (hash !== persisted.requestHash) throw new MemoryProviderContractError('Durable provider outbox request hash is invalid')
      const requestKey = providerRequestKey(request)
      if (this.highwater.completedHash(request) === hash) continue
      const state: ProviderOutboxState = persisted.state === 'claimed' ? 'queued' : persisted.state
      if (state !== persisted.state) this.highwater.setOutboxState(request, state)
      const existing = this.entries.get(requestKey)
      if (existing && existing.hash !== hash) throw new MemoryProviderContractError('Provider request ID was reused with a different request')
      if (!existing) this.entries.set(requestKey, { request, hash, state })
    }
  }

  requireDurable(): void {
    if (!this.highwater.isDurable()) throw new MemoryProviderContractError('Automatic provider mirroring requires authoritative durable replay state')
  }

  enqueue(request: ProviderRequest): void {
    assertRequest(request)
    const immutable = immutableRequest(request)
    const hash = hashRequest(immutable)
    const requestKey = providerRequestKey(immutable)
    const durableCompletedHash = this.highwater.completedHash(immutable)
    if (durableCompletedHash) {
      if (durableCompletedHash !== hash) throw new MemoryProviderContractError('Provider request ID was reused with a different request')
      return
    }
    const completedHash = this.completed.get(requestKey)
    if (completedHash) {
      if (completedHash !== hash) throw new MemoryProviderContractError('Provider request ID was reused with a different request')
      return
    }
    const existing = this.entries.get(requestKey)
    if (existing) {
      if (existing.hash !== hash) throw new MemoryProviderContractError('Provider request ID was reused with a different request')
      return
    }
    const scopeKey = providerScopeKey(immutable)
    if ([...this.entries.values()].some(entry => providerScopeKey(entry.request) === scopeKey && entry.request.operationSequence === request.operationSequence)) {
      throw new MemoryProviderContractError('Provider operation sequence was reused')
    }
    this.highwater.assertAvailable(immutable)
    this.highwater.putOutboxEntry({ request: immutable, requestHash: hash, state: 'queued' })
    this.entries.set(requestKey, { request: immutable, hash, state: 'queued' })
  }

  claim(): ProviderRequest | null {
    if (this.claimedRequestKey !== null) return null
    const next = [...this.entries.values()]
      .filter(entry => entry.state === 'queued')
      .sort((left, right) => {
        const leftScope = providerScopeKey(left.request)
        const rightScope = providerScopeKey(right.request)
        return leftScope.localeCompare(rightScope) || (left.request.operationSequence < right.request.operationSequence ? -1 : left.request.operationSequence > right.request.operationSequence ? 1 : 0) || left.request.requestId.localeCompare(right.request.requestId)
      })[0]
    if (!next) return null
    next.state = 'claimed'
    try {
      this.highwater.setOutboxState(next.request, 'claimed')
      this.claimedRequestKey = providerRequestKey(next.request)
    } catch (error) {
      next.state = 'queued'
      throw error
    }
    return next.request
  }

  ack(request: ProviderRequest | string): void {
    const requestKey = this.resolveClaimedRequestKey(request)
    const entry = this.entries.get(requestKey)
    if (!entry || entry.state !== 'claimed' || this.claimedRequestKey !== requestKey) throw new MemoryProviderContractError('Provider request is not claimed')
    if (this.highwater.completedHash(entry.request) !== entry.hash) {
      this.highwater.advance(entry.request)
      this.highwater.remember(entry.request, entry.hash)
    }
    this.completed.set(requestKey, entry.hash)
    this.entries.delete(requestKey)
    this.claimedRequestKey = null
  }

  retry(request: ProviderRequest | string): void {
    const requestKey = this.resolveClaimedRequestKey(request)
    const entry = this.entries.get(requestKey)
    if (!entry || entry.state !== 'claimed' || this.claimedRequestKey !== requestKey) throw new MemoryProviderContractError('Provider request is not claimed')
    entry.state = 'queued'
    try {
      this.highwater.setOutboxState(entry.request, 'queued')
    } catch (error) {
      entry.state = 'claimed'
      throw error
    }
    this.claimedRequestKey = null
  }

  size(): number {
    return this.entries.size
  }

  private resolveClaimedRequestKey(request: ProviderRequest | string): string {
    if (typeof request !== 'string') return providerRequestKey(request)
    if (this.claimedRequestKey && this.entries.get(this.claimedRequestKey)?.request.requestId === request) return this.claimedRequestKey
    const matches = [...this.entries.entries()].filter(([, entry]) => entry.request.requestId === request)
    if (matches.length !== 1) throw new MemoryProviderContractError('Provider request scope is required for this request ID')
    return matches[0][0]
  }
}
