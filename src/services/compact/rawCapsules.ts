import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { scanForSecrets, sanitizeSecretsWithPlaceholders } from '../teamMemorySync/secretScanner.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from '../memoryV2/featureGates.js'
import { deserializeEncryptedFrame, serializeEncryptedFrame, type EncryptedFrame } from '../sessionCrypto/encryptedFrames.js'
import type { SessionCryptoManager, SessionWriter } from '../sessionCrypto/sessionCrypto.js'

export const RAW_TRANSCRIPT_ARTIFACT_KIND = 'raw-transcript-v1' as const
export const RAW_CAPSULE_ARTIFACT_KIND = 'raw-capsule-v1' as const
export const RETRIEVAL_ROUTING_ROOT_KIND = 'retrieval-routing-root-v1' as const
export const RETRIEVAL_ROUTING_SHARD_KIND = 'retrieval-routing-shard-v1' as const
export const DEFAULT_CAPSULE_TOKEN_BUDGET = 8_000
export const DEFAULT_MAX_PLAINTEXT_INDEX_BYTES = 4 * 1024 * 1024
export const MAX_RAW_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_ROUTING_CANDIDATES = 4_096
const MAX_ROUTING_SHARD_ENTRIES = 256
const DEFAULT_MAX_RAW_ARTIFACTS = 10_000
const DEFAULT_MAX_CAPSULES = 10_000
const DEFAULT_MAX_TOTAL_ENCRYPTED_BYTES = 64 * 1024 * 1024

export type RawCapsuleTokenCounter = (text: string) => number
export type RawCapsuleContextEntry = Readonly<{
  capsuleId: string
  summary: string
  keywords: readonly string[]
  unresolved: boolean
  tokenCount: number
  sourceArtifactIds: readonly string[]
}>
export type RawCapsuleRetrievalContextRenderer = (capsules: readonly RawCapsuleContextEntry[]) => string

export type RawCapsuleCryptor = Readonly<{
  encrypt(input: Readonly<{
    projectScopeId: string
    artifactKind: string
    artifactId: string
    plaintext: Uint8Array
    timestamp: bigint
  }>): Promise<EncryptedFrame>
  decrypt(frame: EncryptedFrame): Promise<Uint8Array>
}>

export type RawCapsulePersistedState = Readonly<{
  raw: readonly RawTranscriptRecord[]
  capsules: readonly Readonly<{ capsuleId: string; retentionDeadline: number; frame: EncryptedFrame }>[]
  routing: readonly PersistedRouting[]
  pins: readonly Readonly<{ pinId: string; artifactIds: readonly string[]; expiresAt: number; fenceToken: string; generation: string }>[]
  rootGeneration: string
  generation: string
  deleted: boolean
}>

export type RawCapsuleWriterLease = Readonly<{
  ownerId: string
  fencingToken: string
  expiresAt: number
}>

export interface RawCapsulePersistence {
  load(sessionId: string, projectScopeId: string): Promise<RawCapsulePersistedState | null>
  acquireWriter(sessionId: string, projectScopeId: string, ownerId: string, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease>
  renewWriter?(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease>
  replace(sessionId: string, projectScopeId: string, state: RawCapsulePersistedState, expectedGeneration: string, lease: RawCapsuleWriterLease, now?: number): Promise<string>
  deleteSession(sessionId: string, projectScopeId: string): Promise<void>
  releaseWriter?(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease): Promise<void> | void
  close?(): Promise<void> | void
}

export type RawTranscriptInput = Readonly<{
  artifactId: string
  sequence: bigint
  timestamp: number
  retentionDeadline: number
  content: string | Uint8Array
}>

export type RawTranscriptRecord = Readonly<{
  artifactId: string
  sequence: string
  timestamp: number
  retentionDeadline: number
  contentEncoding: 'utf8' | 'binary'
  kind: typeof RAW_TRANSCRIPT_ARTIFACT_KIND
  frame: EncryptedFrame
}>

export type RawCapsuleDraft = Readonly<{
  summary: string
  keywords: readonly string[]
  unresolved: boolean
  tokenCount?: number
  embedding?: readonly number[]
}>

export type RawCapsuleRecord = Readonly<{
  capsuleId: string
  sourceKind: typeof RAW_TRANSCRIPT_ARTIFACT_KIND
  sourceArtifactIds: readonly string[]
  unresolved: boolean
  tokenCount: number
  retentionDeadline: number
  frame: EncryptedFrame
}>

export type SanitizedRawCompactionInput = Readonly<{
  text: string
  sourceArtifactIds: readonly string[]
  placeholders: readonly Readonly<{ placeholder: string; ruleId: string }>[]
}>

export type RawCapsuleRetrievalResult = Readonly<{
  capsules: readonly RawCapsuleContextEntry[]
  includedTokens: number
  unresolvedCount: number
  omittedUnresolvedCount: number
  retrievalAction: 'none' | 'retrieve-more'
}>

type PersistedRaw = Readonly<{
  record: RawTranscriptRecord
}>

type PersistedCapsule = Readonly<{
  record: RawCapsuleRecord
}>

type PersistedRouting = Readonly<{
  kind: 'root' | 'shard'
  shardId?: string
  frame: EncryptedFrame
}>

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
  }
  transaction<T>(callback: () => T): () => T
  close(): void
}

type RoutingEntry = Readonly<{
  capsuleId: string
  keywords: readonly string[]
  unresolved: boolean
  tokenCount: number
  retentionDeadline: number
}>

type CapsulePayload = Readonly<{
  summary: string
  keywords: readonly string[]
  unresolved: boolean
  tokenCount: number
  embedding?: readonly number[]
  sourceArtifactIds: readonly string[]
  sourceKind: typeof RAW_TRANSCRIPT_ARTIFACT_KIND
}>

type RootPayload = Readonly<{
  version: 1
  shardIds: readonly string[]
}>

type ShardPayload = Readonly<{
  version: 1
  shardId: string
  entries: readonly RoutingEntry[]
}>

type MutableStoreSnapshot = Readonly<{
  raw: Map<string, PersistedRaw>
  capsules: Map<string, PersistedCapsule>
  routing: Map<string, PersistedRouting>
  pins: Map<string, Readonly<{ artifactIds: readonly string[]; expiresAt: number; fenceToken: string; generation: string }>>
  rootId: string | null
  rootGeneration: bigint
  deleted: boolean
}>

type RawReadFence = Readonly<{
  lifecycleGeneration: bigint
}>

type SerializedRawCapsuleState = {
  version: 1
  raw: Array<Omit<RawTranscriptRecord, 'frame'> & { frame: string }>
  capsules: Array<{ capsuleId: string; retentionDeadline: number; frame: string }>
  routing: Array<{ kind: 'root' | 'shard'; shardId?: string; frame: string }>
  pins: Array<{ pinId: string; artifactIds: string[]; expiresAt: number; fenceToken?: string; generation?: string }>
  rootGeneration: string
  generation?: string
  deleted: boolean
}

function encodeFrame(frame: EncryptedFrame): string {
  return Buffer.from(serializeEncryptedFrame(frame)).toString('base64')
}

function decodeFrame(value: string): EncryptedFrame {
  return deserializeEncryptedFrame(new Uint8Array(Buffer.from(value, 'base64')))
}

function serializePersistedState(state: RawCapsulePersistedState): string {
  const value: SerializedRawCapsuleState = {
    version: 1,
    raw: state.raw.map(record => ({ ...record, frame: encodeFrame(record.frame) })),
    capsules: state.capsules.map(capsule => ({ capsuleId: capsule.capsuleId, retentionDeadline: capsule.retentionDeadline, frame: encodeFrame(capsule.frame) })),
    routing: state.routing.map(route => ({ kind: route.kind, ...(route.shardId ? { shardId: route.shardId } : {}), frame: encodeFrame(route.frame) })),
    pins: state.pins.map(pin => ({ pinId: pin.pinId, artifactIds: [...pin.artifactIds], expiresAt: pin.expiresAt, fenceToken: pin.fenceToken, generation: pin.generation })),
    rootGeneration: state.rootGeneration,
    generation: state.generation,
    deleted: state.deleted,
  }
  return JSON.stringify(value)
}

function deserializePersistedState(value: string): RawCapsulePersistedState {
  const parsed = JSON.parse(value) as SerializedRawCapsuleState
  if (parsed.version !== 1 || !Array.isArray(parsed.raw) || !Array.isArray(parsed.capsules) || !Array.isArray(parsed.routing) || !Array.isArray(parsed.pins) || typeof parsed.rootGeneration !== 'string' || typeof parsed.deleted !== 'boolean') throw new Error('Raw capsule persistence state is malformed')
  return {
    raw: Object.freeze(parsed.raw.map(record => Object.freeze({ ...record, frame: decodeFrame(record.frame) }))),
    capsules: Object.freeze(parsed.capsules.map(capsule => Object.freeze({ capsuleId: capsule.capsuleId, retentionDeadline: capsule.retentionDeadline, frame: decodeFrame(capsule.frame) }))),
    routing: Object.freeze(parsed.routing.map(route => Object.freeze({ kind: route.kind, ...(route.shardId ? { shardId: route.shardId } : {}), frame: decodeFrame(route.frame) }))),
    pins: Object.freeze(parsed.pins.map(pin => Object.freeze({ pinId: pin.pinId, artifactIds: Object.freeze([...pin.artifactIds]), expiresAt: pin.expiresAt, fenceToken: pin.fenceToken ?? '', generation: pin.generation ?? '0' }))),
    rootGeneration: parsed.rootGeneration,
    generation: parsed.generation ?? '0',
    deleted: parsed.deleted,
  }
}

export class MemoryRawCapsulePersistence implements RawCapsulePersistence {
  private readonly states = new Map<string, RawCapsulePersistedState>()
  private readonly leases = new Map<string, RawCapsuleWriterLease>()

  async load(sessionId: string, projectScopeId: string): Promise<RawCapsulePersistedState | null> {
    const state = this.states.get(this.key(sessionId, projectScopeId))
    return state ? structuredClone(state) : null
  }

  async acquireWriter(sessionId: string, projectScopeId: string, ownerId: string, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease> {
    const key = this.key(sessionId, projectScopeId)
    const current = this.leases.get(key)
    if (current && current.expiresAt > now && current.ownerId !== ownerId) throw new Error('Raw capsule writer lease is held by another owner')
    const lease = { ownerId, fencingToken: randomUUID(), expiresAt: now + leaseDurationMs }
    this.leases.set(key, lease)
    return lease
  }

  async replace(sessionId: string, projectScopeId: string, state: RawCapsulePersistedState, expectedGeneration: string, lease: RawCapsuleWriterLease, now = Date.now()): Promise<string> {
    this.assertLease(sessionId, projectScopeId, lease, now)
    const key = this.key(sessionId, projectScopeId)
    const currentGeneration = this.states.get(key)?.generation ?? '0'
    if (currentGeneration !== expectedGeneration) throw new Error('Raw capsule persistence generation conflict')
    const nextGeneration = (BigInt(currentGeneration) + 1n).toString(10)
    this.states.set(key, structuredClone({ ...state, generation: nextGeneration }))
    return nextGeneration
  }

  async renewWriter(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease> {
    const current = this.leases.get(this.key(sessionId, projectScopeId))
    if (!current || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) throw new Error('Raw capsule writer lease cannot be renewed')
    const renewed = { ownerId: current.ownerId, fencingToken: current.fencingToken, expiresAt: now + leaseDurationMs }
    this.leases.set(this.key(sessionId, projectScopeId), renewed)
    return renewed
  }

  async deleteSession(sessionId: string, projectScopeId: string): Promise<void> {
    const lease = await this.acquireWriter(sessionId, projectScopeId, `delete:${randomUUID()}`, Date.now(), 60_000)
    try {
      const state = this.states.get(this.key(sessionId, projectScopeId)) ?? { raw: [], capsules: [], routing: [], pins: [], rootGeneration: '0', generation: '0', deleted: true }
      await this.replace(sessionId, projectScopeId, { ...state, raw: [], capsules: [], routing: [], pins: [], deleted: true }, state.generation, lease)
    } finally {
      this.releaseWriter(sessionId, projectScopeId, lease)
    }
  }

  releaseWriter(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease): void {
    const key = this.key(sessionId, projectScopeId)
    if (this.leases.get(key)?.fencingToken === lease.fencingToken) this.leases.delete(key)
  }

  private assertLease(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease, now: number): void {
    const current = this.leases.get(this.key(sessionId, projectScopeId))
    if (!current || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) throw new Error('Raw capsule writer lease is invalid')
  }

  private key(sessionId: string, projectScopeId: string): string {
    return JSON.stringify([sessionId, projectScopeId])
  }
}

export class BunSqliteRawCapsulePersistence implements RawCapsulePersistence {
  private db: SqliteDatabase | null = null
  private initialized = false

  constructor(private readonly dbPath: string) {}

  async load(sessionId: string, projectScopeId: string): Promise<RawCapsulePersistedState | null> {
    await this.init()
    const row = this.db!.prepare('SELECT state_json FROM memory_v2_raw_capsule_state WHERE session_id = ? AND project_scope_id = ?').get(sessionId, projectScopeId) as { state_json?: string } | null
    return row?.state_json ? deserializePersistedState(row.state_json) : null
  }

  async acquireWriter(sessionId: string, projectScopeId: string, ownerId: string, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease> {
    await this.init()
    const lease = { ownerId, fencingToken: randomUUID(), expiresAt: now + leaseDurationMs }
    const result = this.db!.transaction(() => {
      const row = this.db!.prepare('SELECT writer_owner, writer_token, writer_expires_at FROM memory_v2_raw_capsule_state WHERE session_id = ? AND project_scope_id = ?').get(sessionId, projectScopeId) as { writer_owner?: string; writer_token?: string; writer_expires_at?: number } | null
      if (row?.writer_token && typeof row.writer_expires_at === 'number' && row.writer_expires_at > now && row.writer_owner !== ownerId) throw new Error('Raw capsule writer lease is held by another owner')
      this.db!.prepare('INSERT INTO memory_v2_raw_capsule_state (session_id, project_scope_id, state_json, updated_at, generation, writer_owner, writer_token, writer_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, project_scope_id) DO UPDATE SET writer_owner = excluded.writer_owner, writer_token = excluded.writer_token, writer_expires_at = excluded.writer_expires_at').run(sessionId, projectScopeId, JSON.stringify({ version: 1, raw: [], capsules: [], routing: [], pins: [], rootGeneration: '0', generation: '0', deleted: false }), now, '0', ownerId, lease.fencingToken, lease.expiresAt)
      return lease
    })()
    return result as RawCapsuleWriterLease
  }

  async replace(sessionId: string, projectScopeId: string, state: RawCapsulePersistedState, expectedGeneration: string, lease: RawCapsuleWriterLease, now = Date.now()): Promise<string> {
    await this.init()
    const nextGeneration = (BigInt(expectedGeneration) + 1n).toString(10)
    const stateJson = serializePersistedState({ ...state, generation: nextGeneration })
    const result = this.db!.transaction(() => {
      const row = this.db!.prepare('SELECT generation, writer_token, writer_expires_at FROM memory_v2_raw_capsule_state WHERE session_id = ? AND project_scope_id = ?').get(sessionId, projectScopeId) as { generation?: string; writer_token?: string; writer_expires_at?: number } | null
      if (!row || row.generation !== expectedGeneration || row.writer_token !== lease.fencingToken || lease.expiresAt <= now) throw new Error('Raw capsule persistence generation or writer lease conflict')
      const updated = this.db!.prepare('UPDATE memory_v2_raw_capsule_state SET state_json = ?, updated_at = ?, generation = ? WHERE session_id = ? AND project_scope_id = ? AND generation = ? AND writer_token = ?').run(stateJson, Date.now(), nextGeneration, sessionId, projectScopeId, expectedGeneration, lease.fencingToken) as { changes?: number }
      if (updated?.changes !== undefined && updated.changes !== 1) throw new Error('Raw capsule persistence compare-and-set failed')
      return nextGeneration
    })()
    return result as string
  }

  async renewWriter(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease, now: number, leaseDurationMs: number): Promise<RawCapsuleWriterLease> {
    await this.init()
    const expiresAt = now + leaseDurationMs
    const result = this.db!.transaction(() => {
      const updated = this.db!.prepare('UPDATE memory_v2_raw_capsule_state SET writer_expires_at = ? WHERE session_id = ? AND project_scope_id = ? AND writer_token = ? AND writer_expires_at > ?').run(expiresAt, sessionId, projectScopeId, lease.fencingToken, now) as { changes?: number }
      if (updated?.changes !== undefined && updated.changes !== 1) throw new Error('Raw capsule writer lease cannot be renewed')
      return { ownerId: lease.ownerId, fencingToken: lease.fencingToken, expiresAt }
    })()
    return result as RawCapsuleWriterLease
  }

  async deleteSession(sessionId: string, projectScopeId: string): Promise<void> {
    await this.init()
    const lease = await this.acquireWriter(sessionId, projectScopeId, `delete:${randomUUID()}`, Date.now(), 60_000)
    try {
      const current = await this.load(sessionId, projectScopeId)
      await this.replace(sessionId, projectScopeId, { raw: [], capsules: [], routing: [], pins: [], rootGeneration: current?.rootGeneration ?? '0', generation: current?.generation ?? '0', deleted: true }, current?.generation ?? '0', lease)
    } finally {
      await this.releaseWriter(sessionId, projectScopeId, lease)
    }
  }

  async releaseWriter(sessionId: string, projectScopeId: string, lease: RawCapsuleWriterLease): Promise<void> {
    await this.init()
    this.db!.prepare('UPDATE memory_v2_raw_capsule_state SET writer_owner = NULL, writer_token = NULL, writer_expires_at = NULL WHERE session_id = ? AND project_scope_id = ? AND writer_token = ?').run(sessionId, projectScopeId, lease.fencingToken)
  }

  close(): void {
    if (!this.db) return
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch {}
    this.db.close()
    this.db = null
    this.initialized = false
  }

  private async init(): Promise<void> {
    if (this.initialized && this.db) return
    if (this.dbPath !== ':memory:' && dirname(this.dbPath) !== '.') mkdirSync(dirname(this.dbPath), { recursive: true })
    if (typeof Bun === 'undefined') throw new Error('Bun SQLite is required for durable raw capsule persistence')
    const { Database } = await import('bun:sqlite')
    this.db = new Database(this.dbPath) as unknown as SqliteDatabase
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = FULL;')
    this.db.exec('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS memory_v2_raw_capsule_state (session_id TEXT NOT NULL, project_scope_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, generation TEXT NOT NULL DEFAULT \'0\', writer_owner TEXT, writer_token TEXT, writer_expires_at INTEGER, PRIMARY KEY (session_id, project_scope_id));')
    for (const statement of [
      'ALTER TABLE memory_v2_raw_capsule_state ADD COLUMN generation TEXT NOT NULL DEFAULT \'0\'',
      'ALTER TABLE memory_v2_raw_capsule_state ADD COLUMN writer_owner TEXT',
      'ALTER TABLE memory_v2_raw_capsule_state ADD COLUMN writer_token TEXT',
      'ALTER TABLE memory_v2_raw_capsule_state ADD COLUMN writer_expires_at INTEGER',
    ]) {
      try { this.db.exec(statement) } catch {}
    }
    this.initialized = true
  }
}

export class RawCapsulesDisabledError extends Error {
  constructor() {
    super('Raw capsule retrieval is disabled')
    this.name = 'RawCapsulesDisabledError'
  }
}

export class RawSourceUnavailableError extends Error {
  constructor(message = 'Raw transcript source is unavailable') {
    super(message)
    this.name = 'RawSourceUnavailableError'
  }
}

export class CapsuleSecretError extends Error {
  constructor() {
    super('Raw capsule artifacts must not contain detected or source secret values')
    this.name = 'CapsuleSecretError'
  }
}

export class RawCapsuleSessionDeletedError extends Error {
  constructor() {
    super('Raw capsule session has been deleted')
    this.name = 'RawCapsuleSessionDeletedError'
  }
}

export class RawCapsulePersistenceUnavailableError extends Error {
  constructor() {
    super('Durable raw capsule persistence is unavailable')
    this.name = 'RawCapsulePersistenceUnavailableError'
  }
}

export class RawCapsuleSessionClosedError extends Error {
  constructor() {
    super('Raw capsule session store is closed')
    this.name = 'RawCapsuleSessionClosedError'
  }
}

export class RawCapsuleTokenizerUnavailableError extends Error {
  constructor() {
    super('A real tokenizer is required for raw capsule retrieval and compaction')
    this.name = 'RawCapsuleTokenizerUnavailableError'
  }
}

export class CompactionBinaryValueError extends Error {
  constructor() {
    super('Binary compaction values are rejected before remote inference')
    this.name = 'CompactionBinaryValueError'
  }
}

export function shouldUseRawCapsuleCompaction(gates: FeatureGateRequest = {}): boolean {
  return isFeatureGateEnabled('RETRIEVAL_COMPACTION', gates)
}

export type RawCompactionBinding = Readonly<{
  store: EncryptedRawCapsuleStore
  gates: FeatureGateRequest
  sessionRetentionDeadline: number
  summarize?: (input: SanitizedRawCompactionInput) => Promise<RawCapsuleDraft>
  now?: () => number
}>

let rawCompactionBinding: RawCompactionBinding | null = null

export function configureRawCompactionBinding(binding: RawCompactionBinding | null): void {
  rawCompactionBinding = binding
}

export function getRawCompactionBinding(): RawCompactionBinding | null {
  return rawCompactionBinding
}

export function createSessionCryptoRawCapsuleCryptor(input: Readonly<{ manager: SessionCryptoManager; writer: SessionWriter; projectScopeId: string }>): RawCapsuleCryptor {
  return {
    encrypt: async frameInput => {
      if (frameInput.projectScopeId !== input.projectScopeId || input.writer.sessionId.length === 0) throw new Error('Session crypto raw capsule scope mismatch')
      const frame = await input.writer.encrypt({
        projectScopeId: frameInput.projectScopeId,
        artifactKind: frameInput.artifactKind,
        artifactId: frameInput.artifactId,
        plaintext: frameInput.plaintext,
        contentEncoding: 'utf8',
        timestamp: frameInput.timestamp,
      })
      assertEncryptedFrameContract(frame, input.writer.sessionId, input.projectScopeId, frameInput.artifactKind, frameInput.artifactId, 'utf8', frameInput.timestamp, frameInput.plaintext.byteLength)
      return frame
    },
    decrypt: async frame => {
      if (frame.metadata.sessionId !== input.writer.sessionId || frame.metadata.projectScopeId !== input.projectScopeId) throw new RawSourceUnavailableError('Encrypted raw frame scope mismatch')
      return input.manager.decrypt(input.writer.sessionId, frame)
    },
  }
}

function cloneFrame(frame: EncryptedFrame): EncryptedFrame {
  return structuredClone(frame)
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value)
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

function assertFiniteDeadline(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
}

function assertArtifactId(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new TypeError(`${field} must be nonempty`)
}

function estimateCapsuleTokens(summary: string, keywords: readonly string[]): number {
  return Math.max(1, Math.ceil((Array.from(summary).length + keywords.reduce((total, keyword) => total + Array.from(keyword).length, 0)) / 4))
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes))
  } catch {
    throw new RawSourceUnavailableError('Encrypted retrieval artifact is malformed')
  }
}

function assertRawArtifactFrame(frame: EncryptedFrame, sessionId: string, projectScopeId: string, artifactId: string): void {
  if (frame.metadata.sessionId !== sessionId || frame.metadata.projectScopeId !== projectScopeId || frame.metadata.artifactKind !== RAW_TRANSCRIPT_ARTIFACT_KIND || frame.metadata.artifactId !== artifactId) {
    throw new RawSourceUnavailableError('Encrypted raw frame scope or identity mismatch')
  }
}

function assertEncryptedFrameContract(frame: EncryptedFrame, sessionId: string, projectScopeId: string, artifactKind: string, artifactId: string, contentEncoding: 'utf8' | 'binary', timestamp: bigint, byteLength: number): void {
  assertEncryptedFrameEnvelope(frame, sessionId, projectScopeId, artifactKind, artifactId, contentEncoding)
  if (frame.metadata.byteLength !== byteLength.toString(10) || frame.metadata.timestamp !== timestamp.toString(10)) throw new Error('Encrypted raw frame metadata contract is invalid')
}

function assertEncryptedFrameEnvelope(frame: EncryptedFrame, sessionId: string, projectScopeId: string, artifactKind: string, artifactId: string, contentEncoding: 'utf8' | 'binary'): void {
  if (frame.formatVersion !== 'encrypted-session-frame-v1' || frame.algorithm !== 'aes-256-gcm' || frame.nonce.byteLength !== 12 || frame.tag.byteLength !== 16) throw new Error('Encrypted raw frame contract is invalid')
  if (frame.metadata.formatVersion !== 'session-frame-v1' || frame.metadata.sessionId !== sessionId || frame.metadata.projectScopeId !== projectScopeId || frame.metadata.keyEpoch.length === 0 || frame.metadata.keyId.length === 0 || frame.metadata.artifactKind !== artifactKind || frame.metadata.artifactId !== artifactId || frame.metadata.contentEncoding !== contentEncoding || !/^(0|[1-9][0-9]*)$/.test(frame.metadata.byteLength) || !/^(0|[1-9][0-9]*)$/.test(frame.metadata.timestamp) || !/^(0|[1-9][0-9]*)$/.test(frame.metadata.nonceCounter)) throw new Error('Encrypted raw frame metadata contract is invalid')
}

function assertSafeArtifactText(text: string, originalSecret: (candidate: string) => boolean, placeholders: readonly string[]): void {
  if (originalSecret(text) || scanForSecrets(text).length > 0) throw new CapsuleSecretError()
  const known = new Set(placeholders)
  const emitted = text.match(/\[REDACTED:[^\]]+\]/g) ?? []
  if (emitted.some(value => !known.has(value))) throw new CapsuleSecretError()
}

type PrivateFieldSanitization = Readonly<{
  sanitized: string
  placeholders: readonly Readonly<{ placeholder: string; ruleId: string }>[]
  containsOriginalSecret: (candidate: string) => boolean
}>

export type CompactionSanitizationResult = Readonly<{
  sanitized: unknown
  placeholders: readonly Readonly<{ placeholder: string; ruleId: string }>[]
  containsOriginalSecret: (candidate: string) => boolean
}>

function isPrivateToolKey(key: string): boolean {
  return /^(?:private(?:[_-]?tool)?[_-]?output|tool[_-]?output[_-]?private|sensitive[_-]?output|secret|password|authorization|api[_-]?key)$/i.test(key)
}

export function sanitizeCompactionPayload(value: unknown): CompactionSanitizationResult {
  const values: string[] = []
  const checks: Array<(candidate: string) => boolean> = []
  const placeholders: Array<Readonly<{ placeholder: string; ruleId: string }>> = []
  const seen = new WeakMap<object, unknown>()
  let nextIndex = 0

  const register = (valueToProtect: string, ruleId: string): string => {
    values.push(valueToProtect)
    nextIndex += 1
    const placeholder = `[REDACTED:${ruleId}:${nextIndex}]`
    placeholders.push({ placeholder, ruleId })
    return placeholder
  }

  const sanitizeText = (content: string): string => {
    const privateSanitized = sanitizePrivateToolFields(content)
    for (const placeholder of privateSanitized.placeholders) {
      const value = placeholder.placeholder
      if (privateSanitized.containsOriginalSecret(value)) values.push(value)
    }
    checks.push(privateSanitized.containsOriginalSecret)
    const privatePlaceholderMap = new Map<string, string>()
    let privateCursor = 0
    for (const item of privateSanitized.placeholders) {
      privateCursor += 1
      privatePlaceholderMap.set(item.placeholder, register(``, item.ruleId))
    }
    const withPrivatePlaceholders = privateSanitized.sanitized.replace(/\[REDACTED:[^\]]+\]/g, match => privatePlaceholderMap.get(match) ?? match)
    const scanned = sanitizeSecretsWithPlaceholders(withPrivatePlaceholders)
    checks.push(scanned.containsOriginalSecret)
    const scannerPlaceholderMap = new Map<string, string>()
    for (const item of scanned.placeholders) scannerPlaceholderMap.set(item.placeholder, register(``, item.ruleId))
    return scanned.sanitized.replace(/\[REDACTED:[^\]]+\]/g, match => privatePlaceholderMap.get(match) ?? scannerPlaceholderMap.get(match) ?? match)
  }

  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') return sanitizeText(current)
    if (current instanceof Uint8Array || current instanceof ArrayBuffer || ArrayBuffer.isView(current)) throw new CompactionBinaryValueError()
    if (Array.isArray(current)) {
      const existing = seen.get(current)
      if (existing) return existing
      const output: unknown[] = []
      seen.set(current, output)
      for (const item of current) output.push(walk(item))
      return output
    }
    if (!current || typeof current !== 'object') return current
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return current
    const existing = seen.get(current)
    if (existing) return existing
    const output: Record<string, unknown> = {}
    seen.set(current, output)
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (isPrivateToolKey(key)) {
        const original = typeof child === 'string' ? child : JSON.stringify(child)
        output[key] = register(original ?? '', 'PRIVATE_TOOL_OUTPUT')
        checks.push(candidate => Boolean(original) && candidate.includes(original))
      } else {
        output[key] = walk(child)
      }
    }
    return output
  }

  return Object.freeze({ sanitized: walk(value), placeholders: Object.freeze(placeholders), containsOriginalSecret: candidate => values.some(valueToProtect => valueToProtect.length > 0 && candidate.includes(valueToProtect)) || checks.some(check => check(candidate)) })
}

export function validateCompactionSanitizedOutput(input: Readonly<{ placeholders: readonly Readonly<{ placeholder: string; ruleId: string }>[]; containsOriginalSecret: (candidate: string) => boolean }>, output: string): void {
  assertSafeArtifactText(output, input.containsOriginalSecret, input.placeholders.map(item => item.placeholder))
}

function sanitizePrivateToolFields(content: string): PrivateFieldSanitization {
  const values: string[] = []
  const placeholders: Array<Readonly<{ placeholder: string; ruleId: string }>> = []
  let index = 0
  const sanitized = content.replace(/(["']?)(private(?:[_-]?tool)?[_-]?output|tool[_-]?output[_-]?private|sensitive[_-]?output|secret|password|authorization|api[_-]?key)\1\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\n]+)/gi, (_match, _quote, _key, rawValue: string) => {
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    values.push(value)
    index += 1
    const placeholder = `[REDACTED:PRIVATE_TOOL_OUTPUT:${index}]`
    placeholders.push({ placeholder, ruleId: 'PRIVATE_TOOL_OUTPUT' })
    return `${_key}:"${placeholder}"`
  })
  return Object.freeze({ sanitized, placeholders: Object.freeze(placeholders), containsOriginalSecret: candidate => values.some(value => value.length > 0 && candidate.includes(value)) })
}

function hashShard(value: string): string {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4)
}

function scoreEntry(entry: RoutingEntry, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0
  const words = new Set(entry.keywords.map(keyword => keyword.toLocaleLowerCase()))
  return queryTerms.reduce((score, term) => score + (words.has(term) ? 2 : entry.keywords.some(keyword => keyword.toLocaleLowerCase().includes(term)) ? 1 : 0), 0)
}

export class EncryptedRawCapsuleStore {
  private readonly raw = new Map<string, PersistedRaw>()
  private readonly capsules = new Map<string, PersistedCapsule>()
  private readonly routing = new Map<string, PersistedRouting>()
  private readonly pins = new Map<string, Readonly<{ artifactIds: readonly string[]; expiresAt: number; fenceToken: string; generation: string }>>()
  private readonly cache = new Map<string, Readonly<{ value: unknown; bytes: number }>>()
  private cacheBytes = 0
  private readonly maxPlaintextIndexBytes: number
  private deleted = false
  private rootId: string | null = null
  private rootGeneration = 0n
  private persistenceGeneration = '0'
  private initialized = false
  private loadPromise: Promise<void> | null = null
  private closed = false
  private lifecycleGeneration = 0n
  private writerLease: RawCapsuleWriterLease | null = null
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly writerOwnerId = randomUUID()

  constructor(private readonly options: Readonly<{
    sessionId: string
    projectScopeId: string
    sessionRetentionDeadline: number
    cryptor: RawCapsuleCryptor
    persistence?: RawCapsulePersistence
    gates?: FeatureGateRequest
    now?: () => number
    maxPlaintextIndexBytes?: number
    tokenCounter?: RawCapsuleTokenCounter
    retrievalContextRenderer?: RawCapsuleRetrievalContextRenderer
    writerLeaseDurationMs?: number
    compactionPinRenewalIntervalMs?: number
    maxRawArtifacts?: number
    maxCapsules?: number
    maxTotalEncryptedBytes?: number
  }>) {
    assertArtifactId(options.sessionId, 'sessionId')
    assertArtifactId(options.projectScopeId, 'projectScopeId')
    assertFiniteDeadline(options.sessionRetentionDeadline, 'sessionRetentionDeadline')
    this.maxPlaintextIndexBytes = options.maxPlaintextIndexBytes ?? DEFAULT_MAX_PLAINTEXT_INDEX_BYTES
    if (!Number.isSafeInteger(this.maxPlaintextIndexBytes) || this.maxPlaintextIndexBytes < 1) throw new TypeError('maxPlaintextIndexBytes must be positive')
    for (const [name, value] of [['maxRawArtifacts', options.maxRawArtifacts ?? DEFAULT_MAX_RAW_ARTIFACTS], ['maxCapsules', options.maxCapsules ?? DEFAULT_MAX_CAPSULES], ['maxTotalEncryptedBytes', options.maxTotalEncryptedBytes ?? DEFAULT_MAX_TOTAL_ENCRYPTED_BYTES]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`)
    }
    if (options.compactionPinRenewalIntervalMs !== undefined && (!Number.isSafeInteger(options.compactionPinRenewalIntervalMs) || options.compactionPinRenewalIntervalMs < 1)) throw new TypeError('compactionPinRenewalIntervalMs must be positive')
  }

  async appendRaw(input: RawTranscriptInput): Promise<RawTranscriptRecord> {
    return this.enqueueMutation(() => this.appendRawUnsafe(input))
  }

  private async appendRawUnsafe(input: RawTranscriptInput): Promise<RawTranscriptRecord> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    assertArtifactId(input.artifactId, 'artifactId')
    if (typeof input.sequence !== 'bigint' || input.sequence < 0n) throw new TypeError('sequence must be a non-negative bigint')
    assertFiniteDeadline(input.timestamp, 'timestamp')
    assertFiniteDeadline(input.retentionDeadline, 'retentionDeadline')
    if (input.retentionDeadline > this.options.sessionRetentionDeadline) throw new RangeError('raw retention exceeds session retention deadline')
    if (this.raw.has(input.artifactId)) throw new Error('raw transcript artifact is immutable')
    if (this.raw.size >= (this.options.maxRawArtifacts ?? DEFAULT_MAX_RAW_ARTIFACTS)) throw new RangeError('raw transcript quota exceeded')
    const contentEncoding = typeof input.content === 'string' ? 'utf8' : 'binary'
    const plaintext = typeof input.content === 'string' ? textBytes(input.content) : cloneBytes(input.content)
    if (plaintext.byteLength > MAX_RAW_ARTIFACT_BYTES) throw new RangeError('raw transcript artifact exceeds limit')
    const frame = await this.options.cryptor.encrypt({
      projectScopeId: this.options.projectScopeId,
      artifactKind: RAW_TRANSCRIPT_ARTIFACT_KIND,
      artifactId: input.artifactId,
      plaintext,
      timestamp: BigInt(input.timestamp),
    })
    assertRawArtifactFrame(frame, this.options.sessionId, this.options.projectScopeId, input.artifactId)
    assertEncryptedFrameContract(frame, this.options.sessionId, this.options.projectScopeId, RAW_TRANSCRIPT_ARTIFACT_KIND, input.artifactId, contentEncoding, BigInt(input.timestamp), plaintext.byteLength)
    if (this.encryptedBytes() + serializeEncryptedFrame(frame).byteLength > (this.options.maxTotalEncryptedBytes ?? DEFAULT_MAX_TOTAL_ENCRYPTED_BYTES)) throw new RangeError('raw transcript quota exceeded')
    const record: RawTranscriptRecord = Object.freeze({
      artifactId: input.artifactId,
      sequence: input.sequence.toString(10),
      timestamp: input.timestamp,
      retentionDeadline: input.retentionDeadline,
      contentEncoding,
      kind: RAW_TRANSCRIPT_ARTIFACT_KIND,
      frame: cloneFrame(frame),
    })
    const before = this.captureMutableState()
    this.raw.set(input.artifactId, { record })
    try {
      await this.persistState()
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    }
    return record
  }

  async readRaw(artifactId: string): Promise<Readonly<{ artifactId: string; sequence: string; timestamp: number; content: string | Uint8Array }>> {
    await this.mutationTail
    return this.readRawInternal(artifactId)
  }

  private async readRawInternal(artifactId: string): Promise<Readonly<{ artifactId: string; sequence: string; timestamp: number; content: string | Uint8Array }>> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    const fence = this.captureReadFence()
    const persisted = this.raw.get(artifactId)
    if (!persisted) throw new RawSourceUnavailableError()
    if (persisted.record.retentionDeadline <= this.now() && !this.isPinned(artifactId)) throw new RawSourceUnavailableError('Raw transcript retention has expired')
    try {
      assertEncryptedFrameEnvelope(persisted.record.frame, this.options.sessionId, this.options.projectScopeId, RAW_TRANSCRIPT_ARTIFACT_KIND, artifactId, persisted.record.contentEncoding)
      const plaintext = await this.options.cryptor.decrypt(persisted.record.frame)
      this.assertReadFence(fence)
      if (persisted.record.frame.metadata.byteLength !== plaintext.byteLength.toString(10)) throw new RawSourceUnavailableError('Encrypted raw frame length metadata mismatch')
      if (persisted.record.frame.metadata.timestamp !== persisted.record.timestamp.toString(10)) throw new RawSourceUnavailableError('Encrypted raw frame timestamp metadata mismatch')
      return Object.freeze({
        artifactId,
        sequence: persisted.record.sequence,
        timestamp: persisted.record.timestamp,
        content: persisted.record.contentEncoding === 'utf8' ? decodeUtf8(plaintext) : cloneBytes(plaintext),
      })
    } catch (error) {
      if (error instanceof RawCapsuleSessionDeletedError || error instanceof RawCapsuleSessionClosedError) throw error
      throw new RawSourceUnavailableError()
    }
  }

  async createCapsule(input: Readonly<{
    capsuleId: string
    rawArtifactIds: readonly string[]
    summarize: (input: SanitizedRawCompactionInput) => Promise<RawCapsuleDraft>
  }>): Promise<RawCapsuleRecord> {
    return this.enqueueMutation(() => this.createCapsuleUnsafe(input))
  }

  private async createCapsuleUnsafe(input: Readonly<{
    capsuleId: string
    rawArtifactIds: readonly string[]
    summarize: (input: SanitizedRawCompactionInput) => Promise<RawCapsuleDraft>
  }>): Promise<RawCapsuleRecord> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    assertArtifactId(input.capsuleId, 'capsuleId')
    if (this.capsules.has(input.capsuleId)) throw new Error('raw capsule artifact is immutable')
    if (this.capsules.size >= (this.options.maxCapsules ?? DEFAULT_MAX_CAPSULES)) throw new RangeError('capsule quota exceeded')
    const rawArtifactIds = [...new Set(input.rawArtifactIds)]
    if (rawArtifactIds.length === 0) throw new RawSourceUnavailableError('Raw capsule requires raw transcript sources')
    return this.withCompactionPin(input.capsuleId, rawArtifactIds, () => this.createCapsuleCore(input, rawArtifactIds))
  }

  private async createCapsuleCore(input: Readonly<{
    capsuleId: string
    rawArtifactIds: readonly string[]
    summarize: (input: SanitizedRawCompactionInput) => Promise<RawCapsuleDraft>
  }>, rawArtifactIds: readonly string[]): Promise<RawCapsuleRecord> {
    const rawRecords = await Promise.all(rawArtifactIds.map(async artifactId => {
      const record = this.raw.get(artifactId)?.record
      if (!record || record.kind !== RAW_TRANSCRIPT_ARTIFACT_KIND) throw new RawSourceUnavailableError()
      const source = await this.readRawInternal(artifactId)
      if (typeof source.content !== 'string') throw new RawSourceUnavailableError('Raw binary content cannot be compacted as text')
      return { record, source }
    }))
    const sourceText = rawRecords.map(item => item.source.content).join('\n')
    const privateSanitized = sanitizePrivateToolFields(sourceText)
    const scanned = sanitizeSecretsWithPlaceholders(privateSanitized.sanitized)
    const sanitized = {
      sanitized: scanned.sanitized,
      placeholders: Object.freeze([...privateSanitized.placeholders, ...scanned.placeholders]),
      containsOriginalSecret: (candidate: string) => privateSanitized.containsOriginalSecret(candidate) || scanned.containsOriginalSecret(candidate),
    }
    const sanitizedInput: SanitizedRawCompactionInput = Object.freeze({
      text: sanitized.sanitized,
      sourceArtifactIds: Object.freeze(rawArtifactIds),
      placeholders: Object.freeze(sanitized.placeholders),
    })
    const draft = await input.summarize(sanitizedInput)
    if (!draft || typeof draft.summary !== 'string' || !Array.isArray(draft.keywords) || typeof draft.unresolved !== 'boolean') throw new TypeError('Raw capsule draft is malformed')
    const keywords = Object.freeze(draft.keywords.map(keyword => {
      if (typeof keyword !== 'string' || keyword.length > 512) throw new TypeError('Raw capsule keyword is invalid')
      return keyword
    }))
    const placeholderValues = sanitized.placeholders.map(item => item.placeholder)
    assertSafeArtifactText(draft.summary, sanitized.containsOriginalSecret, placeholderValues)
    assertSafeArtifactText(keywords.join('\n'), sanitized.containsOriginalSecret, placeholderValues)
    if (draft.embedding && (!Array.isArray(draft.embedding) || draft.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new TypeError('Raw capsule embedding is invalid')
    const tokenPayload = JSON.stringify({ summary: draft.summary, keywords, unresolved: draft.unresolved })
    const tokenCount = this.countTokens(tokenPayload)
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 1) throw new TypeError('Raw capsule token count is invalid')
    const retentionDeadline = Math.min(this.options.sessionRetentionDeadline, ...rawRecords.map(item => item.record.retentionDeadline))
    const payload: CapsulePayload = Object.freeze({
      summary: draft.summary,
      keywords,
      unresolved: draft.unresolved,
      tokenCount,
      ...(draft.embedding ? { embedding: Object.freeze([...draft.embedding]) } : {}),
      sourceArtifactIds: Object.freeze(rawArtifactIds),
      sourceKind: RAW_TRANSCRIPT_ARTIFACT_KIND,
    })
    const capsuleBytes = textBytes(JSON.stringify(payload))
    const capsuleTimestamp = BigInt(this.now())
    const frame = await this.options.cryptor.encrypt({
      projectScopeId: this.options.projectScopeId,
      artifactKind: RAW_CAPSULE_ARTIFACT_KIND,
      artifactId: input.capsuleId,
      plaintext: capsuleBytes,
      timestamp: capsuleTimestamp,
    })
    assertEncryptedFrameContract(frame, this.options.sessionId, this.options.projectScopeId, RAW_CAPSULE_ARTIFACT_KIND, input.capsuleId, 'utf8', capsuleTimestamp, capsuleBytes.byteLength)
    const record: RawCapsuleRecord = Object.freeze({
      capsuleId: input.capsuleId,
      sourceKind: RAW_TRANSCRIPT_ARTIFACT_KIND,
      sourceArtifactIds: Object.freeze(rawArtifactIds),
      unresolved: draft.unresolved,
      tokenCount,
      retentionDeadline,
      frame: cloneFrame(frame),
    })
    const before = this.captureMutableState()
    this.capsules.set(input.capsuleId, { record })
    try {
      await this.updateRouting(record, keywords)
      if (this.encryptedBytes() > (this.options.maxTotalEncryptedBytes ?? DEFAULT_MAX_TOTAL_ENCRYPTED_BYTES)) throw new RangeError('capsule quota exceeded')
      await this.persistState()
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    }
    return record
  }

  private async withCompactionPin<T>(capsuleId: string, artifactIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const pinId = `compaction:${capsuleId}`
    const before = this.captureMutableState()
    const expiresAt = Math.min(this.options.sessionRetentionDeadline, this.now() + 60_000)
    const fenceToken = randomUUID()
    this.pins.set(pinId, Object.freeze({ artifactIds: Object.freeze([...artifactIds]), expiresAt, fenceToken, generation: '0' }))
    const renewalIntervalMs = this.options.compactionPinRenewalIntervalMs ?? 15_000
    let renewalTimer: ReturnType<typeof setInterval> | null = null
    let renewalPending: Promise<void> | null = null
    let renewalGeneration = '0'
    let pinPersisted = false
    let succeeded = false
    const renew = () => {
      if (renewalPending || !this.pins.has(pinId)) return
      const nextExpiresAt = Math.min(this.options.sessionRetentionDeadline, this.now() + 60_000)
      renewalPending = this.renewCompactionPinUnsafe({ pinId, fenceToken, expectedGeneration: renewalGeneration, expiresAt: nextExpiresAt })
        .then(result => { renewalGeneration = result.generation })
        .catch(() => {})
        .finally(() => { renewalPending = null })
    }
    try {
      await this.persistState()
      pinPersisted = true
      renewalTimer = setInterval(renew, renewalIntervalMs)
      const result = await work()
      if (renewalTimer) clearInterval(renewalTimer)
      renewalTimer = null
      if (renewalPending) await renewalPending
      this.pins.delete(pinId)
      await this.persistState()
      pinPersisted = false
      succeeded = true
      return result
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    } finally {
      if (renewalTimer) clearInterval(renewalTimer)
      if (renewalPending) await renewalPending
      if (!succeeded && pinPersisted) {
        this.pins.delete(pinId)
        await this.persistState().catch(() => {})
      } else if (this.pins.has(pinId)) {
        this.pins.delete(pinId)
        await this.persistState().catch(() => {})
      }
    }
  }

  async pinRawArtifacts(input: Readonly<{ pinId: string; artifactIds: readonly string[]; expiresAt: number; fenceToken?: string }>): Promise<Readonly<{ expiresAt: number }>> {
    return this.enqueueMutation(() => this.pinRawArtifactsUnsafe(input))
  }

  private async pinRawArtifactsUnsafe(input: Readonly<{ pinId: string; artifactIds: readonly string[]; expiresAt: number; fenceToken?: string }>): Promise<Readonly<{ expiresAt: number }>> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    assertArtifactId(input.pinId, 'pinId')
    assertFiniteDeadline(input.expiresAt, 'expiresAt')
    const expandedArtifactIds = [...input.artifactIds]
    for (const artifactId of input.artifactIds) {
      const capsule = this.capsules.get(artifactId)
      if (capsule) {
        const payload = await this.decryptCapsulePayload(capsule.record)
        expandedArtifactIds.push(...payload.sourceArtifactIds)
      }
    }
    const artifactIds = [...new Set(expandedArtifactIds)]
    if (artifactIds.some(artifactId => !this.raw.has(artifactId) && !this.capsules.has(artifactId))) throw new RawSourceUnavailableError()
    const expiresAt = Math.min(input.expiresAt, this.options.sessionRetentionDeadline)
    const before = this.captureMutableState()
    this.pins.set(input.pinId, Object.freeze({ artifactIds: Object.freeze(artifactIds), expiresAt, fenceToken: input.fenceToken ?? randomUUID(), generation: '0' }))
    try {
      await this.persistState()
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    }
    return { expiresAt }
  }

  async renewCompactionPin(input: Readonly<{ pinId: string; fenceToken: string; expectedGeneration: string; expiresAt: number }>): Promise<Readonly<{ expiresAt: number; generation: string }>> {
    return this.enqueueMutation(() => this.renewCompactionPinUnsafe(input))
  }

  private async renewCompactionPinUnsafe(input: Readonly<{ pinId: string; fenceToken: string; expectedGeneration: string; expiresAt: number }>): Promise<Readonly<{ expiresAt: number; generation: string }>> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    assertArtifactId(input.pinId, 'pinId')
    assertArtifactId(input.fenceToken, 'fenceToken')
    assertFiniteDeadline(input.expiresAt, 'expiresAt')
    const current = this.pins.get(input.pinId)
    if (!current || current.fenceToken !== input.fenceToken || current.generation !== input.expectedGeneration || current.expiresAt <= this.now()) throw new RawSourceUnavailableError('Compaction pin fencing token is invalid')
    const nextExpiresAt = Math.min(input.expiresAt, this.options.sessionRetentionDeadline)
    const nextGeneration = (BigInt(current.generation) + 1n).toString(10)
    const before = this.captureMutableState()
    this.pins.set(input.pinId, Object.freeze({ artifactIds: current.artifactIds, expiresAt: nextExpiresAt, fenceToken: current.fenceToken, generation: nextGeneration }))
    try {
      await this.persistState()
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    }
    return { expiresAt: nextExpiresAt, generation: nextGeneration }
  }

  async purgeExpired(): Promise<number> {
    return this.enqueueMutation(() => this.purgeExpiredUnsafe())
  }

  private async purgeExpiredUnsafe(): Promise<number> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    const now = this.now()
    const before = this.captureMutableState()
    for (const [pinId, pin] of this.pins) if (pin.expiresAt <= now) this.pins.delete(pinId)
    const pinned = new Set([...this.pins.values()].flatMap(pin => pin.artifactIds))
    let removed = 0
    for (const [artifactId, persisted] of this.raw) {
      if (persisted.record.retentionDeadline <= now && !pinned.has(artifactId)) {
        this.raw.delete(artifactId)
        removed += 1
      }
    }
    let routingChanged = false
    for (const [capsuleId, persisted] of this.capsules) {
      if (persisted.record.retentionDeadline <= now && !pinned.has(capsuleId)) {
        this.capsules.delete(capsuleId)
        removed += 1
        routingChanged = true
      }
    }
    try {
      if (routingChanged) await this.rebuildRouting()
      if (removed > 0 || this.pins.size !== before.pins.size) await this.persistState()
      this.cache.clear()
      this.cacheBytes = 0
    } catch (error) {
      this.restoreMutableState(before)
      throw error
    }
    return removed
  }

  async retrieve(input: Readonly<{ query: string; tokenBudget?: number }>): Promise<RawCapsuleRetrievalResult> {
    await this.mutationTail
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    const fence = this.captureReadFence()
    await this.purgeExpired()
    this.assertReadFence(fence)
    const tokenBudget = input.tokenBudget ?? DEFAULT_CAPSULE_TOKEN_BUDGET
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) throw new RangeError('capsule token budget must be a non-negative safe integer')
    const queryTerms = input.query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
    const routed = await this.loadRoutingEntries(queryTerms, fence)
    this.assertReadFence(fence)
    const ranked = routed.entries
    const unresolvedCount = routed.unresolvedCount
    const selected: Array<Readonly<{ capsuleId: string; summary: string; keywords: readonly string[]; unresolved: boolean; tokenCount: number; sourceArtifactIds: readonly string[] }>> = []
    let includedTokens = 0
    for (const entry of ranked) {
      const capsule = await this.readCapsule(entry.capsuleId, fence)
      this.assertReadFence(fence)
      if (capsule.tokenCount !== entry.tokenCount || capsule.unresolved !== entry.unresolved) continue
      const nextTokens = this.countTokens(this.renderRetrievalContext([...selected, capsule]))
      if (nextTokens > tokenBudget) continue
      selected.push(capsule)
      includedTokens = nextTokens
    }
    this.assertReadFence(fence)
    const selectedUnresolved = selected.filter(capsule => capsule.unresolved).length
    return Object.freeze({
      capsules: Object.freeze(selected),
      includedTokens,
      unresolvedCount,
      omittedUnresolvedCount: unresolvedCount - selectedUnresolved,
      retrievalAction: unresolvedCount - selectedUnresolved > 0 ? 'retrieve-more' : 'none',
    })
  }

  async deleteSession(): Promise<void> {
    return this.enqueueMutation(() => this.deleteSessionUnsafe())
  }

  private async deleteSessionUnsafe(): Promise<void> {
    if (!this.writerLease) {
      this.writerLease = await this.persistence().acquireWriter(this.options.sessionId, this.options.projectScopeId, this.writerOwnerId, this.now(), this.options.writerLeaseDurationMs ?? 120_000)
    }
    try {
      await this.ensureLoaded()
    } catch (error) {
      const lease = this.writerLease
      this.writerLease = null
      if (lease) await this.persistence().releaseWriter?.(this.options.sessionId, this.options.projectScopeId, lease)
      throw error
    }
    const before = this.captureMutableState()
    this.lifecycleGeneration += 1n
    this.deleted = true
    this.raw.clear()
    this.capsules.clear()
    this.routing.clear()
    this.pins.clear()
    this.cache.clear()
    this.cacheBytes = 0
    this.rootId = null
    let failure: unknown = null
    try {
      await this.persistState()
    } catch (error) {
      failure = error
      this.restoreMutableState(before)
    } finally {
      const lease = this.writerLease
      this.writerLease = null
      try {
        if (lease) await this.persistence().releaseWriter?.(this.options.sessionId, this.options.projectScopeId, lease)
      } finally {
        await this.persistence().close?.()
      }
    }
    if (failure) throw failure
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.mutationTail
    if (this.closed) return
    this.lifecycleGeneration += 1n
    this.closed = true
    this.raw.clear()
    this.capsules.clear()
    this.routing.clear()
    this.pins.clear()
    this.cache.clear()
    this.cacheBytes = 0
    const lease = this.writerLease
    this.writerLease = null
    try {
      if (lease) await this.persistence().releaseWriter?.(this.options.sessionId, this.options.projectScopeId, lease)
    } finally {
      await this.persistence().close?.()
    }
  }

  async releaseWriterOwnership(): Promise<void> {
    if (this.writerLease) await this.persistence().releaseWriter?.(this.options.sessionId, this.options.projectScopeId, this.writerLease)
    this.writerLease = null
  }

  async reconcile(): Promise<void> {
    return this.enqueueMutation(() => this.reconcileUnsafe())
  }

  private async reconcileUnsafe(): Promise<void> {
    await this.ensureLoaded()
    this.assertEnabled()
    this.assertActive()
    const expectedCapsules = new Set(this.capsules.keys())
    const root = this.routing.get('root')
    let consistent = root !== undefined
    if (root) {
      try {
        assertEncryptedFrameEnvelope(root.frame, this.options.sessionId, this.options.projectScopeId, RETRIEVAL_ROUTING_ROOT_KIND, root.frame.metadata.artifactId, 'utf8')
        const payload = await this.decryptJson<RootPayload>(root.frame)
        const observed = new Set<string>()
        for (const shardId of payload.shardIds) {
          const shard = this.routing.get(`shard:${shardId}`)
          if (!shard) {
            consistent = false
            continue
          }
          const entries = await this.decryptShard(shard.frame)
          for (const entry of entries) observed.add(entry.capsuleId)
        }
        if (observed.size !== expectedCapsules.size || [...expectedCapsules].some(capsuleId => !observed.has(capsuleId))) consistent = false
      } catch {
        consistent = false
      }
    }
    if (!consistent) {
      await this.rebuildRouting()
      await this.persistState()
    }
  }

  async hasRaw(artifactId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.raw.has(artifactId)
  }

  async hasCapsule(capsuleId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.capsules.has(capsuleId)
  }

  inspectPersistedState(): Readonly<{ raw: readonly RawTranscriptRecord[]; capsules: readonly RawCapsuleRecord[]; routing: readonly PersistedRouting[] }> {
    return Object.freeze({
      raw: Object.freeze([...this.raw.values()].map(item => ({ ...item.record, frame: cloneFrame(item.record.frame) }))),
      capsules: Object.freeze([...this.capsules.values()].map(item => ({ ...item.record, frame: cloneFrame(item.record.frame) }))),
      routing: Object.freeze([...this.routing.values()].map(item => ({ kind: item.kind, ...(item.shardId ? { shardId: item.shardId } : {}), frame: cloneFrame(item.frame) }))),
    })
  }

  decryptedIndexBytes(): number {
    return this.cacheBytes
  }

  sessionRetentionDeadline(): number {
    return this.options.sessionRetentionDeadline
  }

  get sessionId(): string {
    return this.options.sessionId
  }

  get projectScopeId(): string {
    return this.options.projectScopeId
  }

  private assertEnabled(): void {
    if (!shouldUseRawCapsuleCompaction(this.options.gates)) throw new RawCapsulesDisabledError()
  }

  private assertActive(): void {
    if (this.closed) throw new RawCapsuleSessionClosedError()
    if (this.deleted) throw new RawCapsuleSessionDeletedError()
  }

  private captureReadFence(): RawReadFence {
    this.assertActive()
    return { lifecycleGeneration: this.lifecycleGeneration }
  }

  private assertReadFence(fence: RawReadFence): void {
    if (this.closed) throw new RawCapsuleSessionClosedError()
    if (this.deleted || this.lifecycleGeneration !== fence.lifecycleGeneration) throw new RawCapsuleSessionDeletedError()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private countTokens(text: string): number {
    if (!this.options.tokenCounter) throw new RawCapsuleTokenizerUnavailableError()
    const count = this.options.tokenCounter(text)
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('Raw capsule tokenizer returned an invalid count')
    return count
  }

  private renderRetrievalContext(capsules: readonly RawCapsuleContextEntry[]): string {
    return this.options.retrievalContextRenderer?.(capsules) ?? JSON.stringify(capsules)
  }

  private encryptedBytes(): number {
    let total = 0
    for (const item of this.raw.values()) total += serializeEncryptedFrame(item.record.frame).byteLength
    for (const item of this.capsules.values()) total += serializeEncryptedFrame(item.record.frame).byteLength
    for (const item of this.routing.values()) total += serializeEncryptedFrame(item.frame).byteLength
    return total
  }

  private isPinned(artifactId: string): boolean {
    const now = this.now()
    return [...this.pins.values()].some(pin => pin.expiresAt > now && pin.artifactIds.includes(artifactId))
  }

  private persistence(): RawCapsulePersistence {
    if (!this.options.persistence) throw new RawCapsulePersistenceUnavailableError()
    return this.options.persistence
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(work, work)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureLoaded(): Promise<void> {
    if (this.closed) throw new RawCapsuleSessionClosedError()
    if (this.initialized) return
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const state = await this.persistence().load(this.options.sessionId, this.options.projectScopeId)
        if (state) {
          this.raw.clear()
          this.capsules.clear()
          this.routing.clear()
          this.pins.clear()
          for (const record of state.raw) this.raw.set(record.artifactId, { record: Object.freeze({ ...record, frame: cloneFrame(record.frame) }) })
          for (const persisted of state.capsules) {
            const payload = await this.decryptJson<CapsulePayload>(persisted.frame)
            if (payload.sourceKind !== RAW_TRANSCRIPT_ARTIFACT_KIND || payload.sourceArtifactIds.length === 0) throw new RawSourceUnavailableError('Persisted capsule provenance is invalid')
            const capsuleId = persisted.capsuleId
            this.capsules.set(capsuleId, { record: Object.freeze({ capsuleId, sourceKind: RAW_TRANSCRIPT_ARTIFACT_KIND, sourceArtifactIds: Object.freeze([...payload.sourceArtifactIds]), unresolved: payload.unresolved, tokenCount: payload.tokenCount, retentionDeadline: persisted.retentionDeadline, frame: cloneFrame(persisted.frame) }) })
          }
          for (const route of state.routing) this.routing.set(route.kind === 'root' ? 'root' : `shard:${route.shardId}`, { kind: route.kind, ...(route.shardId ? { shardId: route.shardId } : {}), frame: cloneFrame(route.frame) })
          for (const pin of state.pins) this.pins.set(pin.pinId, Object.freeze({ artifactIds: Object.freeze([...pin.artifactIds]), expiresAt: pin.expiresAt, fenceToken: pin.fenceToken, generation: pin.generation }))
          this.rootGeneration = BigInt(state.rootGeneration)
          this.persistenceGeneration = state.generation
          this.rootId = state.routing.find(route => route.kind === 'root')?.frame.metadata.artifactId ?? null
          this.deleted = state.deleted
        }
        if (!this.writerLease) this.writerLease = await this.persistence().acquireWriter(this.options.sessionId, this.options.projectScopeId, this.writerOwnerId, this.now(), this.options.writerLeaseDurationMs ?? 120_000)
        this.initialized = true
      })().catch(error => {
        this.loadPromise = null
        throw error
      })
    }
    await this.loadPromise
  }

  private persistedState(): RawCapsulePersistedState {
    return {
      raw: Object.freeze([...this.raw.values()].map(item => Object.freeze({ ...item.record, frame: cloneFrame(item.record.frame) }))),
      capsules: Object.freeze([...this.capsules.values()].map(item => Object.freeze({ capsuleId: item.record.capsuleId, retentionDeadline: item.record.retentionDeadline, frame: cloneFrame(item.record.frame) }))),
      routing: Object.freeze([...this.routing.values()].map(item => Object.freeze({ kind: item.kind, ...(item.shardId ? { shardId: item.shardId } : {}), frame: cloneFrame(item.frame) }))),
      pins: Object.freeze([...this.pins.entries()].map(([pinId, pin]) => Object.freeze({ pinId, artifactIds: Object.freeze([...pin.artifactIds]), expiresAt: pin.expiresAt, fenceToken: pin.fenceToken, generation: pin.generation }))),
      rootGeneration: this.rootGeneration.toString(10),
      generation: this.persistenceGeneration,
      deleted: this.deleted,
    }
  }

  private captureMutableState(): MutableStoreSnapshot {
    return {
      raw: new Map(this.raw),
      capsules: new Map(this.capsules),
      routing: new Map(this.routing),
      pins: new Map(this.pins),
      rootId: this.rootId,
      rootGeneration: this.rootGeneration,
      deleted: this.deleted,
    }
  }

  private restoreMutableState(snapshot: MutableStoreSnapshot): void {
    this.raw.clear()
    this.capsules.clear()
    this.routing.clear()
    this.pins.clear()
    for (const [key, value] of snapshot.raw) this.raw.set(key, value)
    for (const [key, value] of snapshot.capsules) this.capsules.set(key, value)
    for (const [key, value] of snapshot.routing) this.routing.set(key, value)
    for (const [key, value] of snapshot.pins) this.pins.set(key, value)
    this.rootId = snapshot.rootId
    this.rootGeneration = snapshot.rootGeneration
    this.deleted = snapshot.deleted
  }

  private async persistState(): Promise<void> {
    await this.ensureWriterLease()
    const state = this.persistedState()
    try {
      const nextGeneration = await this.persistence().replace(this.options.sessionId, this.options.projectScopeId, state, this.persistenceGeneration, this.writerLease!, this.now())
      this.persistenceGeneration = nextGeneration
    } catch (error) {
      if (!(error instanceof Error) || !/lease/i.test(error.message)) throw error
      this.writerLease = await this.persistence().acquireWriter(this.options.sessionId, this.options.projectScopeId, this.writerOwnerId, this.now(), this.options.writerLeaseDurationMs ?? 120_000)
      const nextGeneration = await this.persistence().replace(this.options.sessionId, this.options.projectScopeId, state, this.persistenceGeneration, this.writerLease, this.now())
      this.persistenceGeneration = nextGeneration
    }
  }

  private async ensureWriterLease(): Promise<void> {
    const now = this.now()
    const duration = this.options.writerLeaseDurationMs ?? 120_000
    if (!this.writerLease) {
      this.writerLease = await this.persistence().acquireWriter(this.options.sessionId, this.options.projectScopeId, this.writerOwnerId, now, duration)
      return
    }
    const renewalThreshold = Math.max(1, Math.floor(duration / 4))
    if (this.writerLease.expiresAt > now + renewalThreshold) return
    const renewWriter = this.persistence().renewWriter
    if (renewWriter) {
      try {
        this.writerLease = await renewWriter(this.options.sessionId, this.options.projectScopeId, this.writerLease, now, duration)
        return
      } catch {}
    }
    this.writerLease = await this.persistence().acquireWriter(this.options.sessionId, this.options.projectScopeId, this.writerOwnerId, now, duration)
  }

  private async updateRouting(record: RawCapsuleRecord, keywords: readonly string[]): Promise<void> {
    const baseShardId = hashShard(record.capsuleId)
    const existingRoutes = [...this.routing.values()].filter(item => item.kind === 'shard' && (item.shardId === baseShardId || item.shardId?.startsWith(`${baseShardId}-`)))
    const entries = (await Promise.all(existingRoutes.map(route => this.decryptShard(route.frame)))).flat().filter(entry => entry.capsuleId !== record.capsuleId)
    entries.push({
      capsuleId: record.capsuleId,
      keywords: Object.freeze([...keywords]),
      unresolved: record.unresolved,
      tokenCount: record.tokenCount,
      retentionDeadline: record.retentionDeadline,
    })
    for (const route of existingRoutes) this.routing.delete(`shard:${route.shardId}`)
    await this.writeRoutingShards(baseShardId, entries)
    await this.rebuildRoot()
  }

  private async rebuildRouting(): Promise<void> {
    const all = [...this.capsules.values()]
    this.routing.clear()
    const grouped = new Map<string, RoutingEntry[]>()
    for (const persisted of all) {
      const payload = await this.decryptCapsulePayload(persisted.record)
      const shardId = hashShard(persisted.record.capsuleId)
      const entries = grouped.get(shardId) ?? []
      entries.push({
        capsuleId: persisted.record.capsuleId,
        keywords: payload.keywords,
        unresolved: payload.unresolved,
        tokenCount: payload.tokenCount,
        retentionDeadline: persisted.record.retentionDeadline,
      })
      grouped.set(shardId, entries)
    }
    for (const [shardId, entries] of grouped) await this.writeRoutingShards(shardId, entries)
    await this.rebuildRoot()
  }

  private async writeRoutingShards(baseShardId: string, entries: readonly RoutingEntry[]): Promise<void> {
    for (let offset = 0, chunkIndex = 0; offset < entries.length; offset += MAX_ROUTING_SHARD_ENTRIES, chunkIndex += 1) {
      const shardId = entries.length <= MAX_ROUTING_SHARD_ENTRIES ? baseShardId : `${baseShardId}-${chunkIndex}`
      const chunk = entries.slice(offset, offset + MAX_ROUTING_SHARD_ENTRIES)
      const shardBytes = textBytes(JSON.stringify({ version: 1, shardId, entries: chunk } satisfies ShardPayload))
      const shardTimestamp = BigInt(this.now())
      const frame = await this.options.cryptor.encrypt({
        projectScopeId: this.options.projectScopeId,
        artifactKind: RETRIEVAL_ROUTING_SHARD_KIND,
        artifactId: `shard-${shardId}-${this.rootGeneration + 1n}`,
        plaintext: shardBytes,
        timestamp: shardTimestamp,
      })
      assertEncryptedFrameContract(frame, this.options.sessionId, this.options.projectScopeId, RETRIEVAL_ROUTING_SHARD_KIND, `shard-${shardId}-${this.rootGeneration + 1n}`, 'utf8', shardTimestamp, shardBytes.byteLength)
      this.routing.set(`shard:${shardId}`, { kind: 'shard', shardId, frame: cloneFrame(frame) })
    }
  }

  private async rebuildRoot(): Promise<void> {
    this.rootGeneration += 1n
    const rootId = `root-${this.rootGeneration}`
    const rootBytes = textBytes(JSON.stringify({ version: 1, shardIds: [...this.routing.values()].filter(item => item.kind === 'shard').map(item => item.shardId!) } satisfies RootPayload))
    const rootTimestamp = BigInt(this.now())
    const frame = await this.options.cryptor.encrypt({
      projectScopeId: this.options.projectScopeId,
      artifactKind: RETRIEVAL_ROUTING_ROOT_KIND,
      artifactId: rootId,
      plaintext: rootBytes,
      timestamp: rootTimestamp,
    })
    assertEncryptedFrameContract(frame, this.options.sessionId, this.options.projectScopeId, RETRIEVAL_ROUTING_ROOT_KIND, rootId, 'utf8', rootTimestamp, rootBytes.byteLength)
    this.rootId = rootId
    this.routing.set('root', { kind: 'root', frame: cloneFrame(frame) })
  }

  private async loadRoutingEntries(queryTerms: readonly string[], fence: RawReadFence): Promise<Readonly<{ entries: readonly RoutingEntry[]; unresolvedCount: number }>> {
    const root = this.routing.get('root')
    if (!root) return { entries: [], unresolvedCount: 0 }
    try {
      assertEncryptedFrameEnvelope(root.frame, this.options.sessionId, this.options.projectScopeId, RETRIEVAL_ROUTING_ROOT_KIND, root.frame.metadata.artifactId, 'utf8')
    } catch {
      throw new RawSourceUnavailableError('Encrypted retrieval root is unavailable')
    }
    const rootPayload = await this.decryptJson<RootPayload>(root.frame, fence)
    this.assertReadFence(fence)
    const entries: RoutingEntry[] = []
    let unresolvedCount = 0
    for (const shardId of rootPayload.shardIds) {
      const shard = this.routing.get(`shard:${shardId}`)
      if (!shard) continue
      for (const entry of await this.decryptShard(shard.frame, fence)) {
        this.assertReadFence(fence)
        if (entry.unresolved) unresolvedCount += 1
        entries.push(entry)
        entries.sort((left, right) => {
          if (left.unresolved !== right.unresolved) return left.unresolved ? -1 : 1
          return scoreEntry(right, queryTerms) - scoreEntry(left, queryTerms)
        })
        if (entries.length > MAX_ROUTING_CANDIDATES) entries.pop()
      }
    }
    this.assertReadFence(fence)
    return { entries, unresolvedCount }
  }

  private async decryptShard(frame: EncryptedFrame, fence?: RawReadFence): Promise<readonly RoutingEntry[]> {
    try {
      assertEncryptedFrameEnvelope(frame, this.options.sessionId, this.options.projectScopeId, RETRIEVAL_ROUTING_SHARD_KIND, frame.metadata.artifactId, 'utf8')
    } catch {
      throw new RawSourceUnavailableError('Encrypted retrieval shard is unavailable')
    }
    const key = `shard:${frame.metadata.artifactId}`
    if (fence) this.assertReadFence(fence)
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.value as readonly RoutingEntry[]
    }
    const payload = await this.decryptJson<ShardPayload>(frame, fence)
    if (fence) this.assertReadFence(fence)
    if (!Array.isArray(payload.entries) || payload.entries.length > MAX_ROUTING_SHARD_ENTRIES) throw new RawSourceUnavailableError('Encrypted retrieval shard exceeds bounded chunk size')
    const value = Object.freeze(payload.entries.map(entry => Object.freeze({ ...entry, keywords: Object.freeze([...entry.keywords]) })))
    this.cacheValue(key, value)
    return value
  }

  private async readCapsule(capsuleId: string, fence: RawReadFence): Promise<Readonly<{ capsuleId: string; summary: string; keywords: readonly string[]; unresolved: boolean; tokenCount: number; sourceArtifactIds: readonly string[] }>> {
    const persisted = this.capsules.get(capsuleId)
    if (!persisted) throw new RawSourceUnavailableError()
    const payload = await this.decryptCapsulePayload(persisted.record, fence)
    this.assertReadFence(fence)
    return Object.freeze({ capsuleId, summary: payload.summary, keywords: Object.freeze([...payload.keywords]), unresolved: payload.unresolved, tokenCount: payload.tokenCount, sourceArtifactIds: Object.freeze([...payload.sourceArtifactIds]) })
  }

  private async decryptCapsulePayload(record: RawCapsuleRecord, fence?: RawReadFence): Promise<CapsulePayload> {
    try {
      assertEncryptedFrameEnvelope(record.frame, this.options.sessionId, this.options.projectScopeId, RAW_CAPSULE_ARTIFACT_KIND, record.capsuleId, 'utf8')
    } catch {
      throw new RawSourceUnavailableError('Encrypted capsule frame scope or identity mismatch')
    }
    let bytes: Uint8Array
    try {
      bytes = await this.options.cryptor.decrypt(record.frame)
    } catch {
      throw new RawSourceUnavailableError('Encrypted capsule frame is unavailable')
    }
    if (fence) this.assertReadFence(fence)
    if (record.frame.metadata.byteLength !== bytes.byteLength.toString(10)) throw new RawSourceUnavailableError('Encrypted capsule frame length metadata mismatch')
    let payload: CapsulePayload
    try {
      payload = parseJson(bytes) as CapsulePayload
    } catch {
      throw new RawSourceUnavailableError('Encrypted capsule frame is malformed')
    }
    if (payload.sourceKind !== RAW_TRANSCRIPT_ARTIFACT_KIND || payload.sourceArtifactIds.length === 0) throw new RawSourceUnavailableError('Capsule source provenance is invalid')
    return payload
  }

  private async decryptJson<T>(frame: EncryptedFrame, fence?: RawReadFence): Promise<T> {
    let bytes: Uint8Array
    try {
      bytes = await this.options.cryptor.decrypt(frame)
    } catch (error) {
      if (error instanceof RawCapsuleSessionDeletedError || error instanceof RawCapsuleSessionClosedError) throw error
      throw new RawSourceUnavailableError('Encrypted retrieval artifact is unavailable')
    }
    if (fence) this.assertReadFence(fence)
    if (frame.metadata.byteLength !== bytes.byteLength.toString(10)) throw new RawSourceUnavailableError('Encrypted retrieval frame length metadata mismatch')
    try {
      return parseJson(bytes) as T
    } catch {
      throw new RawSourceUnavailableError('Encrypted retrieval artifact is malformed')
    }
  }

  private cacheValue(key: string, value: unknown): void {
    const bytes = textBytes(JSON.stringify(value)).byteLength
    const prior = this.cache.get(key)
    if (prior) this.cacheBytes -= prior.bytes
    this.cache.set(key, { value, bytes })
    this.cacheBytes += bytes
    while (this.cacheBytes > this.maxPlaintextIndexBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (!oldest) break
      const removed = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (removed) this.cacheBytes -= removed.bytes
    }
  }
}
