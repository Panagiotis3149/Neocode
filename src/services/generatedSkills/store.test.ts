import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  GeneratedSkillStore,
  GeneratedSkillAttestationKeyUnavailableError,
  GeneratedSkillStoreDisabledError,
  GeneratedSkillValidationError,
  GeneratedSkillMutationUnavailableError,
  createVerifiedGeneratedSkillMutationCapability,
  resolveGeneratedSkillStoreOptions,
} from './store.js'

const directories: string[] = []
const roots = new WeakMap<GeneratedSkillStore, string>()

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-'))
  directories.push(root)
  const store = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true, SKILL_PROMOTION: true }, {
    attestationKey: new Uint8Array(32).fill(7),
    mutationCapability: createMutationCapability(root),
  })
  roots.set(store, root)
  return store
}

function createMutationCapability(root: string, fenceToken = 'test-fence') {
  return createVerifiedGeneratedSkillMutationCapability({
    rootPath: root,
    fenceToken,
    withWriterLease: async work => work(),
    async createVersionBundle(input: { name: string; version: number; content: string; attestation: string; fenceToken: string }) {
      expect(input.fenceToken).toBe(fenceToken)
      const versions = join(root, 'auto', input.name, 'versions')
      const temporary = join(versions, `.test-${randomUUID()}`)
      await mkdir(temporary, { recursive: true })
      await writeFile(join(temporary, 'SKILL.md'), input.content, 'utf8')
      await writeFile(join(temporary, 'attestation.json'), input.attestation, 'utf8')
      await rename(temporary, join(versions, String(input.version)))
    },
    async replaceManifest(input: { name: string; manifest: string; fenceToken: string }) {
      expect(input.fenceToken).toBe(fenceToken)
      const directory = join(root, 'auto', input.name)
      const temporary = join(directory, `.manifest-test-${randomUUID()}`)
      await writeFile(temporary, input.manifest, 'utf8')
      await rename(temporary, join(directory, '.manifest.json'))
    },
  })
}

describe('generated skill store', () => {
  test('stores generated skills only beneath auto and attests their content', async () => {
    const store = createStore()
    const created = await store.create({ name: 'daily-review', content: 'Review the changed files.', evidence: ['message-1'] })
    expect(created.path).toContain(`${join('auto', 'daily-review')}`)
    expect(created.status).toBe('generated')
    expect((await store.read('daily-review')).attestation.contentHash).toBe(created.attestation.contentHash)
  })

  test('promotion is invalidated after any content mutation', async () => {
    const store = createStore()
    await store.create({ name: 'daily-review', content: 'Review the changed files.', evidence: ['message-1'] })
    const promoted = await store.promote('daily-review')
    expect(promoted.status).toBe('promoted')
    await store.mutate('daily-review', 'Review changed files and tests.')
    expect((await store.read('daily-review')).status).toBe('generated')
    expect((await store.read('daily-review')).attestation.promotedContentHash).toBeUndefined()
  })

  test('rejects secret-bearing generated content without redacting it', async () => {
    const store = createStore()
    await expect(store.create({ name: 'secret', content: 'ghp_123456789012345678901234567890123456', evidence: ['message-1'] })).rejects.toBeInstanceOf(GeneratedSkillValidationError)
  })

  test('rejects path escape and symlink escape from auto', async () => {
    const store = createStore()
    await expect(store.create({ name: '../escape', content: 'safe', evidence: ['message-1'] })).rejects.toBeInstanceOf(GeneratedSkillValidationError)
    await expect(store.create({ name: 'nested/name', content: 'safe', evidence: ['message-1'] })).rejects.toThrow()
  })

  test('fails closed when an authenticated version manifest is corrupt', async () => {
    const store = createStore()
    await store.create({ name: 'corruptible', content: 'safe', evidence: ['message-1'] })
    await Bun.write(join(roots.get(store)!, 'auto', 'corruptible', '.manifest.json'), '{corrupt')
    await expect(store.read('corruptible')).rejects.toThrow('corrupt')
  })

  test('is disabled unless the skill store and generation gates are effective', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-disabled-'))
    directories.push(root)
    const store = new GeneratedSkillStore(root)
    await expect(store.create({ name: 'daily-review', content: 'safe', evidence: ['message-1'] })).rejects.toBeInstanceOf(GeneratedSkillStoreDisabledError)
  })

  test('fails closed without a stable secure attestation key or mutation capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-unverified-'))
    directories.push(root)
    const store = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true })
    await expect(store.create({ name: 'unverified', content: 'safe', evidence: ['message-1'] })).rejects.toThrow()
    const capable = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true }, { mutationCapability: createMutationCapability(root) })
    await expect(capable.create({ name: 'no-key', content: 'safe', evidence: ['message-1'] })).rejects.toBeInstanceOf(GeneratedSkillAttestationKeyUnavailableError)
  })

  test('resolves a stable key and verified mutation capability from native secure storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-runtime-'))
    directories.push(root)
    let data: { memoryV2?: { generatedSkillAttestationKey?: string } } | null = null
    const storage = {
      name: 'native-test-store',
      read: () => data,
      update: (next: typeof data) => {
        data = next
        return { success: true }
      },
    }
    const resolved = resolveGeneratedSkillStoreOptions(root, 'runtime-fence', storage, createMutationCapability(root, 'runtime-fence'))
    expect(resolved.available).toBe(true)
    if (!resolved.available) throw new Error(resolved.reason)
    expect(resolved.options.attestationKey).toBeInstanceOf(Uint8Array)
    expect(resolved.options.mutationCapability?.fenceToken).toBe('runtime-fence')
    const store = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true }, resolved.options)
    await store.create({ name: 'runtime-skill', content: 'safe', evidence: ['runtime'] })
    expect((await store.read('runtime-skill')).content).toBe('safe')
    const second = resolveGeneratedSkillStoreOptions(root, 'runtime-fence', storage, createMutationCapability(root, 'runtime-fence'))
    expect(second.available).toBe(true)
    if (!second.available) throw new Error(second.reason)
    expect([...second.options.attestationKey!]).toEqual([...resolved.options.attestationKey!])
  })

  test('reports generated-skill runtime unavailable when native secure storage is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-runtime-unavailable-'))
    directories.push(root)
    const resolved = resolveGeneratedSkillStoreOptions(root, 'runtime-fence', {
      name: 'unavailable-secure-storage',
      read: () => null,
      update: () => ({ success: false }),
    })
    expect(resolved.available).toBe(false)
    if (resolved.available) throw new Error('expected unavailable generated-skill runtime')
    expect(resolved.reason).toContain('secure storage')
  })

  test('serializes secure attestation key creation across contenders', () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-runtime-lease-'))
    directories.push(root)
    let data: { memoryV2?: { generatedSkillAttestationKey?: string } } | null = null
    let contender: ReturnType<typeof resolveGeneratedSkillStoreOptions> | undefined
    const storage = {
      name: 'native-test-store',
      read: () => data,
      update: (next: typeof data) => {
        contender = resolveGeneratedSkillStoreOptions(root, 'contender-fence', storage, createMutationCapability(root, 'contender-fence'))
        data = next
        return { success: true }
      },
    }
    const resolved = resolveGeneratedSkillStoreOptions(root, 'owner-fence', storage, createMutationCapability(root, 'owner-fence'))
    expect(resolved.available).toBe(true)
    expect(contender?.available).toBe(false)
    if (contender?.available !== false) throw new Error('expected the contender to be rejected')
    expect(contender.reason).toContain('lease')
  })

  test('reports mutation capability unavailable when the host does not provide a verified adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-runtime-capability-'))
    directories.push(root)
    const resolved = resolveGeneratedSkillStoreOptions(root, 'runtime-fence', {
      name: 'native-test-store',
      read: () => null,
      update: () => ({ success: true }),
    })
    expect(resolved.available).toBe(false)
    if (resolved.available) throw new Error('expected unavailable generated-skill runtime')
    expect(resolved.reason).toContain('verified')
    const store = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true }, {
      attestationKey: new Uint8Array(32).fill(3),
      mutationCapability: {
        rootPath: root,
        fenceToken: 'unverified',
        withWriterLease: async work => work(),
        createVersionBundle: async () => {},
        replaceManifest: async () => {},
      },
    })
    await expect(store.create({ name: 'unverified', content: 'safe', evidence: ['test'] })).rejects.toBeInstanceOf(GeneratedSkillMutationUnavailableError)
  })

  test('fails closed when the verified writer lease cannot be acquired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neocode-generated-skills-runtime-writer-lease-'))
    directories.push(root)
    const store = new GeneratedSkillStore(root, { SKILL_STORE_V2: true, AUTO_SKILL_GENERATION: true }, {
      attestationKey: new Uint8Array(32).fill(8),
      mutationCapability: createVerifiedGeneratedSkillMutationCapability({
        rootPath: root,
        fenceToken: 'lease-fence',
        withWriterLease: async () => {
          throw new GeneratedSkillMutationUnavailableError()
        },
        createVersionBundle: async () => {},
        replaceManifest: async () => {},
      }),
    })
    await expect(store.create({ name: 'lease-blocked', content: 'safe', evidence: ['test'] })).rejects.toBeInstanceOf(GeneratedSkillMutationUnavailableError)
  })
})
