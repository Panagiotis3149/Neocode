import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  ENTRYPOINT_NAME,
  configureMemoryPromptV2BindingProvider,
  configureMemoryPromptV2Transport,
  ensureMemoryDirExists,
  invalidateAllMemoryPromptRegistrations,
  invalidateMemoryPromptRegistrations,
  type MemoryPromptV2Binding,
} from '../../memdir/memdir.js'
import {
  clearMemoryV2CommandHandlers,
  configureMemoryV2CommandHandlers,
} from './commandHandlers.js'
import { PromptFence, type SynchronousTransportQueue } from './promptFence.js'
import { MemoryV2Store, type MemoryRecord } from './store.js'
import type { ProjectionManager } from './projections.js'
import { resolveFeatureGates, type FeatureGateBlockers, type FeatureGateRequest, type FeatureGateResolution } from './featureGates.js'
import type { GeneratedSkillStoreOptions } from '../generatedSkills/store.js'
import { configureMemoryV2SkillRuntime } from './skillRuntimeConfig.js'
import { configureRawCompactionBinding, type EncryptedRawCapsuleStore, type RawCapsuleDraft, type SanitizedRawCompactionInput } from '../compact/rawCapsules.js'

export type MemoryV2RuntimeOptions = Readonly<{
  sessionId: string
  projectScopeId: string
  memoryDir?: string
  dbPath?: string
  gates?: FeatureGateRequest
  sessionCryptoDelete?: () => void | Promise<void>
  purgeEncryptedArtifacts?: () => void | Promise<void>
  sessionCryptoAvailable?: boolean
  projectionManager?: Pick<ProjectionManager, 'forget'>
  projectionPathForRecord?: (record: MemoryRecord) => string
  projectionTextForRecord?: (record: MemoryRecord) => string | Promise<string>
  memoryPromptTransport?: SynchronousTransportQueue
  now?: () => number
  generatedSkillOptions?: GeneratedSkillStoreOptions
  gateBlockers?: FeatureGateBlockers
  rawCapsuleStore?: EncryptedRawCapsuleStore
  rawCapsuleSummarize?: (input: SanitizedRawCompactionInput) => Promise<RawCapsuleDraft>
}>

export type MemoryV2Runtime = Readonly<{
  sessionId: string
  projectScopeId: string
  gates: FeatureGateRequest
  gateResolution: FeatureGateResolution
  store: MemoryV2Store
  fence: PromptFence
  close: () => Promise<void>
  rawCapsuleStore?: EncryptedRawCapsuleStore
}>

export class MemoryV2RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryV2RuntimeUnavailableError'
  }
}

let activeRuntime: MemoryV2Runtime | null = null

function bindingFor(
  options: MemoryV2RuntimeOptions,
  fence: PromptFence,
  store: MemoryV2Store,
  memoryDir: string,
): MemoryPromptV2Binding {
  if (!fence.isAdmissionOpen()) throw new MemoryV2RuntimeUnavailableError('Memory V2 prompt admission is closed')
  if (!options.memoryDir || resolve(memoryDir) !== resolve(options.memoryDir)) {
    throw new MemoryV2RuntimeUnavailableError('Memory V2 prompt scope is not registered for this memory directory')
  }
  const generations = fence.getGenerations()
  const records = store.listSync({ projectScopeId: options.projectScopeId })
  if (records.length === 0) throw new MemoryV2RuntimeUnavailableError('Memory V2 store snapshot is unavailable')
  const entrypointContent = records.map(record => record.content).join('\n')
  return {
    fence,
    projectScopeId: options.projectScopeId,
    storeGeneration: generations.storeGeneration,
    promptEpoch: generations.promptEpoch,
    records: [
      ...records
        .filter(record => record.id !== ENTRYPOINT_NAME)
        .map(record => ({
          id: record.id,
          projectScopeId: record.projectScopeId,
          content: record.content,
        })),
      {
        id: ENTRYPOINT_NAME,
        projectScopeId: options.projectScopeId,
        content: entrypointContent,
      },
    ],
    maxPromptCharacters: 25_000,
    maxPromptTokens: 8_000,
  }
}

export async function initializeMemoryV2Runtime(options: MemoryV2RuntimeOptions): Promise<MemoryV2Runtime | null> {
  await shutdownMemoryV2Runtime()
  const gates = options.gates ?? {}
  const gateResolution = resolveFeatureGates(gates, options.gateBlockers)
  if (!gateResolution.MEMORY_STORE_V2.effective) {
    configureMemoryV2SkillRuntime(gates, options.generatedSkillOptions, gateResolution)
    configureMemoryPromptV2BindingProvider(null)
    configureMemoryPromptV2Transport(null)
    configureRawCompactionBinding(null)
    clearMemoryV2CommandHandlers()
    return null
  }
  if (!options.dbPath) throw new MemoryV2RuntimeUnavailableError('Memory V2 store path is unavailable')
  const hotSnapshotEnabled = gateResolution.MEMORY_HOT_SNAPSHOT.effective
  if (hotSnapshotEnabled && !options.memoryDir) throw new MemoryV2RuntimeUnavailableError('Memory V2 prompt directory is unavailable')
  if (
    hotSnapshotEnabled &&
    (!options.memoryPromptTransport ||
      typeof options.memoryPromptTransport.enqueue !== 'function' ||
      typeof (options.memoryPromptTransport as { consume?: unknown }).consume !== 'function' ||
      typeof (options.memoryPromptTransport as { release?: unknown }).release !== 'function' ||
      typeof (options.memoryPromptTransport as { close?: unknown }).close !== 'function')
  ) throw new MemoryV2RuntimeUnavailableError('Memory V2 prompt transport binding is unavailable')
  const store = new MemoryV2Store({ dbPath: options.dbPath, gates })
  try {
    await store.init()
    configureMemoryV2SkillRuntime(gates, options.generatedSkillOptions, gateResolution)
    if (hotSnapshotEnabled) await ensureMemoryDirExists(options.memoryDir!)
    const fence = new PromptFence({ gates, now: options.now })
    if (hotSnapshotEnabled) {
      configureMemoryPromptV2Transport(options.memoryPromptTransport!)
      configureMemoryPromptV2BindingProvider(input => bindingFor(options, fence, store, input.memoryDir))
    } else {
      configureMemoryPromptV2BindingProvider(null)
      configureMemoryPromptV2Transport(null)
    }
    if (options.rawCapsuleStore && gateResolution.RETRIEVAL_COMPACTION.effective) {
      if (options.rawCapsuleStore.sessionId !== options.sessionId || options.rawCapsuleStore.projectScopeId !== options.projectScopeId) throw new MemoryV2RuntimeUnavailableError('Raw capsule store session or project scope does not match the runtime')
      configureRawCompactionBinding({
        store: options.rawCapsuleStore,
        gates,
        sessionRetentionDeadline: options.rawCapsuleStore.sessionRetentionDeadline(),
        summarize: options.rawCapsuleSummarize,
        now: options.now,
      })
    } else {
      configureRawCompactionBinding(null)
    }
    configureMemoryV2CommandHandlers({
      forgetMemory: async selector => {
        const records = await store.list({ projectScopeId: options.projectScopeId })
        const record = records.find(candidate => candidate.id === selector || candidate.name === selector)
        if (!record) throw new MemoryV2RuntimeUnavailableError('The selected durable memory does not exist in this project scope')
        await store.mutate({
          requestId: `forget:${options.sessionId}:${randomUUID()}`,
          operation: 'delete',
          recordId: record.id,
          projectScopeId: options.projectScopeId,
          expectedVersion: record.version,
        })
        invalidateMemoryPromptRegistrations(record.id, options.projectScopeId)
        if (hotSnapshotEnabled) fence.forgetMemory(record.id, options.projectScopeId)
        if (options.projectionManager) {
          if (!options.projectionPathForRecord || !options.projectionTextForRecord) {
            throw new MemoryV2RuntimeUnavailableError('Memory V2 projection deletion dependencies are unavailable')
          }
          await options.projectionManager.forget(
            record.id,
            options.projectScopeId,
            await options.projectionTextForRecord(record),
            options.projectionPathForRecord(record),
          )
        }
      },
      deleteSessionHistory: async () => {
        if (!options.sessionCryptoDelete || !options.purgeEncryptedArtifacts || options.sessionCryptoAvailable === false) {
          throw new MemoryV2RuntimeUnavailableError('Session crypto deletion dependencies are unavailable')
        }
        invalidateAllMemoryPromptRegistrations()
        fence.closePromptAdmission()
        if (options.rawCapsuleStore) await options.rawCapsuleStore.deleteSession()
        store.close()
        await fence.deleteSessionHistory({
          closePromptAdmission: () => {},
          deleteSessionCrypto: options.sessionCryptoDelete,
          purgeEncryptedArtifacts: options.purgeEncryptedArtifacts,
        })
      },
    }, gates)
    const runtime: MemoryV2Runtime = {
      sessionId: options.sessionId,
      projectScopeId: options.projectScopeId,
      gates,
      gateResolution,
      store,
      fence,
      close: async () => {
        store.close()
        await options.rawCapsuleStore?.close()
        if (activeRuntime?.store === store) {
          activeRuntime = null
          configureMemoryV2SkillRuntime()
          configureMemoryPromptV2BindingProvider(null)
          configureMemoryPromptV2Transport(null)
          configureRawCompactionBinding(null)
          clearMemoryV2CommandHandlers()
        }
      },
    }
    activeRuntime = runtime
    return runtime
  } catch (error) {
    store.close()
    configureMemoryV2SkillRuntime()
    configureMemoryPromptV2BindingProvider(null)
    configureMemoryPromptV2Transport(null)
    configureRawCompactionBinding(null)
    clearMemoryV2CommandHandlers()
    if (error instanceof MemoryV2RuntimeUnavailableError) throw error
    throw new MemoryV2RuntimeUnavailableError(`Memory V2 runtime initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function shutdownMemoryV2Runtime(): Promise<void> {
  if (activeRuntime) {
    await activeRuntime.close()
    return
  }
  configureMemoryPromptV2BindingProvider(null)
  configureMemoryPromptV2Transport(null)
  configureRawCompactionBinding(null)
  configureMemoryV2SkillRuntime()
  clearMemoryV2CommandHandlers()
}
