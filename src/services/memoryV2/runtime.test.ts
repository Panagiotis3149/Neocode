import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildMemoryPromptForTransport,
  configureMemoryPromptV2BindingProvider,
  createMemoryPromptTransportQueue,
  hasRegisteredMemoryPrompt,
  loadMemoryPrompt,
  registerMemoryPromptSystemPrompt,
} from '../../memdir/memdir.js'
import { executeForgetCommand, executeSessionHistoryCommand, isMemoryV2CommandEnabled } from './commandHandlers.js'
import { initializeMemoryV2Runtime, shutdownMemoryV2Runtime, MemoryV2RuntimeUnavailableError } from './runtime.js'
import { getMemoryV2SkillRuntimeConfig } from './skillRuntimeConfig.js'
import { MEMORY_V2_EXTERNAL_BLOCKERS } from './featureGates.js'
import { createVerifiedGeneratedSkillMutationCapability } from '../generatedSkills/store.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import type { EncryptedRawCapsuleStore } from '../compact/rawCapsules.js'

describe('memory V2 runtime registration', () => {
  const directories: string[] = []

  afterEach(async () => {
    await shutdownMemoryV2Runtime()
    configureMemoryPromptV2BindingProvider(null)
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test('keeps legacy behavior explicit when the store gate is disabled', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      gates: {},
    })

    expect(runtime).toBeNull()
    expect(isMemoryV2CommandEnabled()).toBe(false)
  })

  test('publishes effective skill gates and verified runtime options to the product path', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true },
      generatedSkillOptions: {
        attestationKey: new Uint8Array(32).fill(4),
        mutationCapability: createVerifiedGeneratedSkillMutationCapability({
          rootPath: 'C:/verified-skills',
          fenceToken: 'runtime-fence',
          withWriterLease: async work => work(),
          createVersionBundle: async () => {},
          replaceManifest: async () => {},
        }),
      },
    })

    expect(runtime).not.toBeNull()
    const config = getMemoryV2SkillRuntimeConfig()
    expect(config.gates.AUTO_SKILL_GENERATION).toBe(true)
    expect(config.generatedSkillOptions?.attestationKey?.byteLength).toBe(32)
  })

  test('reports an unavailable Windows mutation capability before the survey path enables generation', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true },
      gateBlockers: {
        AUTO_SKILL_GENERATION: [MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE],
      },
    })

    expect(runtime?.gateResolution.AUTO_SKILL_GENERATION).toEqual({
      requested: true,
      effective: false,
      blockedBy: [MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE],
    })
    expect(getMemoryV2SkillRuntimeConfig().gateResolution?.AUTO_SKILL_GENERATION.effective).toBe(false)
  })

  test('keeps the independent skill runtime status when the memory store gate is off', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      gates: { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true },
      gateBlockers: {
        AUTO_SKILL_GENERATION: [MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE],
      },
    })

    expect(runtime).toBeNull()
    expect(getMemoryV2SkillRuntimeConfig().gateResolution?.SKILL_STORE_V2.effective).toBe(true)
    expect(getMemoryV2SkillRuntimeConfig().gateResolution?.AUTO_SKILL_GENERATION.blockedBy).toEqual([
      MEMORY_V2_EXTERNAL_BLOCKERS.WINDOWS_NOFOLLOW_MUTATION_UNAVAILABLE,
    ])
  })

  test('fails closed when the raw capsule store scope differs from the runtime', async () => {
    const rawCapsuleStore = { sessionId: 'other-session', projectScopeId: 'project-a', sessionRetentionDeadline: () => 10_000 } as unknown as EncryptedRawCapsuleStore
    await expect(initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, RETRIEVAL_COMPACTION: true },
      rawCapsuleStore,
    })).rejects.toThrow('session or project scope')
  })

  test('registers real scoped store, fence, provider, and command dependencies when enabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-runtime-'))
    directories.push(directory)
    const memoryDir = `${directory}/`
    writeFileSync(join(directory, 'MEMORY.md'), '- runtime snapshot\n', 'utf8')
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir,
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      sessionCryptoDelete: async () => {},
      purgeEncryptedArtifacts: async () => {},
      memoryPromptTransport: createMemoryPromptTransportQueue(),
    })

    expect(runtime?.store).toBeDefined()
    expect(runtime?.fence).toBeDefined()
    expect(isMemoryV2CommandEnabled()).toBe(true)
    await runtime!.store.mutate({
      requestId: 'runtime-prompt-memory',
      operation: 'create',
      record: {
        id: 'MEMORY.md',
        projectScopeId: 'project-a',
        type: 'user',
        name: 'Runtime snapshot',
        content: '- runtime snapshot',
      },
    })
    const envelope = buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir,
      transport: {
        enqueue: (payload, requestId) => Object.freeze({ accepted: true, requestId, payload }),
      },
    })
    expect(envelope.request.state).toBe('SEND_COMMITTED')
    expect(envelope.text).toContain('- runtime snapshot')
  })

  test('fails closed when an enabled provider cannot be bound', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir: 'C:/missing-memory-v2/',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      dbPath: ':memory:',
      memoryPromptTransport: createMemoryPromptTransportQueue(),
    })

    expect(runtime?.fence).toBeDefined()
    expect(() => buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir: 'C:/missing-memory-v2/',
      transport: { enqueue: () => null },
    })).toThrow(MemoryV2RuntimeUnavailableError)
  })

  test('does not enable hot snapshots without a transport binding', async () => {
    await expect(initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir: 'C:/missing-memory-v2/',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      dbPath: ':memory:',
    })).rejects.toThrow('transport binding is unavailable')
    expect(isMemoryV2CommandEnabled()).toBe(false)
  })

  test('routes forget through the scoped store tombstone and prompt revocation', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true },
      sessionCryptoDelete: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })
    if (!runtime) throw new Error('runtime was not enabled')
    await runtime.store.mutate({
      requestId: 'create-memory',
      operation: 'create',
      record: {
        id: 'memory-1',
        projectScopeId: 'project-a',
        type: 'user',
        name: 'Cat',
        content: 'Orbital',
      },
    })

    await expect(executeForgetCommand('memory-1')).resolves.toContain('Forgotten from durable memory.')
    expect(await runtime.store.get('memory-1', 'project-a')).toBeNull()
  })

  test('forget revokes hot snapshots that contain an individual store record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-forget-snapshot-'))
    directories.push(directory)
    const memoryDir = `${directory}/`
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir,
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      memoryPromptTransport: createMemoryPromptTransportQueue(),
    })
    if (!runtime) throw new Error('runtime was not enabled')
    await runtime.store.mutate({
      requestId: 'snapshot-memory',
      operation: 'create',
      record: { id: 'memory-1', projectScopeId: 'project-a', type: 'user', name: 'Cat', content: 'Orbital' },
    })

    const previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
    getAutoMemPath.cache.clear?.()
    try {
      const text = await loadMemoryPrompt()
      if (!text) throw new Error('memory prompt was not loaded')
      const systemPrompt = registerMemoryPromptSystemPrompt(asSystemPrompt([text]))
      expect(hasRegisteredMemoryPrompt(systemPrompt)).toBe(true)

      await executeForgetCommand('memory-1')

      expect(hasRegisteredMemoryPrompt(systemPrompt)).toBe(false)
    } finally {
      if (previousOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
      getAutoMemPath.cache.clear?.()
    }
  })

  test('forget routes the scoped record through the configured projection manager', async () => {
    const projectionCalls: Array<[string, string, string, string]> = []
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true },
      projectionManager: {
        forget: (recordId, projectScopeId, currentText, projectionPath) => {
          projectionCalls.push([recordId, projectScopeId, currentText, projectionPath])
          return { deleted: true, conflict: false }
        },
      },
      projectionPathForRecord: () => 'project-a/memory.md',
      projectionTextForRecord: () => 'managed projection',
    })
    if (!runtime) throw new Error('runtime was not enabled')
    await runtime.store.mutate({
      requestId: 'projection-memory',
      operation: 'create',
      record: { id: 'memory-1', projectScopeId: 'project-a', type: 'user', name: 'Cat', content: 'Orbital' },
    })

    await executeForgetCommand('memory-1')

    expect(projectionCalls).toEqual([['memory-1', 'project-a', 'managed projection', 'project-a/memory.md']])
  })

  test('shutdown clears the production provider and command registration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-runtime-'))
    directories.push(directory)
    const memoryDir = `${directory}/`
    writeFileSync(join(directory, 'MEMORY.md'), '- runtime snapshot\n', 'utf8')
    await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir,
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      sessionCryptoDelete: async () => {},
      purgeEncryptedArtifacts: async () => {},
      memoryPromptTransport: createMemoryPromptTransportQueue(),
    })

    await shutdownMemoryV2Runtime()

    expect(isMemoryV2CommandEnabled()).toBe(false)
    expect(() => buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir,
      transport: { enqueue: () => null },
    })).toThrow('binding is unavailable')
  })

  test('history deletion closes the store before remote deletion callbacks and stays closed on failure', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true },
      sessionCryptoDelete: async () => {
        await expect(runtime!.store.get('memory-1', 'project-a')).rejects.toThrow('not initialized')
        throw new Error('crypto failed')
      },
      purgeEncryptedArtifacts: async () => {
        throw new Error('purge must not run')
      },
    })
    if (!runtime) throw new Error('runtime was not enabled')
    await runtime.store.mutate({
      requestId: 'create-memory-for-delete',
      operation: 'create',
      record: { id: 'memory-1', projectScopeId: 'project-a', type: 'user', name: 'Cat', content: 'Orbital' },
    })

    await expect(executeSessionHistoryCommand('delete-history')).rejects.toThrow('crypto failed')
    await expect(runtime.store.get('memory-1', 'project-a')).rejects.toThrow('not initialized')
    await expect(runtime.store.mutate({
      requestId: 'write-after-delete-start',
      operation: 'delete',
      recordId: 'memory-1',
      projectScopeId: 'project-a',
    })).rejects.toThrow('not initialized')
  })

  test('history deletion without crypto dependencies fails closed before storage access', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true },
    })
    if (!runtime) throw new Error('runtime was not enabled')

    await expect(executeSessionHistoryCommand('delete-history')).rejects.toThrow('dependencies are unavailable')
    await expect(runtime.store.get('missing', 'project-a')).resolves.toBeNull()
    expect(runtime.fence.isAdmissionOpen()).toBe(true)
  })

  test('history deletion stays available when secure-store readiness is false', async () => {
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true },
      sessionCryptoAvailable: false,
      sessionCryptoDelete: async () => {},
      purgeEncryptedArtifacts: async () => {},
    })
    if (!runtime) throw new Error('runtime was not enabled')

    await expect(executeSessionHistoryCommand('delete-history')).rejects.toThrow('dependencies are unavailable')
    expect(runtime.fence.isAdmissionOpen()).toBe(true)
  })

  test('V2 prompt bindings use authoritative store records instead of MEMORY.md', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-authoritative-'))
    directories.push(directory)
    const memoryDir = `${directory}/`
    writeFileSync(join(directory, 'MEMORY.md'), '- stale projected content\n', 'utf8')
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir,
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      memoryPromptTransport: createMemoryPromptTransportQueue(),
    })
    if (!runtime) throw new Error('runtime was not enabled')
    await runtime.store.mutate({
      requestId: 'authoritative-memory',
      operation: 'create',
      record: {
        id: 'MEMORY.md',
        projectScopeId: 'project-a',
        type: 'user',
        name: 'Authoritative memory',
        content: '- authoritative store content',
      },
    })

    const envelope = buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir,
      transport: createMemoryPromptTransportQueue(),
    })

    expect(envelope.text).toContain('- authoritative store content')
    expect(envelope.text).not.toContain('- stale projected content')
  })

  test('closed history admission prevents provider reads after deletion starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neocode-memory-v2-runtime-'))
    directories.push(directory)
    const memoryDir = `${directory}/`
    writeFileSync(join(directory, 'MEMORY.md'), '- should not be read\n', 'utf8')
    const runtime = await initializeMemoryV2Runtime({
      sessionId: 'session-1',
      projectScopeId: 'project-a',
      memoryDir,
      dbPath: ':memory:',
      gates: { MEMORY_STORE_V2: true, MEMORY_HOT_SNAPSHOT: true },
      memoryPromptTransport: createMemoryPromptTransportQueue(),
      sessionCryptoDelete: async () => { throw new Error('crypto failed') },
      purgeEncryptedArtifacts: async () => {},
    })
    if (!runtime) throw new Error('runtime was not enabled')

    await expect(executeSessionHistoryCommand('delete-history')).rejects.toThrow('crypto failed')
    expect(() => buildMemoryPromptForTransport({
      displayName: 'Persistent Agent Memory',
      memoryDir,
      transport: createMemoryPromptTransportQueue(),
    })).toThrow('prompt admission is closed')
  })
})
