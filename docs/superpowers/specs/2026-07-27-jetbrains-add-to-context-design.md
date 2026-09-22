# JetBrains Plugin — "Add to Context" Design Spec

**Date:** 2026-07-27  
**Status:** Design approved (brainstorm gate passed)  
**Scope:** Plugin (jetbrains-extension/) + Neocode client-side notification listener (parent repo).  
**Not in scope:** Implementation (invoked writing-plans as next step).

---

## 1. Context

The Neocode fork (from Claude Code) needs a custom IDE plugin — upstream Anthropic plugin is not open source. Partial upstream snippets (`DiffTools.kt` fragments, ~8KB in `known.txt`) cover only the `openDiff` tool. The spike plan (`eager-beaming-dove.md`, 20-25h) defines the full protocol surface. This spec narrows to the milestone-driven approach: transport-first, milestone phasing, milestone 2 delivers the user-facing Add-to-Context feature before DiffTools.

---

## 2. Lockfile & Protocol Contract (Section 2 result)

Lockfile: `~/.claude/ide/{port}.lock` (JSON). Transport field = `"ws"` (matches `client.ts` line 366: `transport === 'ws'`), NOT `"ws-ide"` (the `ws-ide` is the config type, not the lockfile value). Fields: `transport`, `port`, `pid`, `ideName`, `workspaceFolders` (string[]), `runningInWindows` (bool), `authToken` (optional).

Transport: hand-rolled WS server via kotlinx-io + minimal RFC 6455 frame parsing over NIO. JDK 21 has `HttpClient` WebSocket (client only) — no server endpoint. Netty not chosen (internal IDE dependency). Plugin generates `authToken` at `start()`; verifies `X-Claude-Code-Ide-Authorization` header.

---

## 3. MCP Server Architecture (Section 1: Option A, approved)

Single dispatcher: `MCPService.dispatch(request: JsonElement): JsonElement`. Methods: `initialize`, `initialized`, `notifications/*`, `tools/*`, `resources/*` (stub). Registry: `ConcurrentHashMap<String, ToolDef>` on `MCPService`. `ToolDef = (name, description, inputSchemaClass, handler: (Project, Args) -> CallToolResult)`.

Why Option A over Option B (layered McpTransport/McpSession/McpServer): Option A minimizes speculative abstractions; matches `DiffTools.addTools()` shape (registers against a `Server`-like object); SSE extraction later is obvious (replace dispatch loop, keep registry).

---

## 4. Add-to-Context Design (Section 3, approved)

### Plugin side
- Action: `SendToClaudeAction` (`action("Send to Neocode Context...")`). Group: `EditorPopupMenu`. Enabled only when `editor != null` AND `MCPService.isConnected == true`.
- Reads: `CommonDataKeys.EDITOR.selectionModel.selectedText`, `PSI_FILE.virtualFile.path`, file type for language detection.
- Calls `MCPService.getInstance().sendAddToContext(text?, filePath?, language?)`.
- Payload: `mcp__ide__addToContext` notification (JSON-RPC `notifications/` method). Content: `{text: string, filePath?: string, language?: string}`. Optional `fits?: bool` computed by plugin against a max-context-size parameter (configurable default).

### Client side (parent repo — `src/services/mcp/client.ts`)
- Near `maybeNotifyIDEConnected` (line ~1228), add `client.setNotificationHandler(AddToContextSchema, async payload => { ... })`.
- On receive: if `payload.text` length fits current context window → inject into active conversation context. If not → show `NotificationManager.notifyInfo("Selection too large", ...)`. Handler lives next to `maybeNotifyIDEConnected` — same `client.ts`, same connection lifecycle.
- Schema definition: add to `types.ts` or inline — `{text: z.string(), filePath: z.optional(z.string()), language: z.optional(z.string()), fits: z.optional(z.boolean())}`.

---

## 5. Milestone Phasing (approved)

Phase 1 (transport foundation, ~6h): WS server + lockfile + `argsClassToToolInputSchema` + `MCPService` registry + Neocode-side `ide_connected` working end-to-end.  
Phase 2 (Add-to-Context vertical, ~4h): `SendToClaudeAction` + `sendAddToContext` + `mcp__ide__addToContext` notification + Neocode listener + notification manager updates.  
Phase 3 (core diffs, ~5-6h): `DiffTools` (verbatim snippets), `openFile`, `close_tab`, `closeAllDiffTabs`.  
Phase 4 (~5-6h): `getDiagnostics`, `executeCode`, terminal actions (`OpenInTerminal`), `set_permission_mode`, Marketplace packaging (`pluginVerifier`, `zipSigner`).

---

## 6. Testing (manual smoke via `runIde` only; no automated test framework required for spike)

Each milestone validated by: start plugin via `runIde` / `buildPlugin`, connect from Neocode CLI (`ide` detection), trigger feature, observe balloon / diff open / notification delivery.

---

## 7. Scope Boundary

Spec includes plugin + Neocode listener (`client.ts` addition). Next step (`writing-plans`) will decompose into implementation tasks per milestone. Spec is saved to this file; user must review before `writing-plans` is invoked.

---
## Spec Self-Review (completed)

- Placeholder scan: no "TBD" / "TODO" remaining in design sections. Implementation TODOs preserved in source files — expected, not missing.
- Internal consistency: Milestone 2 (Add-to-Context) relies on Phase 1 (transport + `MCPService`); design shows `SendToClaudeAction` calls `MCPService.getInstance()` which exists from Phase 1. Lockfile transport = `"ws"` aligns with `client.ts`. No contradictions.
- Scope: Focused on Add-to-Context feature + transport protocol. DiffTools details deferred to milestone 3. No unrelated refactoring.
- Ambiguity resolved: `transport: "ws"` (not `"ws-ide"`) — confirmed against `client.ts` line 366. `SendToContext` payload shape specified. Neocode listener location specified (`client.ts` near `maybeNotifyIDEConnected`).
