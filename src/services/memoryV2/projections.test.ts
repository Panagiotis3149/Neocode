import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ProjectionConflictError,
  ProjectionManager,
  type ProjectionManagerOptions,
  ProjectionPathError,
  ProjectionLockError,
  TombstonedProjectionError,
  renderMemoryProjection,
  ProjectionV2DisabledError,
  type ProjectionRecord,
} from './projections.js'
import { sha256ExactBytes } from './canonical.js'
import { createProjectionTestManager, type ProjectionFilesystemAdapter, type ProjectionLeaseFence } from './projections.testSupport.js'

function deterministicFilesystem(beforeConditional?: (path: string) => void, beforeCreate?: (path: string) => void): ProjectionFilesystemAdapter {
  const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  const fenceMatches = (path: string, fence: ProjectionLeaseFence): boolean => {
    if (fence.path !== path) return false
    try {
      const persisted = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as Partial<ProjectionLeaseFence>
       return persisted.owner === fence.owner && persisted.token === fence.token && persisted.generation === fence.generation && typeof persisted.expiresAt === 'number' && persisted.expiresAt > Date.now()
    } catch {
      return false
    }
  }
  return {
    readText,
    createIfAbsent(path, text, fence) {
      beforeCreate?.(path)
      if (!fenceMatches(path, fence)) return { status: 'fenced' }
      if (existsSync(path)) return { status: 'conflict', currentText: readText(path) ?? '' }
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
      return { status: 'created' }
    },
    replaceIfUnchanged(path, expectedBytes, expectedHash, fence, replacement) {
      beforeConditional?.(path)
      if (!fenceMatches(path, fence)) return { status: 'fenced' }
      const actual = readText(path)
      if (actual === null || actual !== expectedBytes || sha256ExactBytes(actual) !== expectedHash) return { status: 'conflict', currentText: actual ?? '' }
      writeFileSync(path, replacement, 'utf8')
      return { status: 'updated' }
    },
    deleteIfUnchanged(path, expectedBytes, expectedHash, fence) {
      beforeConditional?.(path)
      if (!fenceMatches(path, fence)) return { status: 'fenced' }
      const actual = readText(path)
      if (actual === null || actual !== expectedBytes || sha256ExactBytes(actual) !== expectedHash) return { status: 'conflict', currentText: actual ?? '' }
      unlinkSync(path)
      return { status: 'deleted' }
    },
  }
}

function managerOptions(directory: string): ProjectionManagerOptions {
  return { gates: { MEMORY_STORE_V2: true }, projectionRoot: directory }
}

const record: ProjectionRecord = {
  id: 'memory-1',
  projectScopeId: 'project-a',
  type: 'user',
  name: 'Preference',
  content: 'Use concise explanations.',
  pinned: false,
  version: 1,
  status: 'active',
}

describe('MemoryV2 projections', () => {
  it('renders deterministic managed Markdown with ownership metadata', () => {
    const rendered = renderMemoryProjection(record)
    expect(rendered).toContain('name: Preference')
    expect(rendered).toContain('id: memory-1')
    expect(rendered).toContain('version: "1"')
    expect(rendered).toContain('Use concise explanations.')
  })

  it('updates a projection when the last managed bytes are unchanged', () => {
    const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: tmpdir() })
    const initial = manager.materialize(record, '', 'project-a/memory.md')
    const next = { ...record, version: 2, content: 'Prefer concise explanations.' }
    const updated = manager.materialize(next, initial.text, 'project-a/memory.md')

    expect(updated.conflict).toBe(false)
    expect(updated.text).toContain('Prefer concise explanations.')
    expect(updated.text).not.toContain('Use concise explanations.')
  })

  it('preserves an external edit and reports a conflict', () => {
    const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: tmpdir() })
    const initial = manager.materialize(record, '', 'project-a/memory.md')
    const external = `${initial.text}\nUser-authored note.\n`

    expect(() => manager.materialize({ ...record, version: 2 }, external, 'project-a/memory.md')).toThrow(ProjectionConflictError)
    expect(manager.getConflict(record.id, record.projectScopeId)).toMatchObject({ externalText: external, recordId: record.id })
  })

  it('does not overwrite an unknown existing file', () => {
    const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: tmpdir() })
    const external = '# Existing user file\n'
    expect(() => manager.materialize(record, external, 'project-a/memory.md')).toThrow(ProjectionConflictError)
    expect(manager.getConflict(record.id, record.projectScopeId)?.externalText).toBe(external)
  })

  it('requires current exact bytes and durable ownership across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-projection-'))
    const ownershipPath = join(directory, 'ownership.json')
    try {
      const first = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, ownershipPath, projectionRoot: directory })
      expect(() => first.materialize(record, undefined, 'project-a/memory.md')).toThrow(TypeError)
      const initial = first.materialize(record, '', 'project-a/memory.md')

      const second = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, ownershipPath, projectionRoot: directory })
      expect(() => second.materialize({ ...record, version: 2 }, `${initial.text}\nexternal`, 'project-a/memory.md')).toThrow(ProjectionConflictError)
      const updated = second.materialize({ ...record, version: 2 }, initial.text, 'project-a/memory.md')
      expect(updated.version).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers a valid staged ownership file when the primary is damaged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-recovery-'))
    const ownershipPath = join(directory, 'ownership.json')
    try {
      const initial = renderMemoryProjection(record)
      writeFileSync(ownershipPath, '{corrupt', 'utf8')
      writeFileSync(
        `${ownershipPath}.next`,
        JSON.stringify({
          formatVersion: 1,
          generation: 7,
          entries: [{ recordId: record.id, projectScopeId: record.projectScopeId, hash: sha256ExactBytes(initial), version: 1 }],
        }),
        'utf8',
      )
      const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, ownershipPath, projectionRoot: directory })
      expect(manager.materialize({ ...record, version: 2 }, initial, 'project-a/memory.md').version).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not project tombstoned records', () => {
    const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: tmpdir() })
    expect(() => manager.materialize({ ...record, status: 'tombstoned' }, '', 'project-a/memory.md')).toThrow(TombstonedProjectionError)
  })

  it('is disabled unless the projection gate is effective', () => {
    const manager = new ProjectionManager()
    expect(() => manager.materialize(record, '', 'project-a/memory.md')).toThrow(ProjectionV2DisabledError)
  })

  it('uses structured ownership keys without delimiter collisions', () => {
    const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: tmpdir() })
    const first = { ...record, id: 'a', projectScopeId: 'b-c' }
    const second = { ...record, id: 'b-c', projectScopeId: 'a' }
    const firstProjection = manager.materialize(first, '', 'b-c/memory.md')
    const secondProjection = manager.materialize(second, '', 'a/memory.md')

    expect(manager.materialize({ ...first, version: 2 }, firstProjection.text, 'b-c/memory.md').version).toBe(2)
    expect(manager.materialize({ ...second, version: 2 }, secondProjection.text, 'a/memory.md').version).toBe(2)
  })

  it('uses a conditional capability for managed update and purge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-forget-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const initial = manager.write(record, '', 'project-a/memory.md')
      const projectionPath = join(directory, 'project-a', 'memory.md')
      const updated = manager.write({ ...record, version: 2, content: 'Updated through capability.' }, initial.text, 'project-a/memory.md')
      expect(readFileSync(projectionPath, 'utf8')).toBe(updated.text)
      expect(manager.forget(record.id, record.projectScopeId, updated.text, 'project-a/memory.md')).toEqual({ deleted: true, conflict: false })
      expect(existsSync(projectionPath)).toBe(false)

      const second = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: directory })
      const rendered = second.materialize(record, '', 'project-a/memory.md')
      writeFileSync(projectionPath, `${rendered.text}\nexternal edit\n`, 'utf8')
      expect(() => second.forget(record.id, record.projectScopeId, `${rendered.text}\nexternal edit\n`, 'project-a/memory.md')).toThrow(ProjectionConflictError)
      expect(existsSync(projectionPath)).toBe(true)

    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports changed targets through the conditional capability without loss', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-capability-conflict-'))
    try {
      const filesystem = deterministicFilesystem(path => writeFileSync(path, `${readFileSync(path, 'utf8')}\nchanged externally\n`, 'utf8'))
      const manager = createProjectionTestManager(managerOptions(directory), filesystem)
      const initial = manager.write(record, '', 'project-a/memory.md')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow(ProjectionConflictError)
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toContain('changed externally')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports changed delete targets through the conditional capability without loss', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-capability-delete-conflict-'))
    try {
      const filesystem = deterministicFilesystem(path => writeFileSync(path, `${readFileSync(path, 'utf8')}\nchanged externally\n`, 'utf8'))
      const manager = createProjectionTestManager(managerOptions(directory), filesystem)
      const initial = manager.write(record, '', 'project-a/memory.md')
      expect(() => manager.forget(record.id, record.projectScopeId, initial.text, 'project-a/memory.md')).toThrow(ProjectionConflictError)
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toContain('changed externally')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('discards a conditional result when the lease fencing token changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-lease-fencing-'))
    try {
      const filesystem = deterministicFilesystem(path => {
        const now = Date.now()
        writeFileSync(
          `${path}.lock`,
          JSON.stringify({ formatVersion: 1, generation: 2, owner: 'new-owner', token: 'new-token', createdAt: now, expiresAt: now + 60_000 }),
          'utf8',
        )
      })
      const manager = createProjectionTestManager(managerOptions(directory), filesystem)
      const initial = manager.write(record, '', 'project-a/memory.md')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow(ProjectionLockError)
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toBe(initial.text)
      const updatedText = renderMemoryProjection({ ...record, version: 2 })
      expect(() => manager.materialize({ ...record, version: 3 }, updatedText, 'project-a/memory.md')).toThrow(ProjectionConflictError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when existing-file mutation capability is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-capability-unsupported-'))
    try {
      const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: directory })
      const initial = manager.materialize(record, '', 'project-a/memory.md')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(join(directory, 'project-a', 'memory.md'), initial.text, 'utf8')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(() => manager.forget(record.id, record.projectScopeId, initial.text, 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toBe(initial.text)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never overwrites an existing projection during automatic mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-existing-write-'))
    try {
      const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: directory })
      const initial = manager.materialize(record, '', 'project-a/memory.md')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(join(directory, 'project-a', 'memory.md'), initial.text, 'utf8')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toBe(initial.text)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ignores an arbitrary public filesystem option', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-public-capability-'))
    try {
      const arbitraryFilesystem = deterministicFilesystem(() => {
        throw new Error('arbitrary adapter was installed')
      })
      const options = { ...managerOptions(directory), filesystem: arbitraryFilesystem } as unknown as ProjectionManagerOptions
      const manager = new ProjectionManager(options)
      const initial = manager.materialize(record, '', 'project-a/memory.md')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(join(directory, 'project-a', 'memory.md'), initial.text, 'utf8')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(readFileSync(join(directory, 'project-a', 'memory.md'), 'utf8')).toBe(initial.text)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never unlinks an existing projection during automatic forget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-existing-forget-'))
    try {
      const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: directory })
      const initial = manager.materialize(record, '', 'project-a/memory.md')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(join(directory, 'project-a', 'memory.md'), initial.text, 'utf8')
      expect(() => manager.forget(record.id, record.projectScopeId, initial.text, 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(existsSync(join(directory, 'project-a', 'memory.md'))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers an expired projection lease and removes its own lease', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-stale-lease-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const lockPath = join(directory, 'project-a', 'memory.md.lock')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(
        lockPath,
        JSON.stringify({ formatVersion: 1, generation: 1, owner: 'dead-owner', token: 'dead-token', createdAt: 1, expiresAt: 2 }),
        'utf8',
      )
      manager.write(record, '', 'project-a/memory.md')
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for unfenced production creation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-create-unsupported-'))
    try {
      const manager = new ProjectionManager({ gates: { MEMORY_STORE_V2: true }, projectionRoot: directory })
      expect(() => manager.write(record, '', 'project-a/memory.md')).toThrow('Projection mutation capability is unavailable')
      expect(existsSync(join(directory, 'project-a', 'memory.md'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not create or persist ownership when the lease is stolen during creation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-create-fencing-'))
    const ownershipPath = join(directory, 'ownership.json')
    try {
      const filesystem = deterministicFilesystem(undefined, path => {
        const now = Date.now()
        writeFileSync(
          `${path}.lock`,
          JSON.stringify({ formatVersion: 1, generation: 2, owner: 'new-owner', token: 'new-token', createdAt: now, expiresAt: now + 60_000 }),
          'utf8',
        )
      })
      const manager = createProjectionTestManager({ ...managerOptions(directory), ownershipPath }, filesystem)
      expect(() => manager.write(record, '', 'project-a/memory.md')).toThrow(ProjectionLockError)
      expect(existsSync(join(directory, 'project-a', 'memory.md'))).toBe(false)
      expect(existsSync(ownershipPath)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reclaims a crash-like malformed lease after its bounded expiry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-malformed-lease-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const lockPath = join(directory, 'project-a', 'memory.md.lock')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(lockPath, '', 'utf8')
      const expired = new Date(Date.now() - 60_000)
      utimesSync(lockPath, expired, expired)
      manager.write(record, '', 'project-a/memory.md')
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a non-expired malformed lease fail-closed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-live-malformed-lease-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const lockPath = join(directory, 'project-a', 'memory.md.lock')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(lockPath, '{}', 'utf8')
      expect(() => manager.write(record, '', 'project-a/memory.md')).toThrow(ProjectionLockError)
      expect(readFileSync(lockPath, 'utf8')).toBe('{}')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a live projection lease without deleting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-live-lease-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const lockPath = join(directory, 'project-a', 'memory.md.lock')
      mkdirSync(join(directory, 'project-a'), { recursive: true })
      writeFileSync(
        lockPath,
        JSON.stringify({ formatVersion: 1, generation: 1, owner: 'live-owner', token: 'live-token', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }),
        'utf8',
      )
      expect(() => manager.write(record, '', 'project-a/memory.md')).toThrow(ProjectionLockError)
      expect(readFileSync(lockPath, 'utf8')).toContain('live-token')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects absolute, escaping, and symlinked projection paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-paths-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      expect(() => manager.materialize(record, '', '../outside.md')).toThrow(ProjectionPathError)
      expect(() => manager.materialize(record, '', join(directory, 'project-a', 'memory.md'))).toThrow(ProjectionPathError)
      expect(() => manager.write(record, '', '../outside.md')).toThrow(ProjectionPathError)
      expect(() => manager.forget(record.id, record.projectScopeId, '', '../outside.md')).toThrow(ProjectionPathError)
      const outside = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-outside-'))
      try {
        const link = join(directory, 'project-a')
        let linkCreated = false
        try {
          const { symlinkSync } = require('node:fs') as typeof import('node:fs')
          symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
          linkCreated = true
        } catch {}
        if (linkCreated) {
          expect(() => manager.materialize(record, '', 'project-a/memory.md')).toThrow(ProjectionPathError)
        } else {
          expect(existsSync(link)).toBe(false)
        }
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when a projection lock is held', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-lock-'))
    try {
      const manager = createProjectionTestManager(managerOptions(directory), deterministicFilesystem())
      const lockPath = join(directory, 'project-a', 'memory.md.lock')
      const initial = manager.write(record, '', 'project-a/memory.md')
      writeFileSync(lockPath, 'held', 'utf8')
      expect(() => manager.write({ ...record, version: 2 }, initial.text, 'project-a/memory.md')).toThrow(ProjectionLockError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
