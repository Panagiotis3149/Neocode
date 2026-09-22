import { closeSync, existsSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalize, sha256ExactBytes } from './canonical.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from './featureGates.js'
import {
  createVerifiedProjectionFilesystem,
  isVerifiedProjectionFilesystem,
  projectionFilesystemOption,
  type ProjectionFilesystem,
  type ProjectionLeaseFence,
} from './projectionFilesystemCapability.js'

export type ProjectionRecord = {
  id: string
  projectScopeId: string
  type: string
  name: string
  description?: string
  content: string
  pinned: boolean
  version: number
  status: 'active' | 'tombstoned'
}

export type ProjectionResult = {
  text: string
  hash: string
  conflict: false
  recordId: string
  projectScopeId: string
  version: number
}

export type ProjectionConflict = {
  recordId: string
  projectScopeId: string
  externalText: string
  managedText: string | null
}

export type ProjectionManagerOptions = {
  gates?: FeatureGateRequest
  ownershipPath?: string
  projectionRoot?: string
  leaseDurationMs?: number
}

export type ProjectionPurgeResult = {
  deleted: boolean
  conflict: false
}

export class ProjectionConflictError extends Error {
  readonly conflict: ProjectionConflict

  constructor(conflict: ProjectionConflict) {
    super(`Managed memory projection has an external edit: ${conflict.recordId}`)
    this.name = 'ProjectionConflictError'
    this.conflict = conflict
  }
}

export class TombstonedProjectionError extends Error {
  constructor(recordId: string) {
    super(`Tombstoned memory cannot be projected: ${recordId}`)
    this.name = 'TombstonedProjectionError'
  }
}

export class ProjectionV2DisabledError extends Error {
  constructor() {
    super('Memory V2 projection gate is not effective')
    this.name = 'ProjectionV2DisabledError'
  }
}

export class ProjectionPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionPathError'
  }
}

export class ProjectionLockError extends Error {
  constructor(path: string) {
    super(`Projection is locked or cannot be locked: ${path}`)
    this.name = 'ProjectionLockError'
  }
}

export class ProjectionMutationUnavailableError extends Error {
  constructor(path: string) {
    super(`Projection mutation capability is unavailable: ${path}`)
    this.name = 'ProjectionMutationUnavailableError'
  }
}

const defaultProjectionFilesystem: ProjectionFilesystem = createVerifiedProjectionFilesystem({
  readText(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  },
  createIfAbsent(path) {
    throw new ProjectionMutationUnavailableError(path)
  },
  replaceIfUnchanged(path) {
    throw new ProjectionMutationUnavailableError(path)
  },
  deleteIfUnchanged(path) {
    throw new ProjectionMutationUnavailableError(path)
  },
})

type Ownership = {
  recordId: string
  projectScopeId: string
  hash: string
  version: number
}

type OwnershipFile = {
  formatVersion: 1
  generation: number
  entries: Ownership[]
}

type ProjectionLease = {
  formatVersion: 1
  generation: number
  owner: string
  token: string
  createdAt: number
  expiresAt: number
}

type LeaseFileState = {
  exists: boolean
  malformed: boolean
  lease: ProjectionLease | null
  mtimeMs: number
  size: number
}

const DEFAULT_PROJECTION_LEASE_MS = 5_000
const MAX_PROJECTION_LEASE_MS = 30_000

function formatScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value)) return value
  return JSON.stringify(value)
}

function ownershipKey(recordId: string, projectScopeId: string): string {
  if (!recordId || !projectScopeId) throw new TypeError('Projection id and project scope are required')
  return canonicalize({ projectScopeId, recordId })
}

export function renderMemoryProjection(record: ProjectionRecord): string {
  if (record.status === 'tombstoned') throw new TombstonedProjectionError(record.id)
  const description = record.description === undefined ? '' : record.description
  return [
    '---',
    `id: ${formatScalar(record.id)}`,
    `projectScopeId: ${formatScalar(record.projectScopeId)}`,
    `type: ${formatScalar(record.type)}`,
    `name: ${formatScalar(record.name)}`,
    `version: "${record.version.toString(10)}"`,
    `pinned: ${record.pinned ? 'true' : 'false'}`,
    '---',
    description,
    record.content,
    '',
  ].join('\n')
}

export class ProjectionManager {
  private readonly gates: FeatureGateRequest
  private readonly ownershipPath: string | undefined
  private readonly projectionRoot: string | undefined
  private readonly leaseDurationMs: number
  private readonly ownerId = randomUUID()
  private readonly filesystem: ProjectionFilesystem
  private readonly ownership = new Map<string, Ownership>()
  private readonly conflicts = new Map<string, ProjectionConflict>()
  private ownershipGeneration = 0

  constructor(options: ProjectionManagerOptions = {}) {
    this.gates = options.gates ?? {}
    this.ownershipPath = options.ownershipPath
    this.projectionRoot = options.projectionRoot ? this.canonicalizeRoot(options.projectionRoot) : undefined
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_PROJECTION_LEASE_MS
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0 || this.leaseDurationMs > MAX_PROJECTION_LEASE_MS) throw new TypeError('Projection lease duration must be a bounded positive safe integer')
    const internalOptions = options as ProjectionManagerOptions & { [projectionFilesystemOption]?: ProjectionFilesystem }
    const candidate = internalOptions[projectionFilesystemOption]
    this.filesystem = isVerifiedProjectionFilesystem(candidate) ? candidate : defaultProjectionFilesystem
    this.loadOwnership()
  }

  materialize(record: ProjectionRecord, currentText: string | undefined, relativePath: string): ProjectionResult {
    this.requireEnabled()
    const projection = this.buildProjection(record, currentText, relativePath)
    this.commitProjection(record, projection)
    return projection
  }

  private buildProjection(record: ProjectionRecord, currentText: string | undefined, relativePath: string): ProjectionResult {
    if (record.status === 'tombstoned') throw new TombstonedProjectionError(record.id)
    if (currentText === undefined) throw new TypeError('Current projection bytes are required')
    this.safeProjectionPath(record.projectScopeId, relativePath)
    const key = ownershipKey(record.id, record.projectScopeId)
    const owned = this.ownership.get(key)
    const currentHash = sha256ExactBytes(currentText)
    if (!owned && currentText !== '') return this.recordConflict(record, currentText, null)
    if (owned && (owned.projectScopeId !== record.projectScopeId || owned.hash !== currentHash)) {
      return this.recordConflict(record, currentText, null)
    }
    const text = renderMemoryProjection(record)
    const hash = sha256ExactBytes(text)
    return { text, hash, conflict: false, recordId: record.id, projectScopeId: record.projectScopeId, version: record.version }
  }

  private commitProjection(record: ProjectionRecord, projection: ProjectionResult): void {
    const key = ownershipKey(record.id, record.projectScopeId)
    this.ownership.set(key, {
      recordId: record.id,
      projectScopeId: record.projectScopeId,
      hash: projection.hash,
      version: record.version,
    })
    this.persistOwnership()
    this.conflicts.delete(key)
  }

  write(record: ProjectionRecord, currentText: string | undefined, relativePath: string): ProjectionResult {
    this.requireEnabled()
    const path = this.safeProjectionPath(record.projectScopeId, relativePath)
    if (currentText === undefined) throw new TypeError('Current projection bytes are required')
    mkdirSync(dirname(path), { recursive: true })
    return this.withProjectionLease(record.projectScopeId, relativePath, (lockedPath, lease) => {
      this.safeProjectionPath(record.projectScopeId, relativePath)
      const existingText = this.filesystem.readText(lockedPath)
      const actual = existingText ?? ''
      if (actual !== currentText) return this.recordConflict(record, actual, null)
      const result = this.buildProjection(record, actual, relativePath)
      this.renewProjectionLease(record.projectScopeId, relativePath, lease)
      if (existingText === null) {
        const mutation = this.filesystem.createIfAbsent(lockedPath, result.text, this.toLeaseFence(lockedPath, lease))
        if (mutation.status === 'fenced') throw new ProjectionLockError(lockedPath)
        if (mutation.status === 'conflict') return this.recordConflict(record, mutation.currentText ?? '', null)
        if (mutation.status !== 'created') throw new ProjectionMutationUnavailableError(lockedPath)
      } else {
        const mutation = this.filesystem.replaceIfUnchanged(lockedPath, existingText, sha256ExactBytes(existingText), this.toLeaseFence(lockedPath, lease), result.text)
        if (mutation.status === 'fenced') throw new ProjectionLockError(lockedPath)
        if (mutation.status === 'conflict') return this.recordConflict(record, mutation.currentText ?? existingText, null)
        if (mutation.status !== 'updated') throw new ProjectionMutationUnavailableError(lockedPath)
      }
      this.commitProjection(record, result)
      return result
    })
  }

  getConflict(recordId: string, projectScopeId: string): ProjectionConflict | null {
    this.requireEnabled()
    return this.conflicts.get(ownershipKey(recordId, projectScopeId)) ?? null
  }

  clearConflict(recordId: string, projectScopeId: string): void {
    this.requireEnabled()
    this.conflicts.delete(ownershipKey(recordId, projectScopeId))
  }

  forget(recordId: string, projectScopeId: string, currentText: string, projectionPath: string): ProjectionPurgeResult {
    this.requireEnabled()
    const key = ownershipKey(recordId, projectScopeId)
    if (typeof currentText !== 'string' || !projectionPath) throw new TypeError('Current bytes and projection path are required')
    this.safeProjectionPath(projectScopeId, projectionPath)
    return this.withProjectionLease(projectScopeId, projectionPath, (path, lease) => {
      this.safeProjectionPath(projectScopeId, projectionPath)
      const actualTextValue = this.filesystem.readText(path)
      const actualText = actualTextValue ?? ''
      if (actualText !== currentText) return this.recordConflictValues(recordId, projectScopeId, actualText)
      const owned = this.ownership.get(key)
      if (actualTextValue === null) {
        if (!owned) {
          return { deleted: false, conflict: false }
        }
        this.ownership.delete(key)
        this.conflicts.delete(key)
        this.persistOwnership()
        return { deleted: false, conflict: false }
      }
      if (!owned || sha256ExactBytes(actualText) !== owned.hash) return this.recordConflictValues(recordId, projectScopeId, actualText)
      this.renewProjectionLease(projectScopeId, projectionPath, lease)
      const mutation = this.filesystem.deleteIfUnchanged(path, actualText, sha256ExactBytes(actualText), this.toLeaseFence(path, lease))
      if (mutation.status === 'fenced') throw new ProjectionLockError(path)
      if (mutation.status === 'conflict') return this.recordConflictValues(recordId, projectScopeId, mutation.currentText ?? actualText)
      if (mutation.status !== 'deleted') throw new ProjectionMutationUnavailableError(path)
      this.ownership.delete(key)
      this.conflicts.delete(key)
      this.persistOwnership()
      return { deleted: true, conflict: false }
    })
  }

  private recordConflict(record: ProjectionRecord, externalText: string, managedText: string | null): never {
    const conflict: ProjectionConflict = {
      recordId: record.id,
      projectScopeId: record.projectScopeId,
      externalText,
      managedText,
    }
    this.conflicts.set(ownershipKey(record.id, record.projectScopeId), conflict)
    throw new ProjectionConflictError(conflict)
  }

  private recordConflictValues(recordId: string, projectScopeId: string, externalText: string): never {
    const conflict: ProjectionConflict = { recordId, projectScopeId, externalText, managedText: null }
    this.conflicts.set(ownershipKey(recordId, projectScopeId), conflict)
    throw new ProjectionConflictError(conflict)
  }

  private requireEnabled(): void {
    if (!isFeatureGateEnabled('MEMORY_STORE_V2', this.gates)) throw new ProjectionV2DisabledError()
  }

  private canonicalizeRoot(root: string): string {
    mkdirSync(root, { recursive: true })
    return realpathSync(root)
  }

  private safeProjectionPath(projectScopeId: string, relativePath: string): string {
    if (!this.projectionRoot) throw new ProjectionPathError('A canonical projection root is required')
    if (!projectScopeId || !relativePath || relativePath.includes('\u0000')) throw new ProjectionPathError('Projection scope and path are required')
    const normalized = relativePath.replaceAll('\\', '/')
    if (isAbsolute(relativePath) || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
      throw new ProjectionPathError('Projection path must be relative')
    }
    const segments = normalized.split('/')
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new ProjectionPathError('Projection path contains unsafe segments')
    }
    if (segments[0] !== projectScopeId || !/^[A-Za-z0-9._-]+$/.test(projectScopeId) || projectScopeId === '.' || projectScopeId === '..') {
      throw new ProjectionPathError('Projection path is not bound to its project scope')
    }
    const candidate = resolve(this.projectionRoot, ...segments)
    const outside = relative(this.projectionRoot, candidate)
    if (!outside || outside.startsWith('..') || isAbsolute(outside)) throw new ProjectionPathError('Projection path escapes its root')
    let realRoot: string
    try {
      realRoot = realpathSync(this.projectionRoot)
    } catch {
      throw new ProjectionPathError('Projection root cannot be resolved')
    }
    if (realRoot !== this.projectionRoot) throw new ProjectionPathError('Projection root changed')
    let current = this.projectionRoot
    for (const segment of segments) {
      current = join(current, segment)
      let component
      try {
        component = lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw new ProjectionPathError('Projection path cannot be inspected')
      }
      if (component.isSymbolicLink()) throw new ProjectionPathError('Projection path traverses a symlink or junction')
      let realComponent: string
      try {
        realComponent = realpathSync(current)
      } catch {
        throw new ProjectionPathError('Projection path cannot be resolved')
      }
      const componentOutside = relative(realRoot, realComponent)
      if (componentOutside.startsWith('..') || isAbsolute(componentOutside)) {
        throw new ProjectionPathError('Projection path resolves outside its root')
      }
    }
    return candidate
  }

  private withProjectionLease<T>(projectScopeId: string, relativePath: string, work: (path: string, lease: ProjectionLease) => T): T {
    const path = this.safeProjectionPath(projectScopeId, relativePath)
    const lease = this.acquireProjectionLease(projectScopeId, relativePath)
    try {
      this.safeProjectionPath(projectScopeId, relativePath)
      return work(path, lease)
    } finally {
      this.releaseProjectionLease(projectScopeId, relativePath, lease)
    }
  }

  private acquireProjectionLease(projectScopeId: string, relativePath: string): ProjectionLease {
    const path = this.safeProjectionPath(projectScopeId, relativePath)
    const lockRelativePath = `${relativePath}.lock`
    const lockPath = this.safeProjectionPath(projectScopeId, lockRelativePath)
    mkdirSync(dirname(path), { recursive: true })
    this.safeProjectionPath(projectScopeId, relativePath)
    let lease: ProjectionLease = {
      formatVersion: 1,
      generation: 1,
      owner: this.ownerId,
      token: randomUUID(),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.leaseDurationMs,
    }
    try {
      this.createLeaseFile(projectScopeId, lockRelativePath, lockPath, lease)
      return lease
    } catch {
      this.safeProjectionPath(projectScopeId, lockRelativePath)
      if (!existsSync(lockPath)) throw new ProjectionLockError(path)
    }

    const state = this.readLeaseState(projectScopeId, lockRelativePath, lockPath)
    if (!state.exists) throw new ProjectionLockError(path)
    if (!state.lease) {
      if (!state.malformed || Date.now() - state.mtimeMs <= MAX_PROJECTION_LEASE_MS) throw new ProjectionLockError(path)
      return this.reclaimMalformedLease(projectScopeId, relativePath, path, lockRelativePath, lockPath, state)
    }
    const currentLease = state.lease
    if (currentLease.expiresAt > Date.now()) throw new ProjectionLockError(path)
    if (currentLease.generation >= Number.MAX_SAFE_INTEGER) throw new ProjectionLockError(path)
    lease = { ...lease, generation: currentLease.generation + 1, createdAt: Date.now(), expiresAt: Date.now() + this.leaseDurationMs }
    this.safeProjectionPath(projectScopeId, relativePath)
    this.safeProjectionPath(projectScopeId, lockRelativePath)
    const staleRelativePath = `${lockRelativePath}.stale-${lease.token}`
    const stalePath = this.safeProjectionPath(projectScopeId, staleRelativePath)
    try {
      renameSync(lockPath, stalePath)
    } catch {
      throw new ProjectionLockError(path)
    }
    const moved = this.readLeaseFile(projectScopeId, staleRelativePath, stalePath)
    if (!moved || moved.owner !== currentLease.owner || moved.token !== currentLease.token || moved.expiresAt > Date.now()) {
      if (moved && moved.owner === currentLease.owner && moved.token === currentLease.token) {
        this.restoreOrReleaseStaleLease(projectScopeId, lockRelativePath, lockPath, staleRelativePath, stalePath, moved)
      }
      throw new ProjectionLockError(path)
    }
    try {
      this.createLeaseFile(projectScopeId, lockRelativePath, lockPath, lease)
    } catch {
      this.restoreOrReleaseStaleLease(projectScopeId, lockRelativePath, lockPath, staleRelativePath, stalePath, moved)
      throw new ProjectionLockError(path)
    }
    try {
      this.safeProjectionPath(projectScopeId, staleRelativePath)
      unlinkSync(stalePath)
    } catch {
      throw new ProjectionLockError(path)
    }
    return lease
  }

  private reclaimMalformedLease(
    projectScopeId: string,
    relativePath: string,
    path: string,
    lockRelativePath: string,
    lockPath: string,
    state: LeaseFileState,
  ): ProjectionLease {
    const lease: ProjectionLease = {
      formatVersion: 1,
      generation: 1,
      owner: this.ownerId,
      token: randomUUID(),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.leaseDurationMs,
    }
    const quarantineRelativePath = `${lockRelativePath}.quarantine-${lease.token}`
    const quarantinePath = this.safeProjectionPath(projectScopeId, quarantineRelativePath)
    try {
      this.safeProjectionPath(projectScopeId, relativePath)
      this.safeProjectionPath(projectScopeId, lockRelativePath)
      renameSync(lockPath, quarantinePath)
    } catch {
      throw new ProjectionLockError(path)
    }
    const moved = this.readLeaseState(projectScopeId, quarantineRelativePath, quarantinePath)
    if (!moved.exists || !moved.malformed || moved.mtimeMs !== state.mtimeMs || moved.size !== state.size) throw new ProjectionLockError(path)
    try {
      this.createLeaseFile(projectScopeId, lockRelativePath, lockPath, lease)
    } catch {
      throw new ProjectionLockError(path)
    }
    try {
      this.safeProjectionPath(projectScopeId, quarantineRelativePath)
      const quarantined = statSync(quarantinePath)
      if (quarantined.mtimeMs !== state.mtimeMs || quarantined.size !== state.size) throw new ProjectionLockError(path)
      unlinkSync(quarantinePath)
    } catch {
      throw new ProjectionLockError(path)
    }
    return lease
  }

  private createLeaseFile(projectScopeId: string, relativePath: string, lockPath: string, lease: ProjectionLease): void {
    const temporaryRelativePath = `${relativePath}.new-${lease.token}`
    const temporaryPath = this.safeProjectionPath(projectScopeId, temporaryRelativePath)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporaryPath, 'wx')
      writeFileSync(descriptor, JSON.stringify(lease), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.safeProjectionPath(projectScopeId, relativePath)
      linkSync(temporaryPath, lockPath)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporaryPath)) {
        this.safeProjectionPath(projectScopeId, temporaryRelativePath)
        unlinkSync(temporaryPath)
      }
    }
  }

  private readLeaseFile(projectScopeId: string, relativePath: string, lockPath: string): ProjectionLease | null {
    return this.readLeaseState(projectScopeId, relativePath, lockPath).lease
  }

  private readLeaseState(projectScopeId: string, relativePath: string, lockPath: string): LeaseFileState {
    this.safeProjectionPath(projectScopeId, relativePath)
    let stats
    try {
      stats = statSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, malformed: false, lease: null, mtimeMs: 0, size: 0 }
      return { exists: true, malformed: false, lease: null, mtimeMs: 0, size: 0 }
    }
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ProjectionLease>
      if (
        parsed.formatVersion !== 1 ||
        typeof parsed.generation !== 'number' ||
        !Number.isSafeInteger(parsed.generation) ||
        parsed.generation < 1 ||
        typeof parsed.owner !== 'string' ||
        typeof parsed.token !== 'string' ||
        typeof parsed.createdAt !== 'number' ||
        !Number.isSafeInteger(parsed.createdAt) ||
        typeof parsed.expiresAt !== 'number' ||
        !Number.isSafeInteger(parsed.expiresAt) ||
        parsed.expiresAt <= parsed.createdAt
      ) return { exists: true, malformed: true, lease: null, mtimeMs: stats.mtimeMs, size: stats.size }
      return { exists: true, malformed: false, lease: parsed as ProjectionLease, mtimeMs: stats.mtimeMs, size: stats.size }
    } catch {
      return { exists: true, malformed: true, lease: null, mtimeMs: stats.mtimeMs, size: stats.size }
    }
  }

  private renewProjectionLease(projectScopeId: string, relativePath: string, lease: ProjectionLease): void {
    const lockRelativePath = `${relativePath}.lock`
    const lockPath = this.safeProjectionPath(projectScopeId, lockRelativePath)
    const current = this.readLeaseFile(projectScopeId, lockRelativePath, lockPath)
    if (!current || current.owner !== lease.owner || current.token !== lease.token || current.generation !== lease.generation || current.expiresAt <= Date.now()) {
      throw new ProjectionLockError(lockPath)
    }
    const renewed = { ...current, expiresAt: Date.now() + this.leaseDurationMs }
    this.safeProjectionPath(projectScopeId, lockRelativePath)
    const descriptor = openSync(lockPath, 'r+')
    try {
      ftruncateSync(descriptor, 0)
      writeFileSync(descriptor, JSON.stringify(renewed), 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    lease.expiresAt = renewed.expiresAt
    this.assertProjectionLease(projectScopeId, relativePath, lease)
  }

  private toLeaseFence(path: string, lease: ProjectionLease): ProjectionLeaseFence {
    return Object.freeze({ path, owner: lease.owner, token: lease.token, generation: lease.generation, expiresAt: lease.expiresAt })
  }

  private assertProjectionLease(projectScopeId: string, relativePath: string, lease: ProjectionLease): void {
    const lockRelativePath = `${relativePath}.lock`
    const lockPath = this.safeProjectionPath(projectScopeId, lockRelativePath)
    const current = this.readLeaseFile(projectScopeId, lockRelativePath, lockPath)
    if (!current || current.owner !== lease.owner || current.token !== lease.token || current.generation !== lease.generation || current.expiresAt <= Date.now()) {
      throw new ProjectionLockError(lockPath)
    }
  }

  private restoreOrReleaseStaleLease(
    projectScopeId: string,
    lockRelativePath: string,
    lockPath: string,
    staleRelativePath: string,
    stalePath: string,
    moved: ProjectionLease | null,
  ): void {
    if (!moved) return
    this.safeProjectionPath(projectScopeId, lockRelativePath)
    this.safeProjectionPath(projectScopeId, staleRelativePath)
    try {
      if (!existsSync(lockPath)) renameSync(stalePath, lockPath)
      else unlinkSync(stalePath)
    } catch {
      throw new ProjectionLockError(lockPath)
    }
  }

  private releaseProjectionLease(projectScopeId: string, relativePath: string, lease: ProjectionLease): void {
    const lockRelativePath = `${relativePath}.lock`
    const lockPath = this.safeProjectionPath(projectScopeId, lockRelativePath)
    const current = this.readLeaseFile(projectScopeId, lockRelativePath, lockPath)
    if (!current || current.owner !== lease.owner || current.token !== lease.token || current.generation !== lease.generation) throw new ProjectionLockError(lockPath)
    this.safeProjectionPath(projectScopeId, lockRelativePath)
    try {
      unlinkSync(lockPath)
    } catch {
      throw new ProjectionLockError(lockPath)
    }
  }

  private loadOwnership(): void {
    if (!this.ownershipPath) return
    const candidates = [this.ownershipPath, `${this.ownershipPath}.next`, `${this.ownershipPath}.bak`]
      .map((path, priority) => ({ path, priority, value: this.readOwnershipCandidate(path) }))
      .filter(candidate => candidate.value !== null) as Array<{ path: string; priority: number; value: OwnershipFile }>
    candidates.sort((left, right) => right.value.generation - left.value.generation || left.priority - right.priority)
    const selected = candidates[0]
    if (!selected) return
    this.ownershipGeneration = selected.value.generation
    for (const entry of selected.value.entries) this.ownership.set(ownershipKey(entry.recordId, entry.projectScopeId), entry)
  }

  private persistOwnership(): void {
    if (!this.ownershipPath) return
    mkdirSync(dirname(this.ownershipPath), { recursive: true })
    const temporaryPath = `${this.ownershipPath}.next`
    const backupPath = `${this.ownershipPath}.bak`
    const contents: OwnershipFile = {
      formatVersion: 1,
      generation: ++this.ownershipGeneration,
      entries: [...this.ownership.values()],
    }
    writeFileSync(temporaryPath, JSON.stringify(contents), 'utf8')
    const descriptor = openSync(temporaryPath, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (existsSync(this.ownershipPath)) {
      if (existsSync(backupPath)) unlinkSync(backupPath)
      renameSync(this.ownershipPath, backupPath)
    }
    try {
      renameSync(temporaryPath, this.ownershipPath)
    } catch (error) {
      if (!existsSync(this.ownershipPath) && existsSync(backupPath)) renameSync(backupPath, this.ownershipPath)
      throw error
    }
    if (existsSync(backupPath)) unlinkSync(backupPath)
  }

  private readOwnershipCandidate(path: string): OwnershipFile | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as OwnershipFile | Ownership[]
      if (Array.isArray(parsed)) return { formatVersion: 1, generation: 0, entries: parsed }
      if (parsed.formatVersion !== 1 || !Number.isSafeInteger(parsed.generation) || !Array.isArray(parsed.entries)) return null
      const entries = parsed.entries.filter(
        entry => entry && typeof entry.recordId === 'string' && typeof entry.projectScopeId === 'string' && typeof entry.hash === 'string',
      )
      return { formatVersion: 1, generation: parsed.generation, entries }
    } catch {
      return null
    }
  }
}
