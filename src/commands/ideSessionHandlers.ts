/**
 * CLI-side handlers for the JetBrains plugin's session RPCs.
 *
 * The plugin's Kotlin `NeocodeService` sends JSON-RPC requests with bare
 * method names (`listSessions`, `createSession`, `switchSession`,
 * `deleteSession`, `shareSession`, `unshareSession`, `ping`) over the
 * existing ws-ide / sse-ide transport. This module registers handlers on
 * the connected MCP `Client` so the SDK dispatches each request by its
 * `method` field (see `protocol.js` `_requestHandlers.get(method)`).
 *
 * Handler backing:
 *  - `listSessions`  → `listSessionsImpl` (read-only stat + head/tail).
 *  - `createSession` → `randomUUID()` (the JSONL is created lazily by the
 *                      first message in the new session, mirroring /branch's
 *                      no-prefill behavior). We don't spawn a neocode
 *                      process here — the plugin's `switchSession` is the
 *                      hook for that, and the running CLI picking the id up
 *                      via `switchSession()` is enough for the in-process
 *                      case.
 *  - `switchSession` → `switchSession(sessionId, projectDir)` from
 *                      `bootstrap/state.ts`. This re-points the *current*
 *                      CLI's active session — subsequent /resume, hooks,
 *                      and transcript writes land in the new session file.
 *  - `deleteSession` → `trash()` (move to OS recycle bin). Returns
 *                      `{ok:false}` if the JSONL doesn't exist.
 *  - `shareSession` / `unshareSession` — placeholder: no remote share
 *                      backend exists in this CLI yet. Returns a placeholder
 *                      URL embedding the sessionId so the plugin can
 *                      surface the round-trip. A real share server would
 *                      plug in here.
 *  - `ping`           → `{ok:true}`. Used by the plugin's ViewModel probe.
 *
 * The Kotlin `SessionModels.kt` mirrors these result shapes; if you change
 * a field here, update the @Serializable data class on the Kotlin side too.
 */

import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { switchSession } from '../bootstrap/state.js'
import { listSessionsImpl, type SessionInfo } from '../utils/listSessionsImpl.js'
import { getProjectDir } from '../utils/sessionStoragePortable.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage.js'
import { logError } from '../utils/log.js'
import type { SessionId } from '../types/ids.js'

// trash is a CommonJS module; import its default.
import trashDefault from 'trash'

// ---------------------------------------------------------------------------
// Result types — mirror `jetbrains-extension/.../model/SessionModels.kt`.
// ---------------------------------------------------------------------------

export type ListSessionsResult = { sessions: SessionInfo[] }
export type CreateSessionResult = { sessionId: string }
export type SwitchSessionResult = { sessionId: string; started: boolean }
export type DeleteSessionResult = { ok: boolean; movedTo?: string }
export type ShareSessionResult = { ok: boolean; url?: string }
export type UnshareSessionResult = { ok: boolean }
export type PingResult = { ok: boolean }

// ---------------------------------------------------------------------------
// Per-method request schemas. Each is a `z.object` with `method: z.literal(...)`
// + a `params` shape — the MCP SDK dispatches request handlers by the bare
// method string, so no `mcp__ide__` prefix is required. The Kotlin
// `WSSession.sendRequest` writes raw JSON-RPC frames with the bare method
// name, which is what the SDK's `_requestHandlers.get(method)` lookup keys on.
// ---------------------------------------------------------------------------

const ListSessionsRequestSchema = z.object({
  method: z.literal('listSessions'),
  params: z
    .object({
      cwd: z.string().optional(),
      limit: z.number().int().nonnegative().optional(),
    })
    .optional(),
})

const CreateSessionRequestSchema = z.object({
  method: z.literal('createSession'),
  params: z
    .object({
      cwd: z.string().optional(),
    })
    .optional(),
})

const SwitchSessionRequestSchema = z.object({
  method: z.literal('switchSession'),
  params: z.object({
    sessionId: z.string(),
    cwd: z.string().optional(),
  }),
})

const DeleteSessionRequestSchema = z.object({
  method: z.literal('deleteSession'),
  params: z.object({
    sessionId: z.string(),
  }),
})

const ShareSessionRequestSchema = z.object({
  method: z.literal('shareSession'),
  params: z.object({
    sessionId: z.string(),
  }),
})

const UnshareSessionRequestSchema = z.object({
  method: z.literal('unshareSession'),
  params: z.object({
    sessionId: z.string(),
  }),
})

const PingRequestSchemaCustom = z.object({
  method: z.literal('ping'),
  params: z.unknown().optional(),
})

// ---------------------------------------------------------------------------
// Handler implementations.
// ---------------------------------------------------------------------------

async function handleListSessions(
  params: z.infer<typeof ListSessionsRequestSchema>['params'],
): Promise<ListSessionsResult> {
  const dir = params?.cwd
  const limit = params?.limit ?? 100
  const sessions = await listSessionsImpl({ dir, limit })
  return { sessions }
}

async function handleCreateSession(
  _params: z.infer<typeof CreateSessionRequestSchema>['params'],
): Promise<CreateSessionResult> {
  // UUID only — JSONL is created lazily by the first message. We don't
  // pre-write a `custom-title` entry because no user input has occurred
  // yet; a placeholder title would show up in /resume listing without
  // context.
  const sessionId = randomUUID()
  return { sessionId }
}

async function handleSwitchSession(
  params: z.infer<typeof SwitchSessionRequestSchema>['params'],
): Promise<SwitchSessionResult> {
  const projectDir = params.cwd
    ? getProjectDir(params.cwd)
    : null
  switchSession(params.sessionId as SessionId, projectDir)
  return { sessionId: params.sessionId, started: true }
}

async function handleDeleteSession(
  params: z.infer<typeof DeleteSessionRequestSchema>['params'],
): Promise<DeleteSessionResult> {
  const filePath = getTranscriptPathForSession(params.sessionId)
  if (!existsSync(filePath)) {
    return { ok: false }
  }
  try {
    await trashDefault(filePath)
    return { ok: true, movedTo: filePath }
  } catch (error) {
    logError(
      new Error(
        `ideSessionHandlers:deleteSession: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      ),
    )
    return { ok: false }
  }
}

async function handleShareSession(
  params: z.infer<typeof ShareSessionRequestSchema>['params'],
): Promise<ShareSessionResult> {
  // Placeholder: no remote backend exists. Round-trip a URL embedding the
  // sessionId so the plugin can surface the round-trip + clipboard copy.
  const url = `neocode://session/${encodeURIComponent(params.sessionId)}`
  return { ok: true, url }
}

async function handleUnshareSession(
  _params: z.infer<typeof UnshareSessionRequestSchema>['params'],
): Promise<UnshareSessionResult> {
  // Placeholder: nothing to revoke locally.
  return { ok: true }
}

async function handlePing(): Promise<PingResult> {
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/**
 * Register all JetBrains session RPC handlers on a connected IDE client.
 * Call once per (re)connection — the MCP SDK overwrites a previously
 * registered handler for the same schema. Safe to call multiple times.
 *
 * Register after `registerAddToContextHandler(client)` so the addToContext
 * notification handler is in place before these request handlers.
 */
export function registerIdeSessionHandlers(client: Client): void {
  client.setRequestHandler(ListSessionsRequestSchema, async request => {
    const result = await handleListSessions(request.params)
    return result
  })

  client.setRequestHandler(CreateSessionRequestSchema, async request => {
    const result = await handleCreateSession(request.params)
    return result
  })

  client.setRequestHandler(SwitchSessionRequestSchema, async request => {
    const result = await handleSwitchSession(request.params as { sessionId: string; cwd?: string })
    return result
  })

  client.setRequestHandler(DeleteSessionRequestSchema, async request => {
    const result = await handleDeleteSession(request.params as { sessionId: string })
    return result
  })

  client.setRequestHandler(ShareSessionRequestSchema, async request => {
    const result = await handleShareSession(request.params as { sessionId: string })
    return result
  })

  client.setRequestHandler(UnshareSessionRequestSchema, async request => {
    const result = await handleUnshareSession(request.params as { sessionId: string })
    return result
  })

  client.setRequestHandler(PingRequestSchemaCustom, async () => {
    const result = await handlePing()
    return result
  })
}
