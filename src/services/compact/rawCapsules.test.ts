import { describe, expect, test } from 'bun:test'

import {
  decryptEncryptedFrame,
  encryptEncryptedFrame,
  type EncryptedFrame,
} from '../sessionCrypto/encryptedFrames.js'
import {
  CapsuleSecretError,
  BunSqliteRawCapsulePersistence,
  RawCapsulesDisabledError,
  RawSourceUnavailableError,
  RawCapsulePersistenceUnavailableError,
  RawCapsuleSessionClosedError,
  MemoryRawCapsulePersistence,
  EncryptedRawCapsuleStore,
  sanitizeCompactionPayload,
  validateCompactionSanitizedOutput,
  CompactionBinaryValueError,
  type RawCapsuleDraft,
} from './rawCapsules.js'

const key = new Uint8Array(32).fill(11)
const prefix = new Uint8Array([9, 8, 7, 6])

function cryptor() {
  let counter = 0n
  return {
    encrypt: async (input: { projectScopeId: string; artifactKind: string; artifactId: string; plaintext: Uint8Array; timestamp: bigint }) => encryptEncryptedFrame({
      key,
      noncePrefix32: prefix,
      nonceCounter: counter++,
      metadata: {
        formatVersion: 'session-frame-v1',
        sessionId: 'session-1',
        projectScopeId: input.projectScopeId,
        keyEpoch: '1',
        keyId: 'test-key',
        artifactKind: input.artifactKind,
        artifactId: input.artifactId,
        contentEncoding: 'utf8',
        timestamp: input.timestamp.toString(10),
      },
      plaintext: input.plaintext,
    }),
    decrypt: async (frame: EncryptedFrame) => decryptEncryptedFrame({ key, frame }),
  }
}

function makeStore() {
  return new EncryptedRawCapsuleStore({
    sessionId: 'session-1',
    projectScopeId: 'project-1',
    sessionRetentionDeadline: 10_000,
    now: () => 1_000,
    tokenCounter: text => {
      const value = JSON.parse(text) as unknown
      return Array.isArray(value) ? value.length * 3 : 3
    },
    gates: { RETRIEVAL_COMPACTION: true },
    cryptor: cryptor(),
    persistence: new MemoryRawCapsulePersistence(),
  })
}

async function addRaw(store: EncryptedRawCapsuleStore, artifactId: string, text: string, sequence: bigint = 1n) {
  return store.appendRaw({
    artifactId,
    sequence,
    timestamp: 1_000,
    retentionDeadline: 8_000,
    content: text,
  })
}

describe('raw-only encrypted capsules', () => {
  test('is disabled unless retrieval compaction is explicitly enabled', async () => {
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })

    await expect(addRaw(store, 'raw-1', 'hello')).rejects.toBeInstanceOf(RawCapsulesDisabledError)
  })

  test('persists encrypted immutable raw frames without plaintext', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-1', 'private conversation text', 4n)

    const persisted = JSON.stringify(store.inspectPersistedState())
    expect(persisted).not.toContain('private conversation text')
    expect(store.inspectPersistedState().raw[0]?.frame.metadata.artifactKind).toBe('raw-transcript-v1')
    await expect(addRaw(store, 'raw-1', 'replacement')).rejects.toThrow('immutable')
    await expect(store.readRaw('raw-1')).resolves.toMatchObject({ content: 'private conversation text' })
  })

  test('sanitizes raw input before summarization and rejects secret-bearing artifacts', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-1', 'AWS_ACCESS_KEY_ID=AKIAAAAAAAAAAAAAAAAA')
    let seen = ''
    const capsule = await store.createCapsule({
      capsuleId: 'capsule-1',
      rawArtifactIds: ['raw-1'],
      summarize: async input => {
        seen = input.text
        return { summary: 'The user supplied [REDACTED:AWS Access Token:1].', keywords: ['credential'], unresolved: false }
      },
    })

    expect(seen).toContain('[REDACTED:AWS Access Token:1]')
    expect(seen).not.toContain('AKIAAAAAAAAAAAAAAAAA')
    expect(capsule.sourceKind).toBe('raw-transcript-v1')

    await expect(store.createCapsule({
      capsuleId: 'capsule-secret',
      rawArtifactIds: ['raw-1'],
      summarize: async () => ({ summary: 'AKIAAAAAAAAAAAAAAAAA', keywords: [], unresolved: false }),
    })).rejects.toBeInstanceOf(CapsuleSecretError)
  })

  test('never accepts a capsule as a compaction source and fails closed when raw is unavailable', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-1', 'raw text')
    await expect(store.createCapsule({
      capsuleId: 'capsule-1',
      rawArtifactIds: ['capsule-1'],
      summarize: async () => ({ summary: 'should not run', keywords: [], unresolved: false }),
    })).rejects.toBeInstanceOf(RawSourceUnavailableError)

    const missing = makeStore()
    await expect(missing.createCapsule({
      capsuleId: 'capsule-2',
      rawArtifactIds: ['raw-missing'],
      summarize: async () => ({ summary: 'should not run', keywords: [], unresolved: false }),
    })).rejects.toBeInstanceOf(RawSourceUnavailableError)
  })

  test('prioritizes unresolved capsules without exceeding the retrieval budget', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-1', 'one')
    const drafts: RawCapsuleDraft[] = [
      { summary: 'unresolved one', keywords: ['one'], unresolved: true, tokenCount: 3 },
      { summary: 'unresolved two', keywords: ['two'], unresolved: true, tokenCount: 3 },
      { summary: 'resolved three', keywords: ['three'], unresolved: false, tokenCount: 3 },
    ]
    for (const [index, draft] of drafts.entries()) {
      await store.createCapsule({
        capsuleId: `capsule-${index}`,
        rawArtifactIds: ['raw-1'],
        summarize: async () => draft,
      })
    }

    const result = await store.retrieve({ query: 'one two three', tokenBudget: 6 })
    expect(result.includedTokens).toBeLessThanOrEqual(6)
    expect(result.capsules.filter(capsule => capsule.unresolved).length).toBe(2)
    expect(result.omittedUnresolvedCount).toBe(0)

    const smaller = await store.retrieve({ query: 'one two three', tokenBudget: 3 })
    expect(smaller.includedTokens).toBeLessThanOrEqual(3)
    expect(smaller.capsules).toHaveLength(1)
    expect(smaller.capsules[0]?.unresolved).toBe(true)
    expect(smaller.omittedUnresolvedCount).toBe(1)
  })

  test('pins expire no later than the session retention deadline and deletion clears all artifacts', async () => {
    let now = 1_000
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 2_000,
      now: () => now,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })
    await store.appendRaw({ artifactId: 'raw-1', sequence: 1n, timestamp: 1_000, retentionDeadline: 1_500, content: 'text' })
    expect(await store.pinRawArtifacts({ pinId: 'pin-1', artifactIds: ['raw-1'], expiresAt: 9_000, fenceToken: 'pin-fence' })).toEqual({ expiresAt: 2_000 })
    await expect(store.renewCompactionPin({ pinId: 'pin-1', fenceToken: 'pin-fence', expectedGeneration: '0', expiresAt: 1_900 })).resolves.toEqual({ expiresAt: 1_900, generation: '1' })
    await expect(store.renewCompactionPin({ pinId: 'pin-1', fenceToken: 'wrong-fence', expectedGeneration: '1', expiresAt: 1_900 })).rejects.toThrow('fencing token')
    now = 1_600
    expect(await store.purgeExpired()).toBe(0)
    now = 2_001
    expect(await store.purgeExpired()).toBeGreaterThan(0)
    await store.deleteSession()
    expect(store.inspectPersistedState()).toEqual({ raw: [], capsules: [], routing: [] })
    await expect(store.retrieve({ query: 'text', tokenBudget: 8 })).rejects.toThrow('deleted')
  })

  test('keeps decrypted retrieval index memory bounded', async () => {
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      maxPlaintextIndexBytes: 120,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })
    await addRaw(store, 'raw-1', 'raw')
    for (let index = 0; index < 12; index += 1) {
      await store.createCapsule({
        capsuleId: `capsule-${index}`,
        rawArtifactIds: ['raw-1'],
        summarize: async () => ({ summary: `summary ${index} with enough bytes`, keywords: [`word-${index}`], unresolved: false }),
      })
    }
    await store.retrieve({ query: 'summary', tokenBudget: 8 })
    expect(store.decryptedIndexBytes()).toBeLessThanOrEqual(120)
    const persisted = JSON.stringify(store.inspectPersistedState())
    expect(persisted).not.toContain('summary 1 with enough bytes')
    expect(persisted).not.toContain('word-1')
  })

  test('reloads encrypted artifacts from authoritative SQLite state without plaintext capsule metadata', async () => {
    const persistence = new BunSqliteRawCapsulePersistence(':memory:')
    const first = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await addRaw(first, 'raw-1', 'durable raw')
    await first.createCapsule({ capsuleId: 'capsule-1', rawArtifactIds: ['raw-1'], summarize: async () => ({ summary: 'durable summary', keywords: ['durable'], unresolved: false }) })
    await first.releaseWriterOwnership()
    const second = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await expect(second.retrieve({ query: 'durable', tokenBudget: 64 })).resolves.toMatchObject({ capsules: [{ capsuleId: 'capsule-1', summary: 'durable summary' }] })
    await addRaw(second, 'raw-2', 'after reload', 2n)
    const row = await persistence.load('session-1', 'project-1')
    expect(JSON.stringify(row)).not.toContain('durable summary')
    await second.close()
    await persistence.close()
  })

  test('redacts private tool fields before the summarizer sees raw input', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-1', '{"privateOutput":"internal tool secret"}')
    let seen = ''
    await store.createCapsule({ capsuleId: 'capsule-private', rawArtifactIds: ['raw-1'], summarize: async input => {
      seen = input.text
      return { summary: 'private result omitted', keywords: [], unresolved: false }
    } })
    expect(seen).not.toContain('internal tool secret')
    expect(seen).toContain('[REDACTED:PRIVATE_TOOL_OUTPUT:1]')
  })

  test('fails closed without an explicit durable persistence backend', async () => {
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
    })
    await expect(addRaw(store, 'raw-no-persistence', 'text')).rejects.toBeInstanceOf(RawCapsulePersistenceUnavailableError)
  })

  test('close clears state and makes the store unusable', async () => {
    const store = makeStore()
    await addRaw(store, 'raw-close', 'text')
    await store.close()
    expect(store.inspectPersistedState()).toEqual({ raw: [], capsules: [], routing: [] })
    expect(store.decryptedIndexBytes()).toBe(0)
    await expect(store.retrieve({ query: 'text' })).rejects.toBeInstanceOf(RawCapsuleSessionClosedError)
    await expect(addRaw(store, 'raw-after-close', 'text')).rejects.toBeInstanceOf(RawCapsuleSessionClosedError)
  })

  test('durable deletion tombstone prevents recreation by a new store', async () => {
    const persistence = new MemoryRawCapsulePersistence()
    const first = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await addRaw(first, 'raw-tombstone', 'text')
    await first.deleteSession()
    const second = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await expect(addRaw(second, 'raw-recreated', 'text')).rejects.toThrow('deleted')
  })

  test('enforces aggregate raw and capsule quotas before durable mutation', async () => {
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
      maxRawArtifacts: 1,
      maxCapsules: 1,
      maxTotalEncryptedBytes: 10_000,
    })
    await addRaw(store, 'raw-quota-1', 'text')
    await expect(addRaw(store, 'raw-quota-2', 'text')).rejects.toThrow('raw transcript quota')
    await store.createCapsule({ capsuleId: 'capsule-quota-1', rawArtifactIds: ['raw-quota-1'], summarize: async () => ({ summary: 'summary', keywords: [], unresolved: false }) })
    await expect(store.createCapsule({ capsuleId: 'capsule-quota-2', rawArtifactIds: ['raw-quota-1'], summarize: async () => ({ summary: 'summary', keywords: [], unresolved: false }) })).rejects.toThrow('capsule quota')
  })

  test('purging expired artifacts clears decrypted routing cache', async () => {
    let now = 1_000
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => now,
      tokenCounter: text => Math.max(1, Math.ceil(text.length / 4)),
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })
    await store.appendRaw({ artifactId: 'raw-purge-cache', sequence: 1n, timestamp: 1_000, retentionDeadline: 1_500, content: 'text' })
    await store.createCapsule({ capsuleId: 'capsule-purge-cache', rawArtifactIds: ['raw-purge-cache'], summarize: async () => ({ summary: 'text', keywords: ['text'], unresolved: false }) })
    await store.retrieve({ query: 'text', tokenBudget: 64 })
    expect(store.decryptedIndexBytes()).toBeGreaterThan(0)
    now = 2_000
    await store.purgeExpired()
    expect(store.decryptedIndexBytes()).toBe(0)
  })

  test('arbitrates retrieval against the exact rendered context with a required tokenizer', async () => {
    const rendered: string[] = []
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: text => {
        rendered.push(text)
        return text.startsWith('rendered:') ? text.split('|').length : 1
      },
      retrievalContextRenderer: capsules => `rendered:${capsules.map(capsule => capsule.capsuleId).join('|')}`,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })
    await addRaw(store, 'raw-rendered', 'text')
    await store.createCapsule({ capsuleId: 'capsule-rendered-1', rawArtifactIds: ['raw-rendered'], summarize: async () => ({ summary: 'one', keywords: ['needle'], unresolved: false }) })
    await store.createCapsule({ capsuleId: 'capsule-rendered-2', rawArtifactIds: ['raw-rendered'], summarize: async () => ({ summary: 'two', keywords: ['needle'], unresolved: false }) })
    const result = await store.retrieve({ query: 'needle', tokenBudget: 1 })
    expect(result.capsules).toHaveLength(1)
    expect(rendered).toContain('rendered:capsule-rendered-1')
    expect(rendered).not.toContain(JSON.stringify([result.capsules[0]]))
  })

  test('sanitizes the complete remote compaction request with unique placeholders', () => {
    const sanitized = sanitizeCompactionPayload({
      messages: [{ content: 'password=alpha' }, { content: 'password=beta' }],
      summaryRequest: { content: 'summarize' },
      forkContextMessages: [{ content: 'authorization: Bearer token' }, { privateOutput: 'tool-secret' }],
      cacheSafeParams: {
        systemPrompt: ['password=system-secret'],
        userContext: { user: 'password=user-secret' },
        systemContext: { system: 'password=system-context-secret' },
        toolUseContext: { privateOutput: 'tool-context-secret' },
        forkContextMessages: [],
      },
    })
    const serialized = JSON.stringify(sanitized.sanitized)
    expect(serialized).not.toContain('alpha')
    expect(serialized).not.toContain('beta')
    expect(serialized).not.toContain('tool-secret')
    expect(serialized).not.toContain('system-secret')
    expect(serialized).not.toContain('user-secret')
    expect(serialized).not.toContain('system-context-secret')
    expect(serialized).not.toContain('tool-context-secret')
    expect(new Set(sanitized.placeholders.map(item => item.placeholder)).size).toBe(sanitized.placeholders.length)
    expect(() => validateCompactionSanitizedOutput(sanitized, 'alpha')).toThrow(CapsuleSecretError)
  })

  test('rejects binary compaction values before remote transport', () => {
    expect(() => sanitizeCompactionPayload({ toolResult: new Uint8Array([65, 75, 73, 65]) })).toThrow(CompactionBinaryValueError)
    expect(() => sanitizeCompactionPayload({ toolResult: Buffer.from('secret') })).toThrow(CompactionBinaryValueError)
  })

  test('serializes concurrent store mutations behind one per-store queue', async () => {
    const base = cryptor()
    let active = 0
    let maximumActive = 0
    const serializedCryptor = {
      decrypt: base.decrypt,
      encrypt: async (input: Parameters<typeof base.encrypt>[0]) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await Bun.sleep(5)
        try {
          return await base.encrypt(input)
        } finally {
          active -= 1
        }
      },
    }
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-1',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: serializedCryptor,
      persistence: new MemoryRawCapsulePersistence(),
    })
    await Promise.all([
      addRaw(store, 'raw-serial-1', 'one'),
      addRaw(store, 'raw-serial-2', 'two'),
    ])
    expect(maximumActive).toBe(1)
  })

  test('scopes reusable in-memory persistence by session and project', async () => {
    const persistence = new MemoryRawCapsulePersistence()
    const makeScopedStore = (projectScopeId: string) => new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId,
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await Promise.all([
      addRaw(makeScopedStore('project-a'), 'raw-a', 'a'),
      addRaw(makeScopedStore('project-b'), 'raw-b', 'b'),
    ])
    expect((await persistence.load('session-1', 'project-a'))?.raw).toHaveLength(1)
    expect((await persistence.load('session-1', 'project-b'))?.raw).toHaveLength(1)
  })

  test('reacquires an expired raw writer lease with a new fencing token', async () => {
    let now = 1_000
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-lease',
      sessionRetentionDeadline: 10_000,
      now: () => now,
      writerLeaseDurationMs: 10,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence: new MemoryRawCapsulePersistence(),
    })
    await addRaw(store, 'raw-lease-1', 'one')
    now = 1_020
    await addRaw(store, 'raw-lease-2', 'two')
    expect((await store.inspectPersistedState()).raw).toHaveLength(2)
  })

  test('invalidates an in-flight raw read when session deletion commits', async () => {
    const base = cryptor()
    let decryptStarted = false
    let releaseDecrypt!: () => void
    const decryptGate = new Promise<void>(resolve => { releaseDecrypt = resolve })
    const gatedCryptor = {
      encrypt: base.encrypt,
      decrypt: async (frame: EncryptedFrame) => {
        decryptStarted = true
        await decryptGate
        return base.decrypt(frame)
      },
    }
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-read-delete',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: gatedCryptor,
      persistence: new MemoryRawCapsulePersistence(),
    })
    await addRaw(store, 'raw-in-flight', 'must not escape')
    const read = store.readRaw('raw-in-flight')
    while (!decryptStarted) await Bun.sleep(1)
    const deletion = store.deleteSession()
    await deletion
    releaseDecrypt()
    await expect(read).rejects.toThrow('deleted')
  })

  test('renews compaction pins while a slow summarizer runs', async () => {
    let now = 1_000
    const persistence = new MemoryRawCapsulePersistence()
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-pin-heartbeat',
      sessionRetentionDeadline: 120_000,
      now: () => now,
      compactionPinRenewalIntervalMs: 5,
      tokenCounter: () => 3,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: cryptor(),
      persistence,
    })
    await store.appendRaw({ artifactId: 'raw-slow', sequence: 1n, timestamp: 1_000, retentionDeadline: 61_000, content: 'slow source' })
    let observedExpiry = 0
    await store.createCapsule({
      capsuleId: 'capsule-slow',
      rawArtifactIds: ['raw-slow'],
      summarize: async () => {
        for (let index = 0; index < 8; index += 1) {
          now += 10_000
          await Bun.sleep(10)
        }
        observedExpiry = (await persistence.load('session-1', 'project-pin-heartbeat'))?.pins[0]?.expiresAt ?? 0
        return { summary: 'slow', keywords: ['slow'], unresolved: false }
      },
    })
    expect(observedExpiry).toBeGreaterThan(now)
  })

  test('returns no plaintext when deletion invalidates retrieval during shard decryption', async () => {
    const base = cryptor()
    let blockDecrypt = false
    let decryptStarted = false
    let releaseDecrypt!: () => void
    const decryptGate = new Promise<void>(resolve => { releaseDecrypt = resolve })
    const gatedCryptor = {
      encrypt: base.encrypt,
      decrypt: async (frame: EncryptedFrame) => {
        if (blockDecrypt) {
          decryptStarted = true
          await decryptGate
        }
        return base.decrypt(frame)
      },
    }
    const store = new EncryptedRawCapsuleStore({
      sessionId: 'session-1',
      projectScopeId: 'project-retrieve-delete',
      sessionRetentionDeadline: 10_000,
      now: () => 1_000,
      tokenCounter: () => 3,
      gates: { RETRIEVAL_COMPACTION: true },
      cryptor: gatedCryptor,
      persistence: new MemoryRawCapsulePersistence(),
    })
    await addRaw(store, 'raw-retrieve', 'needle')
    await store.createCapsule({
      capsuleId: 'capsule-retrieve',
      rawArtifactIds: ['raw-retrieve'],
      summarize: async () => ({ summary: 'needle', keywords: ['needle'], unresolved: false }),
    })
    blockDecrypt = true
    const retrieval = store.retrieve({ query: 'needle' })
    while (!decryptStarted) await Bun.sleep(1)
    await store.deleteSession()
    releaseDecrypt()
    await expect(retrieval).rejects.toThrow('deleted')
  })
})
