import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('./teamMemPaths.js') as typeof import('./teamMemPaths.js'))
  : null

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import type {
  PromptFence,
  PromptRequest,
  PromptSnapshot,
  PromptSnapshotRecord,
  SynchronousTransportQueue,
  TransportOwnershipReceipt,
} from '../services/memoryV2/promptFence.js'
import { randomUUID } from 'node:crypto'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  configureSystemPromptMetadataResolver,
  getSystemPromptMetadata,
  setSystemPromptMetadata,
  type SystemPrompt,
} from '../utils/systemPromptType.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memoryTypes.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

export const MEMORY_ONLY_FORGET_MESSAGE =
  'Forgotten from durable memory. This does not remove the information from the current conversation or saved session history. Delete or reset the session to remove its history.'

export const SESSION_HISTORY_DELETE_COMMANDS =
  '/session delete-history or /session reset --delete-history'

export function buildMemoryForgetGuidance(): string[] {
  return [
    '## Forgetting memory',
    '',
    MEMORY_ONLY_FORGET_MESSAGE,
    '',
    `Use ${SESSION_HISTORY_DELETE_COMMANDS} for explicit session-history removal.`,
  ]
}

export function createMemoryPromptSnapshot(input: {
  fence: PromptFence
  projectScopeId: string
  storeGeneration: bigint
  promptEpoch: bigint
  records: readonly PromptSnapshotRecord[]
  maxPromptCharacters: number
  maxPromptTokens: number
}): PromptSnapshot {
  return input.fence.createSnapshot({
    projectScopeId: input.projectScopeId,
    storeGeneration: input.storeGeneration,
    promptEpoch: input.promptEpoch,
    records: input.records,
    maxPromptCharacters: input.maxPromptCharacters,
    maxPromptTokens: input.maxPromptTokens,
  })
}

export type MemoryPromptV2Binding = Readonly<{
  fence: PromptFence
  projectScopeId: string
  storeGeneration: bigint
  promptEpoch: bigint
  records: readonly PromptSnapshotRecord[]
  maxPromptCharacters: number
  maxPromptTokens: number
}>

export type MemoryPromptV2BindingProvider = (input: {
  displayName: string
  memoryDir: string
}) => MemoryPromptV2Binding | null

let memoryPromptV2BindingProvider: MemoryPromptV2BindingProvider | null = null
let memoryPromptV2Transport: SynchronousTransportQueue | null = null
type RegisteredMemoryPrompt = { binding: MemoryPromptV2Binding; snapshot: PromptSnapshot; text: string }
const registeredMemoryPromptSnapshots = new Map<string, RegisteredMemoryPrompt[]>()
const registeredMemoryPromptSystemPrompts = new WeakMap<readonly string[], RegisteredMemoryPrompt>()
const invalidatedMemoryPromptRegistrations = new WeakSet<RegisteredMemoryPrompt>()
const registeredMemoryPromptSystemPromptKeys = new Set<readonly string[]>()
const registrationOrder: RegisteredMemoryPrompt[] = []
const MAX_REGISTERED_MEMORY_PROMPT_ENTRIES = 128
const MAX_REGISTERED_MEMORY_PROMPT_BYTES = 2_000_000
let registeredMemoryPromptBytes = 0

configureSystemPromptMetadataResolver(value => registeredMemoryPromptSystemPrompts.get(value))

function clearRegisteredMemoryPromptSnapshots(): void {
  for (const registration of registrationOrder) invalidatedMemoryPromptRegistrations.add(registration)
  for (const key of registeredMemoryPromptSystemPromptKeys) {
    registeredMemoryPromptSystemPrompts.delete(key)
    setSystemPromptMetadata(key, undefined)
  }
  registeredMemoryPromptSystemPromptKeys.clear()
  registrationOrder.length = 0
  registeredMemoryPromptBytes = 0
  registeredMemoryPromptSnapshots.clear()
}

function registrationBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function removeRegistration(registration: RegisteredMemoryPrompt): void {
  invalidatedMemoryPromptRegistrations.add(registration)
  const registrations = registeredMemoryPromptSnapshots.get(registration.text)
  if (registrations) {
    const index = registrations.indexOf(registration)
    if (index >= 0) registrations.splice(index, 1)
    if (registrations.length === 0) registeredMemoryPromptSnapshots.delete(registration.text)
  }
  const orderIndex = registrationOrder.indexOf(registration)
  if (orderIndex >= 0) registrationOrder.splice(orderIndex, 1)
  registeredMemoryPromptBytes -= registrationBytes(registration.text)
  for (const key of registeredMemoryPromptSystemPromptKeys) {
    if (getSystemPromptMetadata(key) === registration) {
      registeredMemoryPromptSystemPrompts.delete(key)
      setSystemPromptMetadata(key, undefined)
      registeredMemoryPromptSystemPromptKeys.delete(key)
    }
  }
}

function enforceRegistrationBounds(): void {
  while (
    registrationOrder.length > MAX_REGISTERED_MEMORY_PROMPT_ENTRIES ||
    registeredMemoryPromptBytes > MAX_REGISTERED_MEMORY_PROMPT_BYTES
  ) {
    const oldest = registrationOrder[0]
    if (!oldest) return
    removeRegistration(oldest)
  }
}

export function configureMemoryPromptV2BindingProvider(
  provider: MemoryPromptV2BindingProvider | null,
): void {
  memoryPromptV2BindingProvider = provider
  if (!provider) clearRegisteredMemoryPromptSnapshots()
}

export function configureMemoryPromptV2Transport(
  transport: SynchronousTransportQueue | null,
): void {
  memoryPromptV2Transport = transport
  if (!transport) clearRegisteredMemoryPromptSnapshots()
}

export function getMemoryPromptV2TransportQueue(): MemoryPromptTransportQueue | null {
  const transport = memoryPromptV2Transport
  if (
    !transport ||
    typeof (transport as MemoryPromptTransportQueue).consume !== 'function' ||
    typeof (transport as MemoryPromptTransportQueue).release !== 'function' ||
    typeof (transport as MemoryPromptTransportQueue).close !== 'function'
  ) {
    return null
  }
  return transport as MemoryPromptTransportQueue
}

export type MemoryPromptTransportQueue = SynchronousTransportQueue & Readonly<{
  consume(receipt: TransportOwnershipReceipt): unknown
  release(receipt: TransportOwnershipReceipt): void
  close(): void
  pendingCount(): number
}>

export function createMemoryPromptTransportQueue(): MemoryPromptTransportQueue {
  const owned = new Map<string, TransportOwnershipReceipt>()
  const maxEntries = 32
  const maxBytes = 256_000
  let bytes = 0
  let closed = false
  const sizeOf = (payload: unknown): number => {
    if (typeof payload === 'string') return new TextEncoder().encode(payload).byteLength
    try {
      const serialized = JSON.stringify(payload)
      if (serialized === undefined) return Number.POSITIVE_INFINITY
      return new TextEncoder().encode(serialized).byteLength
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }
  const requireOwned = (receipt: TransportOwnershipReceipt): TransportOwnershipReceipt => {
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      receipt.accepted !== true ||
      typeof receipt.requestId !== 'string' ||
      !receipt.requestId
    ) {
      throw new Error('Memory V2 transport receipt is malformed')
    }
    const ownedReceipt = owned.get(receipt.requestId)
    if (
      !ownedReceipt ||
      ownedReceipt !== receipt ||
      ownedReceipt.payload !== receipt.payload
    ) {
      throw new Error('Memory V2 transport receipt is not owned by this queue')
    }
    return ownedReceipt
  }
  const removeOwned = (receipt: TransportOwnershipReceipt): TransportOwnershipReceipt => {
    const ownedReceipt = requireOwned(receipt)
    owned.delete(ownedReceipt.requestId)
    bytes -= sizeOf(ownedReceipt.payload)
    return ownedReceipt
  }
  const queue = {
    enqueue(payload: unknown, requestId: string): TransportOwnershipReceipt | null {
      if (closed || !requestId || owned.has(requestId) || owned.size >= maxEntries) return null
      if (payload && typeof payload === 'object' && !Object.isFrozen(payload)) return null
      const payloadBytes = sizeOf(payload)
      if (!Number.isFinite(payloadBytes) || bytes + payloadBytes > maxBytes) return null
      const receipt = Object.freeze({ accepted: true as const, requestId, payload })
      owned.set(requestId, receipt)
      bytes += payloadBytes
      return receipt
    },
    consume(receipt: TransportOwnershipReceipt): unknown {
      return removeOwned(receipt).payload
    },
    release(receipt: TransportOwnershipReceipt): void {
      removeOwned(receipt)
    },
    close(): void {
      if (owned.size > 0) throw new Error('Memory V2 transport queue still owns committed payloads')
      closed = true
    },
    pendingCount(): number {
      return owned.size
    },
  }
  return Object.freeze(queue)
}

export function registerMemoryPromptSnapshot(input: {
  binding: MemoryPromptV2Binding
  snapshot: PromptSnapshot
  text: string
}): string {
  if (input.snapshot.projectScopeId !== input.binding.projectScopeId) throw new Error('Memory V2 prompt snapshot scope is invalid')
  const current = registeredMemoryPromptSnapshots.get(input.text) ?? []
  const registration = Object.freeze({ binding: input.binding, snapshot: input.snapshot, text: input.text })
  current.push(registration)
  registeredMemoryPromptSnapshots.set(input.text, current)
  registrationOrder.push(registration)
  registeredMemoryPromptBytes += registrationBytes(input.text)
  enforceRegistrationBounds()
  return input.text
}

export function registerMemoryPromptSystemPrompt(systemPrompt: string[]): string[]
export function registerMemoryPromptSystemPrompt(systemPrompt: readonly string[]): SystemPrompt
export function registerMemoryPromptSystemPrompt(
  systemPrompt: readonly string[],
): string[] | SystemPrompt {
  const registered = [...registeredMemoryPromptSnapshots.values()]
    .flat()
    .filter(candidate => !invalidatedMemoryPromptRegistrations.has(candidate))
    .filter(candidate => systemPrompt.some(section => section === candidate.text))
    .at(-1)
  if (registered) {
    registeredMemoryPromptSystemPrompts.set(systemPrompt, registered)
    registeredMemoryPromptSystemPromptKeys.add(systemPrompt)
    return setSystemPromptMetadata(systemPrompt, registered) as string[] | SystemPrompt
  }
  return systemPrompt as SystemPrompt
}

export function hasRegisteredMemoryPrompt(systemPrompt: readonly string[]): boolean {
  const registered = getSystemPromptMetadata(systemPrompt) as RegisteredMemoryPrompt | undefined
  return registered !== undefined && !invalidatedMemoryPromptRegistrations.has(registered)
}

export function invalidateMemoryPromptRegistrations(
  recordId: string,
  projectScopeId: string,
): void {
  for (const registration of [...registrationOrder]) {
    if (registration.snapshot.projectScopeId !== projectScopeId) continue
    if (registration.snapshot.records.some(record => record.id === recordId && record.projectScopeId === projectScopeId)) {
      removeRegistration(registration)
    }
  }
}

export function invalidateAllMemoryPromptRegistrations(): void {
  clearRegisteredMemoryPromptSnapshots()
}

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * Shared by buildMemoryPrompt and claudemd getMemoryFiles (previously
 * duplicated the line-only logic).
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPrompts = feature('TEAMMEM')
  ? (require('./teamMemPrompts.js') as typeof import('./teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.
 * Harness guarantees the directory exists via ensureMemoryDirExists().
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/**
 * Ensure a memory directory exists. Idempotent — called from loadMemoryPrompt
 * (once per session via systemPromptSection cache) so the model can always
 * write without checking existence first. FsOperations.mkdir is recursive
 * by default and already swallows EEXIST, so the full parent chain
 * (~/.claude/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir already handles EEXIST internally. Anything reaching here is
    // a real problem (EACCES/EPERM/EROFS) — log so --debug shows why. Prompt
    // building continues either way; the model's Write will surface the
    // real perm error (and FileWriteTool does its own mkdir of the parent).
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * Log memory directory file/subdir counts asynchronously.
 * Fire-and-forget — doesn't block prompt building.
 */
function logMemoryDirCounts(
  memoryDir: string,
  baseMetadata: Record<
    string,
    | number
    | boolean
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  >,
): void {
  const fs = getFsImplementation()
  void fs.readdir(memoryDir).then(
    dirents => {
      let fileCount = 0
      let subdirCount = 0
      for (const d of dirents) {
        if (d.isFile()) {
          fileCount++
        } else if (d.isDirectory()) {
          subdirCount++
        }
      }
      logEvent('tengu_memdir_loaded', {
        ...baseMetadata,
        total_file_count: fileCount,
        total_subdir_count: subdirCount,
      })
    },
    () => {
      // Directory unreadable — log without counts
      logEvent('tengu_memdir_loaded', baseMetadata)
    },
  )
}

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 * Constrains memories to a closed four-type taxonomy (user / feedback / project /
 * reference) — content that is derivable from the current project state (code
 * patterns, architecture, git history) is explicitly excluded.
 *
 * Individual-only variant: no `## Memory scope` section, no <scope> tags
 * in type blocks, and team/private qualifiers stripped from examples.
 *
 * Used by both buildMemoryPrompt (agent memory, includes content) and
 * loadMemoryPrompt (system prompt, content injected via user context instead).
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
        '',
        `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    ...buildMemoryForgetGuidance(),
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * Build the typed-memory prompt with MEMORY.md content included.
 * Used by agent memory (which has no getClaudeMds() equivalent).
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
  v2?: MemoryPromptV2Binding
  v2Snapshot?: PromptSnapshot
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME
  const binding = params.v2 ?? memoryPromptV2BindingProvider?.({ displayName, memoryDir }) ?? null
  if (binding && !params.v2Snapshot) throw new Error('Memory V2 prompts must use a committed transport envelope')
  const snapshot = params.v2Snapshot ?? (binding ? createMemoryPromptSnapshot(binding) : null)

  // Directory creation is the caller's responsibility (loadMemoryPrompt /
  // loadAgentMemoryPrompt). Builders only read, they don't mkdir.

  // Read existing memory entrypoint (sync: prompt building is synchronous)
  let entrypointContent = ''
  if (snapshot) {
    const entrypointRecord = snapshot.records.find(record => record.id === ENTRYPOINT_NAME)
    if (!entrypointRecord || typeof entrypointRecord.content !== 'string') {
      throw new Error('Memory V2 snapshot is missing the frozen MEMORY.md entrypoint')
    }
    entrypointContent = entrypointRecord.content
  } else {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs
      entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
    } catch {
      // No memory file yet
    }
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    const memoryType = displayName === AUTO_MEM_DISPLAY_NAME ? 'auto' : 'agent'
    logMemoryDirCounts(memoryDir, {
      content_length: t.byteCount,
      line_count: t.lineCount,
      was_truncated: t.wasLineTruncated,
      was_byte_truncated: t.wasByteTruncated,
      memory_type:
        memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

export type FencedMemoryPromptEnvelope = Readonly<{
  text: string
  fence: PromptFence
  snapshot: PromptSnapshot
  request: PromptRequest
  receipt: TransportOwnershipReceipt
}>

export type MemoryPromptTransport = Readonly<{
  enqueue(payload: unknown, requestId: string): TransportOwnershipReceipt | null
}>

export function buildMemoryPromptForTransport(input: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
  v2?: MemoryPromptV2Binding
  transport: SynchronousTransportQueue
}): FencedMemoryPromptEnvelope {
  const binding = input.v2 ?? memoryPromptV2BindingProvider?.({ displayName: input.displayName, memoryDir: input.memoryDir }) ?? null
  if (!binding) throw new Error('Memory V2 prompt binding is unavailable')
  const snapshot = createMemoryPromptSnapshot(binding)
  const text = buildMemoryPrompt({ ...input, v2: binding, v2Snapshot: snapshot })
  const requestId = `memory-prompt:${randomUUID()}`
  binding.fence.begin({
    requestId,
    payload: text,
    snapshot,
    memoryRecordIds: binding.records.map(record => record.id),
    budget: {
      characters: Array.from(text).length,
      tokens: Math.ceil(Array.from(text).length / 4),
    },
  })
  binding.fence.waitForLease(requestId)
  const lease = binding.fence.acquireLease()
  try {
    binding.fence.admit(requestId, lease)
    const receipt = binding.fence.commitSend(requestId, lease, input.transport)
    if (!receipt) throw new Error('Memory V2 transport queue rejected the prompt')
    const request = binding.fence.getRequest(requestId)
    binding.fence.releaseLease(lease)
    return Object.freeze({ text, fence: binding.fence, snapshot, request, receipt })
  } catch (error) {
    if (binding.fence.getRequest(requestId).state !== 'SEND_COMMITTED') {
      try { binding.fence.releaseLease(lease) } catch {}
    }
    throw error
  }
}

export function commitRegisteredMemoryPrompt(
  systemPrompt: readonly string[],
  transport?: SynchronousTransportQueue,
): FencedMemoryPromptEnvelope {
  if (!memoryPromptV2Transport) throw new Error('Memory V2 prompt transport binding is unavailable')
  const registered = getSystemPromptMetadata(systemPrompt) as RegisteredMemoryPrompt | undefined
  if (!registered || invalidatedMemoryPromptRegistrations.has(registered)) throw new Error('Memory V2 prompt snapshot is unavailable')
  const requestId = `memory-prompt:${randomUUID()}`
  registered.binding.fence.begin({
    requestId,
    payload: registered.text,
    snapshot: registered.snapshot,
    memoryRecordIds: registered.binding.records.map(record => record.id),
    budget: {
      characters: Array.from(registered.text).length,
      tokens: Math.ceil(Array.from(registered.text).length / 4),
    },
  })
  registered.binding.fence.waitForLease(requestId)
  const lease = registered.binding.fence.acquireLease()
  try {
    registered.binding.fence.admit(requestId, lease)
    const receipt = registered.binding.fence.commitSend(requestId, lease, transport ?? memoryPromptV2Transport)
    if (!receipt) throw new Error('Memory V2 prompt transport queue rejected the prompt')
    const request = registered.binding.fence.getRequest(requestId)
    registered.binding.fence.releaseLease(lease)
    return Object.freeze({ text: registered.text, fence: registered.binding.fence, snapshot: registered.snapshot, request, receipt })
  } catch (error) {
    try {
      if (registered.binding.fence.getRequest(requestId).state !== 'SEND_COMMITTED') registered.binding.fence.releaseLease(lease)
    } catch {}
    throw error
  }
}

export async function loadMemoryPromptForTransport(input: {
  transport: MemoryPromptTransport
  extraGuidelines?: string[]
}): Promise<FencedMemoryPromptEnvelope | null> {
  if (!isAutoMemoryEnabled()) return null
  const memoryDir = getAutoMemPath()
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) throw new Error('Memory V2 transport does not support combined team memory prompts')
  if (feature('KAIROS') && getKairosActive()) throw new Error('Memory V2 transport does not support daily-log prompts')
  await ensureMemoryDirExists(memoryDir)
  return buildMemoryPromptForTransport({
    displayName: AUTO_MEM_DISPLAY_NAME,
    memoryDir,
    extraGuidelines: input.extraGuidelines,
    transport: input.transport,
  })
}

/**
 * Assistant-mode daily-log prompt. Gated behind feature('KAIROS').
 *
 * Assistant sessions are effectively perpetual, so the agent writes memories
 * append-only to a date-named log file rather than maintaining MEMORY.md as
 * a live index. A separate nightly /dream skill distills logs into topic
 * files + MEMORY.md. MEMORY.md is still loaded into context (via claudemd.ts)
 * as the distilled index — this prompt only changes where NEW memories go.
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  // Describe the path as a pattern rather than inlining today's literal path:
  // this prompt is cached by systemPromptSection('memory', ...) and NOT
  // invalidated on date change. The model derives the current date from the
  // date_change attachment (appended at the tail on midnight rollover) rather
  // than the user-context message — the latter is intentionally left stale to
  // preserve the prompt cache prefix across midnight.
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system found at: \`${memoryDir}\``,
    '',
    "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file:",
    '',
    `\`${logPathPattern}\``,
    '',
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    '',
    'Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.',
    '',
    '## What to log',
    '- User corrections and preferences ("use bun, not npm"; "stop summarizing diffs")',
    '- Facts about the user, their role, or their goals',
    '- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)',
    '- Pointers to external systems (dashboards, Linear projects, Slack channels)',
    '- Anything the user explicitly asks you to remember',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...(skipIndex
      ? []
      : [
          `## ${ENTRYPOINT_NAME}`,
          `\`${ENTRYPOINT_NAME}\` is the distilled index (maintained nightly from your logs) and is loaded into your context automatically. Read it for orientation, but do not edit it directly — record new information in today's log instead.`,
          '',
        ]),
    ...buildSearchingPastContextSection(memoryDir),
  ]

  return lines.join('\n')
}

/**
 * Build the "Searching past context" section if the feature gate is enabled.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // Ant-native builds alias grep to embedded ugrep and remove the dedicated
  // Grep tool, so give the model a real shell invocation there.
  // In REPL mode, both Grep and Bash are hidden from direct use — the model
  // calls them from inside REPL scripts, so the grep shell form is what it
  // will write in the script anyway.
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memSearch = embedded
    ? `grep -rn "<search term>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${autoMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your memory directory:',
    '```',
    memSearch,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}

/**
 * Load the unified memory prompt for inclusion in the system prompt.
 * Dispatches based on which memory systems are enabled:
 *   - auto + team: combined prompt (both directories)
 *   - auto only: memory lines (single directory)
 * Team memory requires auto memory (enforced by isTeamMemoryEnabled), so
 * there is no team-only branch.
 *
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  const memoryV2Binding = autoEnabled
    ? memoryPromptV2BindingProvider?.({ displayName: AUTO_MEM_DISPLAY_NAME, memoryDir: getAutoMemPath() }) ?? null
    : null
  if (memoryV2Binding) {
    if (!memoryPromptV2Transport) throw new Error('Memory V2 prompt transport binding is unavailable')
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) throw new Error('Memory V2 transport does not support combined team memory prompts')
    if (feature('KAIROS') && getKairosActive()) throw new Error('Memory V2 transport does not support daily-log prompts')
    const memoryDir = getAutoMemPath()
    await ensureMemoryDirExists(memoryDir)
    const snapshot = createMemoryPromptSnapshot({
      fence: memoryV2Binding.fence,
      projectScopeId: memoryV2Binding.projectScopeId,
      storeGeneration: memoryV2Binding.storeGeneration,
      promptEpoch: memoryV2Binding.promptEpoch,
      records: memoryV2Binding.records,
      maxPromptCharacters: memoryV2Binding.maxPromptCharacters,
      maxPromptTokens: memoryV2Binding.maxPromptTokens,
    })
    const text = buildMemoryPrompt({ displayName: AUTO_MEM_DISPLAY_NAME, memoryDir, v2: memoryV2Binding, v2Snapshot: snapshot })
    return registerMemoryPromptSnapshot({ binding: memoryV2Binding, snapshot, text })
  }

  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )

  // KAIROS daily-log mode takes precedence over TEAMMEM: the append-only
  // log paradigm does not compose with team sync (which expects a shared
  // MEMORY.md that both sides read + write). Gating on `autoEnabled` here
  // means the !autoEnabled case falls through to the tengu_memdir_disabled
  // telemetry block below, matching the non-KAIROS path.
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    logMemoryDirCounts(getAutoMemPath(), {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // Cowork injects memory-policy text via env var; thread into all builders.
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths!.getTeamMemPath()
      // Harness guarantees these directories exist so the model can write
      // without checking. The prompt text reflects this ("already exists").
      // Only creating teamDir is sufficient: getTeamMemPath() is defined as
      // join(getAutoMemPath(), 'team'), so recursive mkdir of the team dir
      // creates the auto dir as a side effect. If the team dir ever moves
      // out from under the auto dir, add a second ensureMemoryDirExists call
      // for autoDir here.
      await ensureMemoryDirExists(teamDir)
      logMemoryDirCounts(autoDir, {
        memory_type:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logMemoryDirCounts(teamDir, {
        memory_type:
          'team' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return teamMemPrompts!.buildCombinedMemoryPrompt(
        extraGuidelines,
        skipIndex,
      )
    }
  }

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // Harness guarantees the directory exists so the model can write without
    // checking. The prompt text reflects this ("already exists").
    await ensureMemoryDirExists(autoDir)
    logMemoryDirCounts(autoDir, {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildMemoryLines(
      'auto memory',
      autoDir,
      extraGuidelines,
      skipIndex,
    ).join('\n')
  }

  logEvent('tengu_memdir_disabled', {
    disabled_by_env_var: isEnvTruthy(
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ),
    disabled_by_setting:
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) &&
      getInitialSettings().autoMemoryEnabled === false,
  })
  // Gate on the GB flag directly, not isTeamMemoryEnabled() — that function
  // checks isAutoMemoryEnabled() first, which is definitionally false in this
  // branch. We want "was this user in the team-memory cohort at all."
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)) {
    logEvent('tengu_team_memdir_disabled', {})
  }
  return null
}
