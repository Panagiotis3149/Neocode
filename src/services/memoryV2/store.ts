import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { sha256Canonical } from './canonical.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from './featureGates.js'
import { MEMORY_TYPE_CHAR_LIMITS, type MemoryType } from '../../memdir/memoryTypes.js'
import { scanForSecrets, type SecretMatch } from '../teamMemorySync/secretScanner.js'
import {
  MemoryProviderContractError,
  providerRequestKey,
  providerScopeKey,
  type ProviderDurability,
  type ProviderDurableOutboxEntry,
  type ProviderRequest,
  type ProviderOutboxState,
} from './provider.js'

export type MemoryStatus = 'active' | 'tombstoned'

export type MemoryRecord = {
  id: string
  projectScopeId: string
  type: MemoryType | string
  name: string
  description?: string
  content: string
  pinned: boolean
  version: number
  status: MemoryStatus
  createdAt: number
  updatedAt: number
}

export type MemoryRecordInput = {
  id: string
  projectScopeId: string
  type: MemoryType | string
  name: string
  description?: string
  content: string
  pinned?: boolean
}

export type MemoryRecordChanges = Partial<
  Pick<MemoryRecordInput, 'projectScopeId' | 'type' | 'name' | 'description' | 'content' | 'pinned'>
>

export type MemoryMutation =
  | {
      requestId: string
      operation: 'create'
      record: MemoryRecordInput
    }
  | {
      requestId: string
      operation: 'update'
      recordId: string
      projectScopeId: string
      expectedVersion?: number
      changes: MemoryRecordChanges
    }
  | {
      requestId: string
      operation: 'delete'
      recordId: string
      projectScopeId: string
      expectedVersion?: number
    }

export type MemoryReplayMetadata = {
  id: string
  projectScopeId: string
  version: number
  status: MemoryStatus
}

export type MemoryMutationResult = {
  requestId: string
  requestHash: string
  operation: MemoryMutation['operation']
  record: MemoryRecord | MemoryReplayMetadata
  replayed: boolean
}

export type MemoryV2StoreOptions = {
  dbPath?: string
  gates?: FeatureGateRequest
  maxRecords?: number
  maxTotalCharacters?: number
  maxTotalBytes?: number
  maxRecordCharacters?: number
  maxRecordBytes?: number
  tombstoneRetentionMs?: number
  requestRetentionMs?: number
  maintenanceBatchSize?: number
}

export type MemoryListOptions = {
  projectScopeId: string
  includeTombstones?: boolean
}

export class RequestReuseError extends Error {
  constructor(requestId: string) {
    super(`Request id has already been used with a different request: ${requestId}`)
    this.name = 'RequestReuseError'
  }
}

export class MemoryBudgetError extends Error {
  readonly budget: string

  constructor(budget: string) {
    super(`Memory budget exceeded: ${budget}`)
    this.name = 'MemoryBudgetError'
    this.budget = budget
  }
}

export class MemoryConflictError extends Error {
  readonly recordId: string
  readonly expectedVersion?: number
  readonly actualVersion?: number

  constructor(recordId: string, expectedVersion?: number, actualVersion?: number) {
    super(`Memory mutation conflict for ${recordId}`)
    this.name = 'MemoryConflictError'
    this.recordId = recordId
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class MemoryV2DisabledError extends Error {
  constructor() {
    super('Memory V2 store gate is not effective')
    this.name = 'MemoryV2DisabledError'
  }
}

export class AsyncTransactionError extends Error {
  constructor() {
    super('Memory V2 transactions cannot use async callbacks')
    this.name = 'AsyncTransactionError'
  }
}

export class SecretMemoryError extends Error {
  readonly matches: SecretMatch[]

  constructor(matches: SecretMatch[]) {
    super(`Automated memory mutation contains detected secrets: ${matches.map(match => match.ruleId).join(', ')}`)
    this.name = 'SecretMemoryError'
    this.matches = matches
  }
}

export type MemoryMaintenanceResult = {
  tombstonesRemoved: number
  requestsRemoved: number
}

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  transaction<T>(callback: () => T): () => T
  close(): void
}

type StoredRequest = {
  request_id: string
  request_hash: string
  operation: string
  record_id: string
  project_scope_id: string
  result_version: number
  result_status: MemoryStatus
  created_at: number
}

type StoredMemory = {
  id: string
  project_scope_id: string
  type: string
  name: string
  description: string | null
  content: string
  pinned: number
  version: number
  status: MemoryStatus
  created_at: number
  updated_at: number
}

type StoredProviderOutbox = {
  request_id: string
  scope_key: string
  request_hash: string
  request_json: string
  state: ProviderOutboxState
}

const DEFAULT_DB_PATH = ':memory:'
const DEFAULT_MAX_RECORDS = 10_000
const DEFAULT_MAX_TOTAL_CHARACTERS = 2_000_000
const DEFAULT_MAX_TOTAL_BYTES = 8_000_000
const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAINTENANCE_BATCH_SIZE = 256

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function recordCharacterCount(record: Pick<MemoryRecord, 'name' | 'description' | 'content'>): number {
  return characterCount(record.name) + characterCount(record.description ?? '') + characterCount(record.content)
}

function characterCount(value: string): number {
  return Array.from(value).length
}

function recordByteCount(record: Pick<MemoryRecord, 'name' | 'description' | 'content'>): number {
  return textBytes(record.name) + textBytes(record.description ?? '') + textBytes(record.content)
}

function validateRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256) {
    throw new TypeError('requestId must be a nonempty string of at most 256 characters')
  }
}

function validateRecordInput(record: MemoryRecordInput, maxRecordCharacters: number, maxRecordBytes: number): void {
  if (!record.id || !record.projectScopeId || !record.type || !record.name) {
    throw new TypeError('Memory records require id, projectScopeId, type, and name')
  }
  if (typeof record.content !== 'string') throw new TypeError('Memory content must be a string')
  const typeLimit = MEMORY_TYPE_CHAR_LIMITS[record.type as MemoryType]
  const characterLimit = typeLimit ?? maxRecordCharacters
  if (characterCount(record.content) > characterLimit) {
    throw new MemoryBudgetError(`record characters (${characterCount(record.content)} > ${characterLimit})`)
  }
  if (recordCharacterCount(record) > maxRecordCharacters) {
    throw new MemoryBudgetError(`record characters (${recordCharacterCount(record)} > ${maxRecordCharacters})`)
  }
  if (recordByteCount(record) > maxRecordBytes) {
    throw new MemoryBudgetError(`record bytes (${recordByteCount(record)} > ${maxRecordBytes})`)
  }
}

function serializeProviderRequest(request: ProviderRequest): string {
  return JSON.stringify({
    ...request,
    namespaceEpoch: request.namespaceEpoch.toString(10),
    operationSequence: request.operationSequence.toString(10),
    revision: request.revision.toString(10),
  })
}

function deserializeProviderRequest(raw: string): ProviderRequest {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new MemoryProviderContractError('Durable provider outbox request is corrupt')
  }
  try {
    return {
      ...parsed,
      namespaceEpoch: BigInt(parsed.namespaceEpoch as string),
      operationSequence: BigInt(parsed.operationSequence as string),
      revision: BigInt(parsed.revision as string),
    } as ProviderRequest
  } catch {
    throw new MemoryProviderContractError('Durable provider outbox request is corrupt')
  }
}

function fromRow(row: StoredMemory): MemoryRecord {
  return {
    id: row.id,
    projectScopeId: row.project_scope_id,
    type: row.type,
    name: row.name,
    description: row.description ?? undefined,
    content: row.content,
    pinned: row.pinned === 1,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MemoryV2Store {
  private readonly options: Required<MemoryV2StoreOptions>
  private db: SqliteDatabase | null = null
  private initialized = false
  private transactionDepth = 0

  constructor(options: MemoryV2StoreOptions = {}) {
    this.options = {
      dbPath: options.dbPath ?? DEFAULT_DB_PATH,
      gates: options.gates ?? {},
      maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS,
      maxTotalCharacters: options.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      maxRecordCharacters: options.maxRecordCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS,
      maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      tombstoneRetentionMs: options.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS,
      requestRetentionMs: options.requestRetentionMs ?? DEFAULT_REQUEST_RETENTION_MS,
      maintenanceBatchSize: options.maintenanceBatchSize ?? DEFAULT_MAINTENANCE_BATCH_SIZE,
    }
  }

  async init(): Promise<void> {
    if (this.initialized && this.db) return
    if (this.options.dbPath !== ':memory:') mkdirSync(dirname(this.options.dbPath), { recursive: true })
    if (typeof Bun === 'undefined') throw new Error('MemoryV2Store requires the Bun SQLite runtime')
    const { Database } = await import('bun:sqlite')
    this.db = new Database(this.options.dbPath) as unknown as SqliteDatabase
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = FULL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_v2_records (
        id TEXT PRIMARY KEY,
        project_scope_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'tombstoned')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_v2_records_scope_status
        ON memory_v2_records(project_scope_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_v2_tombstones (
        record_id TEXT PRIMARY KEY,
        deleted_version INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v2_burned_ids (
        record_id TEXT PRIMARY KEY,
        burned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v2_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        record_id TEXT NOT NULL,
        project_scope_id TEXT NOT NULL,
        result_version INTEGER NOT NULL,
        result_status TEXT NOT NULL CHECK (result_status IN ('active', 'tombstoned')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v2_provider_highwater (
        scope_key TEXT PRIMARY KEY,
        operation_sequence TEXT NOT NULL,
        request_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v2_provider_completed (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v2_provider_outbox (
        request_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'claimed'))
      );
    `)
    this.migrateLegacyRequestRows()
    this.initialized = true
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {}
    this.db.close()
    this.db = null
    this.initialized = false
  }

  providerDurability(): ProviderDurability {
    this.requireReady()
    this.requireEnabled()
    return {
      readSequenceHighwater: scopeKey => {
        this.requireReady()
        this.requireEnabled()
        const row = this.db!.prepare(
          'SELECT operation_sequence FROM memory_v2_provider_highwater WHERE scope_key = ?',
        ).get(scopeKey) as { operation_sequence: string } | null
        return row ? BigInt(row.operation_sequence) : undefined
      },
      readCompletedRequestHash: requestKey => {
        this.requireReady()
        this.requireEnabled()
        const row = this.db!.prepare(
          'SELECT request_hash FROM memory_v2_provider_completed WHERE request_id = ?',
        ).get(requestKey) as { request_hash: string } | null
        return row?.request_hash
      },
      commitCompletion: (scopeKey, operationSequence, requestKey, requestHash) => {
        this.requireReady()
        this.requireEnabled()
        if (!scopeKey || !requestKey || !requestHash || operationSequence < 0n) {
          throw new MemoryProviderContractError('Invalid durable provider completion')
        }
        this.db!.transaction(() => {
          const completed = this.db!.prepare(
            'SELECT request_hash FROM memory_v2_provider_completed WHERE request_id = ?',
          ).get(requestKey) as { request_hash: string } | null
          if (completed && completed.request_hash !== requestHash) {
            throw new MemoryProviderContractError('Provider request ID was reused with a different request')
          }
          const highwater = this.db!.prepare(
            'SELECT operation_sequence, request_id FROM memory_v2_provider_highwater WHERE scope_key = ?',
          ).get(scopeKey) as { operation_sequence: string; request_id: string } | null
          if (highwater) {
            const persistedSequence = BigInt(highwater.operation_sequence)
            if (operationSequence < persistedSequence) {
              throw new MemoryProviderContractError('Provider operation sequence is not above the permanent high-water mark')
            }
            if (operationSequence === persistedSequence && highwater.request_id !== requestKey) {
              throw new MemoryProviderContractError('Provider operation sequence was reused')
            }
          }
          if (!highwater || operationSequence > BigInt(highwater.operation_sequence)) {
            this.db!.prepare(
              'INSERT INTO memory_v2_provider_highwater (scope_key, operation_sequence, request_id) VALUES (?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET operation_sequence = excluded.operation_sequence, request_id = excluded.request_id',
            ).run(scopeKey, operationSequence.toString(10), requestKey)
          }
          if (!completed) {
            this.db!.prepare(
              'INSERT INTO memory_v2_provider_completed (request_id, request_hash) VALUES (?, ?)',
            ).run(requestKey, requestHash)
          }
          this.db!.prepare('DELETE FROM memory_v2_provider_outbox WHERE request_id = ?').run(requestKey)
        })()
      },
      readOutboxEntries: () => {
        this.requireReady()
        this.requireEnabled()
        const rows = this.db!.prepare(
          'SELECT request_hash, request_json, state FROM memory_v2_provider_outbox ORDER BY rowid ASC',
        ).all() as StoredProviderOutbox[]
        return rows.map(row => ({
          request: deserializeProviderRequest(row.request_json),
          requestHash: row.request_hash,
          state: row.state,
        }))
      },
      putOutboxEntry: entry => {
        this.requireReady()
        this.requireEnabled()
        const requestJson = serializeProviderRequest(entry.request)
        const scopeKey = providerScopeKey(entry.request)
        const requestKey = providerRequestKey(entry.request)
        const existing = this.db!.prepare(
          'SELECT request_hash, request_json FROM memory_v2_provider_outbox WHERE request_id = ?',
        ).get(requestKey) as Pick<StoredProviderOutbox, 'request_hash' | 'request_json'> | null
        if (existing) {
          if (existing.request_hash !== entry.requestHash || existing.request_json !== requestJson) {
            throw new MemoryProviderContractError('Provider request ID was reused with a different request')
          }
          return
        }
        this.db!.prepare(
          'INSERT INTO memory_v2_provider_outbox (request_id, scope_key, request_hash, request_json, state) VALUES (?, ?, ?, ?, ?)',
        ).run(requestKey, scopeKey, entry.requestHash, requestJson, entry.state)
      },
      setOutboxState: (requestKey, state) => {
        this.requireReady()
        this.requireEnabled()
        const result = this.db!.prepare(
          'UPDATE memory_v2_provider_outbox SET state = ? WHERE request_id = ?',
        ).run(state, requestKey) as { changes?: number }
        if (result?.changes === 0) throw new MemoryProviderContractError('Durable provider outbox entry is unavailable')
      },
    }
  }

  async transaction<T>(work: (transaction: { mutate: (mutation: MemoryMutation) => MemoryMutationResult }) => T): Promise<T> {
    this.requireReady()
    this.requireEnabled()
    if (this.transactionDepth > 0) {
      let active = true
      const transaction = {
        mutate: (mutation: MemoryMutation) => {
          if (!active) throw new Error('Memory V2 transaction is no longer active')
          return this.mutateInTransaction(mutation, 'automated')
        },
      }
      try {
        const result = work(transaction)
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          throw new AsyncTransactionError()
        }
        return result
      } finally {
        active = false
      }
    }
    const db = this.db!
    return db.transaction(() => {
      this.transactionDepth += 1
      let active = true
      const transaction = {
        mutate: (mutation: MemoryMutation) => {
          if (!active) throw new Error('Memory V2 transaction is no longer active')
          return this.mutateInTransaction(mutation, 'automated')
        },
      }
      try {
        const result = work(transaction)
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          throw new AsyncTransactionError()
        }
        return result
      } finally {
        this.transactionDepth -= 1
        active = false
      }
    })()
  }

  async mutate(mutation: MemoryMutation): Promise<MemoryMutationResult> {
    return this.mutateWithSource(mutation, 'automated')
  }

  async mutateManual(mutation: MemoryMutation): Promise<MemoryMutationResult> {
    return this.mutateWithSource(mutation, 'manual')
  }

  private async mutateWithSource(mutation: MemoryMutation, source: 'automated' | 'manual'): Promise<MemoryMutationResult> {
    this.requireReady()
    this.requireEnabled()
    if (this.transactionDepth > 0) return this.mutateInTransaction(mutation, source)
    return this.db!.transaction(() => {
      this.transactionDepth += 1
      try {
        return this.mutateInTransaction(mutation, source)
      } finally {
        this.transactionDepth -= 1
      }
    })()
  }

  async get(id: string, projectScopeId: string): Promise<MemoryRecord | null> {
    this.requireReady()
    this.requireEnabled()
    return this.getInternal(id, projectScopeId, false)
  }

  async getIncludingTombstone(id: string, projectScopeId: string): Promise<MemoryRecord | null> {
    this.requireReady()
    this.requireEnabled()
    return this.getInternal(id, projectScopeId, true)
  }

  async list(options: MemoryListOptions): Promise<MemoryRecord[]> {
    this.requireReady()
    this.requireEnabled()
    if (!options?.projectScopeId) throw new TypeError('projectScopeId is required')
    const clauses = options.includeTombstones ? ['1 = 1'] : ["status = 'active'"]
    const rows = this.db!.prepare(
      `SELECT * FROM memory_v2_records WHERE ${clauses.join(' AND ')} AND project_scope_id = ? ORDER BY updated_at DESC, id ASC`,
    ).all(options.projectScopeId) as StoredMemory[]
    return rows.map(fromRow)
  }

  listSync(options: MemoryListOptions): MemoryRecord[] {
    this.requireReady()
    this.requireEnabled()
    if (!options?.projectScopeId) throw new TypeError('projectScopeId is required')
    const clauses = options.includeTombstones ? ['1 = 1'] : ["status = 'active'"]
    const rows = this.db!.prepare(
      `SELECT * FROM memory_v2_records WHERE ${clauses.join(' AND ')} AND project_scope_id = ? ORDER BY updated_at DESC, id ASC`,
    ).all(options.projectScopeId) as StoredMemory[]
    return rows.map(fromRow)
  }

  async maintain(now = Date.now()): Promise<MemoryMaintenanceResult> {
    this.requireReady()
    this.requireEnabled()
    const tombstoneCutoff = now - this.options.tombstoneRetentionMs
    const requestCutoff = now - this.options.requestRetentionMs
    return this.db!.transaction(() => {
      const tombstones = this.db!.prepare(
        `SELECT record_id FROM memory_v2_tombstones WHERE deleted_at < ? ORDER BY deleted_at ASC LIMIT ?`,
      ).all(tombstoneCutoff, this.options.maintenanceBatchSize) as Array<{ record_id: string }>
      for (const tombstone of tombstones) {
        this.db!.prepare("DELETE FROM memory_v2_records WHERE id = ? AND status = 'tombstoned'").run(tombstone.record_id)
        this.db!.prepare('DELETE FROM memory_v2_tombstones WHERE record_id = ?').run(tombstone.record_id)
      }
      const requests = this.db!.prepare(
        'SELECT request_id FROM memory_v2_requests WHERE created_at < ? ORDER BY created_at ASC LIMIT ?',
      ).all(requestCutoff, this.options.maintenanceBatchSize) as Array<{ request_id: string }>
      for (const request of requests) this.db!.prepare('DELETE FROM memory_v2_requests WHERE request_id = ?').run(request.request_id)
      return { tombstonesRemoved: tombstones.length, requestsRemoved: requests.length }
    })()
  }

  private async getInternal(id: string, projectScopeId: string, includeTombstone: boolean): Promise<MemoryRecord | null> {
    if (!projectScopeId) throw new TypeError('projectScopeId is required')
    const suffix = includeTombstone ? '' : " AND status = 'active'"
    const row = this.db!.prepare(`SELECT * FROM memory_v2_records WHERE id = ? AND project_scope_id = ?${suffix}`).get(id, projectScopeId) as
      | StoredMemory
      | null
    return row ? fromRow(row) : null
  }

  private requireReady(): void {
    if (!this.initialized || !this.db) throw new Error('MemoryV2Store is not initialized')
  }

  private requireEnabled(): void {
    if (!isFeatureGateEnabled('MEMORY_STORE_V2', this.options.gates)) throw new MemoryV2DisabledError()
  }

  private mutateInTransaction(mutation: MemoryMutation, source: 'automated' | 'manual'): MemoryMutationResult {
    validateRequestId(mutation.requestId)
    const requestToHash: Record<string, unknown> = {
      operation: mutation.operation,
      requestId: mutation.requestId,
      source,
    }
    if (mutation.operation === 'create') requestToHash.record = mutation.record
    if (mutation.operation !== 'create') {
      requestToHash.recordId = mutation.recordId
      requestToHash.projectScopeId = mutation.projectScopeId
      if (mutation.expectedVersion !== undefined) requestToHash.expectedVersion = mutation.expectedVersion
    }
    if (mutation.operation === 'update') requestToHash.changes = mutation.changes
    const requestHash = sha256Canonical(requestToHash)
    const existing = this.db!.prepare('SELECT * FROM memory_v2_requests WHERE request_id = ?').get(
      mutation.requestId,
    ) as StoredRequest | null
    if (existing) {
      if (existing.request_hash !== requestHash) throw new RequestReuseError(mutation.requestId)
      return { ...this.replayRequest(existing, requestHash), replayed: true }
    }

    if (source === 'automated') this.rejectSecrets(mutation)

    const record =
      mutation.operation === 'create'
        ? this.createRecord(mutation.record)
        : mutation.operation === 'update'
          ? this.updateRecord(mutation)
          : this.deleteRecord(mutation)
    const result: MemoryMutationResult = {
      requestId: mutation.requestId,
      requestHash,
      operation: mutation.operation,
      record,
      replayed: false,
    }
    this.db!.prepare(
      'INSERT INTO memory_v2_requests (request_id, request_hash, operation, record_id, project_scope_id, result_version, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      mutation.requestId,
      requestHash,
      mutation.operation,
      record.id,
      record.projectScopeId,
      record.version,
      record.status,
      Date.now(),
    )
    return result
  }

  private replayRequest(request: StoredRequest, requestHash: string): MemoryMutationResult {
    const current = request.record_id && request.project_scope_id
      ? this.db!.prepare('SELECT * FROM memory_v2_records WHERE id = ? AND project_scope_id = ?').get(request.record_id, request.project_scope_id) as StoredMemory | null
      : null
    const record: MemoryReplayMetadata = current
      ? { id: current.id, projectScopeId: current.project_scope_id, version: current.version, status: current.status }
      : {
          id: request.record_id,
          projectScopeId: request.project_scope_id,
          version: request.result_version,
          status: 'tombstoned',
        }
    return {
      requestId: request.request_id,
      requestHash,
      operation: request.operation as MemoryMutation['operation'],
      record,
      replayed: false,
    }
  }

  private migrateLegacyRequestRows(): void {
    const columns = this.db!.prepare('PRAGMA table_info(memory_v2_requests)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'result_json')) return
    this.db!.exec('DROP TABLE IF EXISTS memory_v2_requests_legacy')
    this.db!.exec('ALTER TABLE memory_v2_requests RENAME TO memory_v2_requests_legacy')
    this.db!.exec(`
      CREATE TABLE memory_v2_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        record_id TEXT NOT NULL,
        project_scope_id TEXT NOT NULL,
        result_version INTEGER NOT NULL,
        result_status TEXT NOT NULL CHECK (result_status IN ('active', 'tombstoned')),
        created_at INTEGER NOT NULL
      );
    `)
    const rows = this.db!.prepare('SELECT request_id, request_hash, result_json, created_at FROM memory_v2_requests_legacy').all() as Array<{
      request_id: string
      request_hash: string
      result_json: string
      created_at: number
    }>
    for (const row of rows) {
      let recordId = ''
      let projectScopeId = ''
      let version = 0
      let status: MemoryStatus = 'tombstoned'
      let operation = 'create'
      try {
        const result = JSON.parse(row.result_json) as Partial<MemoryMutationResult>
        operation = result.operation ?? operation
        recordId = result.record?.id ?? ''
        projectScopeId = result.record?.projectScopeId ?? ''
        version = result.record?.version ?? 0
        status = result.record?.status === 'active' ? 'active' : 'tombstoned'
      } catch {}
      this.db!.prepare(
        'INSERT INTO memory_v2_requests (request_id, request_hash, operation, record_id, project_scope_id, result_version, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(row.request_id, row.request_hash, operation, recordId, projectScopeId, version, status, row.created_at)
    }
    this.db!.exec('DROP TABLE memory_v2_requests_legacy')
  }

  private rejectSecrets(mutation: MemoryMutation): void {
    const content =
      mutation.operation === 'create'
        ? `${mutation.record.name}\n${mutation.record.description ?? ''}\n${mutation.record.content}`
        : mutation.operation === 'update'
          ? `${mutation.changes.name ?? ''}\n${mutation.changes.description ?? ''}\n${mutation.changes.content ?? ''}`
          : ''
    const matches = scanForSecrets(content)
    if (matches.length > 0) throw new SecretMemoryError(matches)
  }

  private createRecord(input: MemoryRecordInput): MemoryRecord {
    validateRecordInput(input, this.options.maxRecordCharacters, this.options.maxRecordBytes)
    const burned = this.db!.prepare('SELECT record_id FROM memory_v2_burned_ids WHERE record_id = ?').get(input.id)
    if (burned) throw new MemoryConflictError(input.id)
    const existing = this.db!.prepare('SELECT * FROM memory_v2_records WHERE id = ?').get(input.id) as
      | StoredMemory
      | null
    if (existing) throw new MemoryConflictError(input.id, undefined, existing.version)
    this.assertBudget(input, null)
    const now = Date.now()
    this.db!.prepare(
      `INSERT INTO memory_v2_records
        (id, project_scope_id, type, name, description, content, pinned, version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
    ).run(
      input.id,
      input.projectScopeId,
      input.type,
      input.name,
      input.description ?? null,
      input.content,
      input.pinned === true ? 1 : 0,
      now,
      now,
    )
    return {
      ...input,
      description: input.description,
      pinned: input.pinned === true,
      version: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
  }

  private updateRecord(mutation: Extract<MemoryMutation, { operation: 'update' }>): MemoryRecord {
    const existing = this.db!.prepare('SELECT * FROM memory_v2_records WHERE id = ?').get(mutation.recordId) as
      | StoredMemory
      | null
    if (!existing || existing.status !== 'active' || existing.project_scope_id !== mutation.projectScopeId) {
      throw new MemoryConflictError(mutation.recordId, mutation.expectedVersion, existing?.version)
    }
    if (mutation.expectedVersion !== undefined && mutation.expectedVersion !== existing.version) {
      throw new MemoryConflictError(mutation.recordId, mutation.expectedVersion, existing.version)
    }
    if (mutation.changes.projectScopeId !== undefined && mutation.changes.projectScopeId !== existing.project_scope_id) {
      throw new MemoryConflictError(mutation.recordId, mutation.expectedVersion, existing.version)
    }
    const current = fromRow(existing)
    const next: MemoryRecordInput = {
      id: current.id,
      projectScopeId: mutation.changes.projectScopeId ?? current.projectScopeId,
      type: mutation.changes.type ?? current.type,
      name: mutation.changes.name ?? current.name,
      description: mutation.changes.description ?? current.description,
      content: mutation.changes.content ?? current.content,
      pinned: mutation.changes.pinned ?? current.pinned,
    }
    validateRecordInput(next, this.options.maxRecordCharacters, this.options.maxRecordBytes)
    this.assertBudget(next, current)
    const now = Date.now()
    const version = existing.version + 1
    this.db!.prepare(
      `UPDATE memory_v2_records SET project_scope_id = ?, type = ?, name = ?, description = ?, content = ?, pinned = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'active'`,
    ).run(
      next.projectScopeId,
      next.type,
      next.name,
      next.description ?? null,
      next.content,
      next.pinned ? 1 : 0,
      version,
      now,
      next.id,
      existing.version,
    )
    return { ...next, pinned: next.pinned === true, version, status: 'active', createdAt: current.createdAt, updatedAt: now }
  }

  private deleteRecord(mutation: Extract<MemoryMutation, { operation: 'delete' }>): MemoryRecord {
    const existing = this.db!.prepare('SELECT * FROM memory_v2_records WHERE id = ?').get(mutation.recordId) as
      | StoredMemory
      | null
    if (!existing || existing.project_scope_id !== mutation.projectScopeId) {
      throw new MemoryConflictError(mutation.recordId, mutation.expectedVersion, existing?.version)
    }
    if (mutation.expectedVersion !== undefined && mutation.expectedVersion !== existing.version) {
      throw new MemoryConflictError(mutation.recordId, mutation.expectedVersion, existing.version)
    }
    if (existing.status === 'tombstoned') return fromRow(existing)
    const now = Date.now()
    const version = existing.version + 1
    this.db!.prepare(
      `UPDATE memory_v2_records SET status = 'tombstoned', content = '', description = NULL, name = '', pinned = 0, version = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'active'`,
    ).run(version, now, mutation.recordId, existing.version)
    this.db!.prepare(
      'INSERT OR REPLACE INTO memory_v2_tombstones (record_id, deleted_version, deleted_at) VALUES (?, ?, ?)',
    ).run(mutation.recordId, version, now)
    this.db!.prepare(
      'INSERT OR IGNORE INTO memory_v2_burned_ids (record_id, burned_at) VALUES (?, ?)',
    ).run(mutation.recordId, now)
    this.db!.prepare(
      "UPDATE memory_v2_requests SET result_status = 'tombstoned', result_version = ? WHERE record_id = ? AND project_scope_id = ?",
    ).run(version, mutation.recordId, mutation.projectScopeId)
    return {
      ...fromRow(existing),
      name: '',
      description: undefined,
      content: '',
      pinned: false,
      version,
      status: 'tombstoned',
      updatedAt: now,
    }
  }

  private assertBudget(next: MemoryRecordInput, replaced: MemoryRecord | null): void {
    const count = this.db!.prepare("SELECT COUNT(*) AS count FROM memory_v2_records WHERE status = 'active'").get() as {
      count: number
    }
    const totals = this.db!.prepare(
      "SELECT COALESCE(SUM(LENGTH(name) + LENGTH(COALESCE(description, '')) + LENGTH(content)), 0) AS characters, COALESCE(SUM(LENGTH(CAST(name AS BLOB)) + LENGTH(CAST(COALESCE(description, '') AS BLOB)) + LENGTH(CAST(content AS BLOB))), 0) AS bytes FROM memory_v2_records WHERE status = 'active'",
    ).get() as { characters: number; bytes: number }
    const previousCharacters = replaced ? recordCharacterCount(replaced) : 0
    const previousBytes = replaced ? recordByteCount(replaced) : 0
    if (replaced === null && count.count + 1 > this.options.maxRecords) {
      throw new MemoryBudgetError(`records (${count.count + 1} > ${this.options.maxRecords})`)
    }
    const characters = totals.characters - previousCharacters + recordCharacterCount(next)
    const bytes = totals.bytes - previousBytes + recordByteCount(next)
    if (characters > this.options.maxTotalCharacters) {
      throw new MemoryBudgetError(`total characters (${characters} > ${this.options.maxTotalCharacters})`)
    }
    if (bytes > this.options.maxTotalBytes) {
      throw new MemoryBudgetError(`total bytes (${bytes} > ${this.options.maxTotalBytes})`)
    }
  }
}
