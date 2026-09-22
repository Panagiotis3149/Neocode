import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { canonicalize, sha256ExactBytes } from '../memoryV2/canonical.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from '../memoryV2/featureGates.js'
import { scanForSecrets } from '../teamMemorySync/secretScanner.js'
import { getSecureStorage, type SecureStorage, type SecureStorageData } from '../../utils/secureStorage/index.js'

export type GeneratedSkillStatus = 'generated' | 'promoted'

export type GeneratedSkillAttestation = Readonly<{
  algorithm: 'sha256-bytes-v1'
  contentHash: string
  version: number
  evidence: readonly string[]
  promotedContentHash?: string
}>

export type GeneratedSkill = Readonly<{
  name: string
  path: string
  content: string
  version: number
  status: GeneratedSkillStatus
  attestation: GeneratedSkillAttestation
}>

export type GeneratedSkillStoreOptions = Readonly<{
  attestationKey?: Uint8Array
  mutationCapability?: GeneratedSkillMutationCapability
}>

const generatedSkillMutationCapabilityBrand = Symbol('generatedSkillMutationCapabilityBrand')

export type GeneratedSkillMutationCapabilityAdapter = Readonly<{
  rootPath: string
  fenceToken: string
  withWriterLease: (work: () => Promise<void>) => Promise<void>
  createVersionBundle: (input: Readonly<{ name: string; version: number; content: string; attestation: string; fenceToken: string }>) => Promise<void>
  replaceManifest: (input: Readonly<{ name: string; manifest: string; fenceToken: string }>) => Promise<void>
}>

export type GeneratedSkillMutationCapability = GeneratedSkillMutationCapabilityAdapter & Readonly<{
  [generatedSkillMutationCapabilityBrand]?: true
}>

export function createVerifiedGeneratedSkillMutationCapability(
  adapter: GeneratedSkillMutationCapabilityAdapter,
): GeneratedSkillMutationCapability {
  if (
    !adapter ||
    typeof adapter.rootPath !== 'string' ||
    typeof adapter.fenceToken !== 'string' ||
    typeof adapter.withWriterLease !== 'function' ||
    typeof adapter.createVersionBundle !== 'function' ||
    typeof adapter.replaceManifest !== 'function'
  ) throw new TypeError('A complete generated skill mutation capability is required')
  return Object.freeze({ ...adapter, [generatedSkillMutationCapabilityBrand]: true }) as GeneratedSkillMutationCapability
}

export function isVerifiedGeneratedSkillMutationCapability(
  value: GeneratedSkillMutationCapability | undefined,
): value is GeneratedSkillMutationCapability {
  return value?.[generatedSkillMutationCapabilityBrand] === true
}

export type GeneratedSkillRuntimeResolution =
  | Readonly<{ available: true; options: GeneratedSkillStoreOptions }>
  | Readonly<{ available: false; reason: string }>

type GeneratedSkillSecureStorage = Pick<SecureStorage, 'name' | 'read' | 'update'>

const GENERATED_SKILL_KEY_LEASE_MS = 30_000

type GeneratedSkillKeyLease = Readonly<{
  release: () => void
}>

function decodeAttestationKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null
  try {
    const key = Buffer.from(value, 'base64')
    return key.byteLength >= 32 ? new Uint8Array(key) : null
  } catch {
    return null
  }
}

function acquireGeneratedSkillLease(root: string, leaseName: string): GeneratedSkillKeyLease | null {
  const leaseDirectory = join(resolve(root), `.${leaseName}-lease`)
  const ownerFile = join(leaseDirectory, 'owner.json')
  const owner = randomUUID()
  try {
    mkdirSync(resolve(root), { recursive: true })
  } catch {
    return null
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(leaseDirectory)
      writeFileSync(ownerFile, JSON.stringify({ owner, expiresAt: Date.now() + GENERATED_SKILL_KEY_LEASE_MS }), 'utf8')
      return {
        release: () => {
          try {
            const current = JSON.parse(readFileSync(ownerFile, 'utf8')) as { owner?: string }
            if (current.owner === owner) rmSync(leaseDirectory, { recursive: true, force: true })
          } catch {}
        },
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) return null
      let expiresAt: number | undefined
      try {
        expiresAt = (JSON.parse(readFileSync(ownerFile, 'utf8')) as { expiresAt?: number }).expiresAt
      } catch {
        return null
      }
      if (!expiresAt || expiresAt > Date.now()) return null
      const staleDirectory = `${leaseDirectory}.stale-${randomUUID()}`
      try {
        renameSync(leaseDirectory, staleDirectory)
        rmSync(staleDirectory, { recursive: true, force: true })
      } catch {
        return null
      }
    }
  }
  return null
}

function acquireGeneratedSkillKeyLease(root: string): GeneratedSkillKeyLease | null {
  return acquireGeneratedSkillLease(root, 'auto-skill-key')
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function assertNativePath(root: string, path: string): Promise<void> {
  if (!isWithin(root, path)) throw new GeneratedSkillMutationUnavailableError()
  try {
    const rootStat = await lstat(root)
    if (rootStat.isSymbolicLink()) throw new GeneratedSkillMutationUnavailableError()
    if (!isWithin(root, resolve(await realpath(root)))) throw new GeneratedSkillMutationUnavailableError()
  } catch (error) {
    if (error instanceof GeneratedSkillMutationUnavailableError) throw error
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
  }
  const parts = relative(root, path).split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new GeneratedSkillMutationUnavailableError()
      if (!isWithin(root, resolve(await realpath(current)))) throw new GeneratedSkillMutationUnavailableError()
    } catch (error) {
      if (error instanceof GeneratedSkillMutationUnavailableError) throw error
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

export function createNativeGeneratedSkillMutationCapability(root: string, fenceToken: string): GeneratedSkillMutationCapability | null {
  const skillsRoot = resolve(root)
  if (!fenceToken || process.platform === 'win32') return null
  return createVerifiedGeneratedSkillMutationCapability({
    rootPath: skillsRoot,
    fenceToken,
    async withWriterLease(work) {
      const lease = acquireGeneratedSkillLease(skillsRoot, 'auto-skill-writer')
      if (!lease) throw new GeneratedSkillMutationUnavailableError()
      try {
        await work()
      } finally {
        lease.release()
      }
    },
    async createVersionBundle(input) {
      if (input.fenceToken !== fenceToken) throw new GeneratedSkillMutationUnavailableError()
      assertName(input.name)
      const versionDirectory = join(skillsRoot, 'auto', input.name, 'versions', String(input.version))
      await mkdir(join(skillsRoot, 'auto', input.name, 'versions'), { recursive: true })
      await assertNativePath(skillsRoot, versionDirectory)
      const temporaryDirectory = join(join(skillsRoot, 'auto', input.name, 'versions'), `.tmp-${randomUUID()}`)
      await mkdir(temporaryDirectory)
      try {
        await writeFile(join(temporaryDirectory, 'SKILL.md'), input.content, 'utf8')
        await writeFile(join(temporaryDirectory, 'attestation.json'), input.attestation, 'utf8')
        await rename(temporaryDirectory, versionDirectory)
      } catch (error) {
        throw error
      }
    },
    async replaceManifest(input) {
      if (input.fenceToken !== fenceToken) throw new GeneratedSkillMutationUnavailableError()
      assertName(input.name)
      const directory = join(skillsRoot, 'auto', input.name)
      await mkdir(directory, { recursive: true })
      await assertNativePath(skillsRoot, directory)
      const temporaryPath = join(directory, `.manifest.tmp-${randomUUID()}`)
      await writeFile(temporaryPath, input.manifest, 'utf8')
      await rename(temporaryPath, join(directory, '.manifest.json'))
    },
  })
}

export function resolveGeneratedSkillStoreOptions(
  root: string,
  fenceToken: string,
  storage: GeneratedSkillSecureStorage = getSecureStorage({ allowPlainTextFallback: false }),
  mutationCapability?: GeneratedSkillMutationCapability,
): GeneratedSkillRuntimeResolution {
  if (!storage || storage.name === 'unavailable-secure-storage' || storage.name === 'plaintext') {
    return { available: false, reason: 'Generated skill secure storage is unavailable' }
  }
  if (
    !mutationCapability ||
    !isVerifiedGeneratedSkillMutationCapability(mutationCapability) ||
    mutationCapability.fenceToken !== fenceToken ||
    resolve(mutationCapability.rootPath) !== resolve(root)
  ) return { available: false, reason: 'Generated skill verified native mutation capability is unavailable' }
  let data: SecureStorageData | null
  try {
    data = storage.read()
  } catch {
    return { available: false, reason: 'Generated skill secure storage could not be read' }
  }
  let key = decodeAttestationKey(data?.memoryV2?.generatedSkillAttestationKey)
  if (!key) {
    const lease = acquireGeneratedSkillKeyLease(root)
    if (!lease) return { available: false, reason: 'Generated skill secure-storage key lease is unavailable' }
    try {
      data = storage.read()
      key = decodeAttestationKey(data?.memoryV2?.generatedSkillAttestationKey)
      if (!key) {
        const encoded = randomBytes(32).toString('base64')
        const next = {
          ...(data ?? {}),
          memoryV2: { ...(data?.memoryV2 ?? {}), generatedSkillAttestationKey: encoded },
        }
        const result = storage.update(next)
        if (!result.success) return { available: false, reason: 'Generated skill secure storage could not persist its attestation key' }
        key = decodeAttestationKey(storage.read()?.memoryV2?.generatedSkillAttestationKey)
      }
    } catch {
      key = null
    } finally {
      lease.release()
    }
    if (!key) return { available: false, reason: 'Generated skill secure storage did not retain its attestation key' }
  }
  return { available: true, options: { attestationKey: key, mutationCapability } }
}

export class GeneratedSkillStoreDisabledError extends Error {
  constructor() {
    super('V2 generated skill storage is disabled')
    this.name = 'GeneratedSkillStoreDisabledError'
  }
}

export class GeneratedSkillValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeneratedSkillValidationError'
  }
}

export class GeneratedSkillCorruptStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeneratedSkillCorruptStateError'
  }
}

export class GeneratedSkillMutationUnavailableError extends Error {
  constructor() {
    super('Generated skill mutation requires a verified filesystem adapter')
    this.name = 'GeneratedSkillMutationUnavailableError'
  }
}

export class GeneratedSkillAttestationKeyUnavailableError extends Error {
  constructor() {
    super('Generated skill mutation requires a stable secure-store attestation key')
    this.name = 'GeneratedSkillAttestationKeyUnavailableError'
  }
}

export class GeneratedSkillExistsError extends Error {
  constructor(name: string) {
    super(`Generated skill already exists: ${name}`)
    this.name = 'GeneratedSkillExistsError'
  }
}

export class GeneratedSkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Generated skill was not found: ${name}`)
    this.name = 'GeneratedSkillNotFoundError'
  }
}

type StoredAttestation = {
  algorithm: 'sha256-bytes-v1'
  contentHash: string
  version: number
  evidence: string[]
  promotedContentHash?: string
}

type Manifest = StoredAttestation & {
  format: 'generated-skill-manifest-v1'
  name: string
  status: GeneratedSkillStatus
  signature: string
}

type ManifestCore = Omit<Manifest, 'signature'>

function contentHash(content: string): string {
  return sha256ExactBytes(new TextEncoder().encode(content))
}

function assertName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === '.' || name === '..') {
    throw new GeneratedSkillValidationError('Generated skill name must be one safe path segment')
  }
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value as object)) {
    seen.add(value as object)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child, seen)
  }
  return value
}

export class GeneratedSkillStore {
  private readonly skillsRoot: string
  private readonly gates: FeatureGateRequest
  private readonly attestationKey: Uint8Array | null
  private readonly mutationCapability: GeneratedSkillMutationCapability | undefined

  constructor(root: string, gates: FeatureGateRequest = {}, options: GeneratedSkillStoreOptions = {}) {
    this.skillsRoot = resolve(root)
    this.gates = gates
    this.attestationKey = options.attestationKey && options.attestationKey.byteLength >= 32
      ? new Uint8Array(options.attestationKey)
      : null
    this.mutationCapability = options.mutationCapability
  }

  async create(input: Readonly<{ name: string; content: string; evidence: readonly string[] }>): Promise<GeneratedSkill> {
    this.requireGate('AUTO_SKILL_GENERATION')
    await this.requireMutationRoot()
    assertName(input.name)
    this.validateContent(input.content)
    if (input.evidence.length === 0) throw new GeneratedSkillValidationError('Generated skill evidence is required')
    this.requireAttestationKey()
    const existingManifest = await this.readOptionalManifest(input.name)
    if (existingManifest) throw new GeneratedSkillExistsError(input.name)
    let entries: string[] = []
    try {
      entries = await readdir(this.skillDirectory(input.name))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
    }
    if (entries.length > 0 && !entries.every(entry => entry.startsWith('.tmp-'))) {
      throw new GeneratedSkillCorruptStateError('Generated skill directory has no authenticated manifest')
    }
    const attestation: StoredAttestation = {
      algorithm: 'sha256-bytes-v1',
      contentHash: contentHash(input.content),
      version: 1,
      evidence: [...input.evidence],
    }
    await this.writeBundle(input.name, input.content, attestation, 'generated')
    return this.toSkill(input.name, attestation, input.content, 'generated')
  }

  async read(name: string): Promise<GeneratedSkill> {
    this.requireGate('SKILL_STORE_V2')
    this.requireAttestationKey()
    assertName(name)
    await this.assertSafePath(name)
    const manifest = await this.readManifest(name)
    const versionDirectory = this.versionDirectory(name, manifest.version)
    const skillPath = join(versionDirectory, 'SKILL.md')
    const attestationPath = join(versionDirectory, 'attestation.json')
    this.assertSafeFile(skillPath)
    this.assertSafeFile(attestationPath)
    let content: string
    let attestation: StoredAttestation
    try {
      content = await readFile(skillPath, 'utf8')
      attestation = JSON.parse(await readFile(attestationPath, 'utf8')) as StoredAttestation
    } catch (error) {
      throw new GeneratedSkillCorruptStateError(`Generated skill version bundle is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!this.sameAttestation(manifest, attestation) || contentHash(content) !== manifest.contentHash) {
      throw new GeneratedSkillCorruptStateError('Generated skill version bundle failed authentication')
    }
    return this.toSkill(name, this.manifestAttestation(manifest), content, manifest.status)
  }

  async mutate(name: string, content: string): Promise<GeneratedSkill> {
    this.requireGate('SKILL_STORE_V2')
    await this.requireMutationRoot()
    assertName(name)
    this.validateContent(content)
    const current = await this.read(name)
    const attestation: StoredAttestation = {
      algorithm: 'sha256-bytes-v1',
      contentHash: contentHash(content),
      version: current.version + 1,
      evidence: [...current.attestation.evidence],
    }
    await this.writeBundle(name, content, attestation, 'generated')
    return this.toSkill(name, attestation, content, 'generated')
  }

  async promote(name: string): Promise<GeneratedSkill> {
    this.requireGate('SKILL_PROMOTION')
    await this.requireMutationRoot()
    const current = await this.read(name)
    if (current.status !== 'generated') throw new GeneratedSkillValidationError('Only an unmodified generated skill can be promoted')
    const attestation: StoredAttestation = {
      ...current.attestation,
      evidence: [...current.attestation.evidence],
      version: current.version + 1,
      promotedContentHash: current.attestation.contentHash,
    }
    await this.writeBundle(name, current.content, attestation, 'promoted')
    return this.toSkill(name, attestation, current.content, 'promoted')
  }

  private requireGate(gate: 'SKILL_STORE_V2' | 'AUTO_SKILL_GENERATION' | 'SKILL_PROMOTION'): void {
    if (!isFeatureGateEnabled(gate, this.gates)) throw new GeneratedSkillStoreDisabledError()
  }

  private async requireMutationRoot(): Promise<void> {
    if (
      !this.mutationCapability ||
      !isVerifiedGeneratedSkillMutationCapability(this.mutationCapability) ||
      !this.mutationCapability.fenceToken ||
      resolve(this.mutationCapability.rootPath) !== this.skillsRoot
    ) throw new GeneratedSkillMutationUnavailableError()
  }

  private requireAttestationKey(): void {
    if (!this.attestationKey) throw new GeneratedSkillAttestationKeyUnavailableError()
  }

  private validateContent(content: string): void {
    if (typeof content !== 'string' || content.length === 0) throw new GeneratedSkillValidationError('Generated skill content is required')
    if (scanForSecrets(content).length > 0) throw new GeneratedSkillValidationError('Generated skill content contains a secret')
  }

  private skillDirectory(name: string): string {
    return join(this.skillsRoot, 'auto', name)
  }

  private manifestPath(name: string): string {
    return join(this.skillDirectory(name), '.manifest.json')
  }

  private versionDirectory(name: string, version: number): string {
    return join(this.skillDirectory(name), 'versions', String(version))
  }

  private async readOptionalManifest(name: string): Promise<Manifest | null> {
    try {
      return await this.parseManifest(await readFile(this.manifestPath(name), 'utf8'), name)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof GeneratedSkillCorruptStateError) throw error
      throw new GeneratedSkillCorruptStateError(`Generated skill manifest is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async readManifest(name: string): Promise<Manifest> {
    try {
      return this.parseManifest(await readFile(this.manifestPath(name), 'utf8'), name)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GeneratedSkillNotFoundError(name)
      }
      if (error instanceof GeneratedSkillCorruptStateError) throw error
      throw new GeneratedSkillCorruptStateError(`Generated skill manifest is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private parseManifest(raw: string, name: string): Manifest {
    let parsed: Manifest
    try {
      parsed = JSON.parse(raw) as Manifest
    } catch {
      throw new GeneratedSkillCorruptStateError('Generated skill manifest is corrupt')
    }
    if (parsed.format !== 'generated-skill-manifest-v1' || parsed.name !== name || !Number.isSafeInteger(parsed.version) || parsed.version < 1 || (parsed.status !== 'generated' && parsed.status !== 'promoted') || typeof parsed.signature !== 'string') {
      throw new GeneratedSkillCorruptStateError('Generated skill manifest fields are invalid')
    }
    const expected = this.signManifest(parsed)
    if (!this.equalSignature(expected, parsed.signature)) throw new GeneratedSkillCorruptStateError('Generated skill manifest authentication failed')
    return parsed
  }

  private signManifest(core: ManifestCore): string {
    const unsigned = { ...core } as Record<string, unknown>
    delete unsigned.signature
    return createHmac('sha256', this.attestationKey!).update(canonicalize(unsigned)).digest('hex')
  }

  private equalSignature(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async writeBundle(name: string, content: string, attestation: StoredAttestation, status: GeneratedSkillStatus): Promise<void> {
    if (!this.mutationCapability) throw new GeneratedSkillMutationUnavailableError()
    await this.mutationCapability.withWriterLease(async () => {
      await this.mutationCapability!.createVersionBundle({ name, version: attestation.version, content, attestation: JSON.stringify(attestation), fenceToken: this.mutationCapability!.fenceToken })
      await this.assertSafePath(name)
      const core: ManifestCore = { format: 'generated-skill-manifest-v1', name, status, ...attestation }
      const manifest: Manifest = { ...core, signature: this.signManifest(core) }
      await this.mutationCapability!.replaceManifest({ name, manifest: JSON.stringify(manifest), fenceToken: this.mutationCapability!.fenceToken })
    })
  }

  private async assertSafeAutoRoot(): Promise<void> {
    for (const path of [this.skillsRoot, join(this.skillsRoot, 'auto')]) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new GeneratedSkillValidationError('Generated skill root cannot be a symlink')
        if (resolve(realpathSync(path)) !== resolve(path)) throw new GeneratedSkillValidationError('Generated skill root must resolve directly')
      } catch (error) {
        if (error instanceof GeneratedSkillValidationError) throw error
      }
    }
  }

  private async assertSafePath(name: string): Promise<void> {
    await this.assertSafeAutoRoot()
    const directory = this.skillDirectory(name)
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new GeneratedSkillValidationError('Generated skill directory cannot be a symlink')
      const realDirectory = resolve(realpathSync(directory))
      const realAutoRoot = resolve(realpathSync(join(this.skillsRoot, 'auto')))
      const relativePath = relative(realAutoRoot, realDirectory)
      if (relativePath.startsWith('..') || relativePath.includes('\\') || relativePath.includes('/')) throw new GeneratedSkillValidationError('Generated skill path escapes auto')
    } catch (error) {
      if (error instanceof GeneratedSkillValidationError) throw error
    }
  }

  private assertSafeFile(path: string): void {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new GeneratedSkillValidationError('Generated skill files cannot be symlinks')
      if (resolve(realpathSync(path)) !== resolve(path)) throw new GeneratedSkillValidationError('Generated skill file escapes auto')
    } catch (error) {
      if (error instanceof GeneratedSkillValidationError) throw error
    }
  }

  private sameAttestation(manifest: Manifest, attestation: StoredAttestation): boolean {
    const { signature: _signature, format: _format, name: _name, status: _status, ...manifestAttestation } = manifest
    return canonicalize(manifestAttestation) === canonicalize(attestation)
  }

  private manifestAttestation(manifest: Manifest): StoredAttestation {
    const { format: _format, name: _name, status: _status, signature: _signature, ...attestation } = manifest
    return attestation
  }

  private toSkill(name: string, attestation: StoredAttestation, content: string, status: GeneratedSkillStatus): GeneratedSkill {
    return freezeValue({
      name,
      path: join(this.versionDirectory(name, attestation.version), 'SKILL.md'),
      content,
      version: attestation.version,
      status,
      attestation: { ...attestation, evidence: [...attestation.evidence] },
    })
  }
}
