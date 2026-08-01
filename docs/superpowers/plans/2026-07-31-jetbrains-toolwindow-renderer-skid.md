# JetBrains Tool-Window Renderer Skid Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the full opencode-jb renderer stack (tool-window ViewModel + Panel MVVM refactor, SessionListDialog + ViewModel, session-management RPCs) into the Neocode JetBrains plugin. Uses the existing `WSSession` + `MCPService` transport, replacing upstream's HTTP-based session API with bidirectional JSON-RPC 2.0. The CLI side adds real handlers (`listSessions`/`createSession`/`deleteSession`/`shareSession`/`unshareSession`/`switchSession`) backed by `listSessionsImpl` + `saveCustomTitle` + `trash` recycle bin.

**Architecture:** MVVM — Panel owns UI (Layout, loading/error/data states); ViewModel owns state (`ErrorSuccessView`, `SessionContext`, `AppStatus`) + coroutine scope. Factory creates ToolWindow + wires ViewModel + toolbar actions implicitly. Bidirectional JSON-RPC 2.0 via hand-rolled WS `sendRequest`/`get(` replacement split, `json` id-bearing = non-null request dispatcher) + `MCPService.sendRequest` delegate. CLI-side `registerIDESessionHandlers(client)` as `setRequestHandler` entries in `client.ts`.

**Tech Stack:** Kotlin + IntelliJ Platform 2025.2 + `kotlinx.serialization.json` + `kotlinx-coroutines-core`; hand-rolled WS `WSSession`; `trash` npm package for recycle-bin delete.

## File Structure

### New files (plugin—Kotlin):
- `src/main/kotlin/wtf/pana/neocode/jetbrains/model/SessionModels.kt` — `SessionInfo`, `JsonRpcResponse`, `JsonRpcException`
- `src/main/kotlin/wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowViewModel.kt`
- `src/main/kotlin/wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowPanel.kt` (existing — rewrite)
- `src/main/kotlin/wtf/pana/neocode/jetbrains/toolwindow/IconProvider.kt` — icon helper
- `src/main/kotlin/wtf/pana/neocode/jetbrains/ui/SessionListViewModel.kt`
- `src/main/kotlin/wtf/pana/neocode/jetbrains/ui/SessionListDialog.kt` + `DialogProvider` companion
- `src/main/kotlin/wtf/pana/neocode/jetbrains/ui/ShowSessionsAction.kt` (toolbar-registered via plugin.xml)
- `src/main/kotlin/wtf/pana/neocode/jetbrains/ui/Constants.kt` — shared text/sizes
- `src/main/kotlin/wtf/pana/neocode/jetbrains/services/JsonExtensions.kt` — JSONType extension helpers

### Test files (plugin—Kotlin):
- `src/test/kotlin/wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowViewModelTest.kt`
- `src/test/kotlin/wtf/pana/neocode/jetbrains/ui/SessionListViewModelTest.kt`
- `src/test/kotlin/wtf/pana/neocode/jetbrains/services/WSSessionTest.kt`
- `src/test/kotlin/wtf/pana/neocode/jetbrains/services/MCPServiceTest.kt`

### New files (CLI—TypeScript):
- `src/commands/ideSessionHandlers.ts` — 6 RPC handlers
- `src/utils/projectToRpcSessionInfo.ts` — mapper

### Modified files:
- `NeocodeService.kt` — 3 deltas + 6 session methods
- `WSSession.kt` — `sendRequest` + `readLoop` split + writeLock
- `MCPService.kt` — `sendRequest(server, method, params): JsonElement`
- `NeocodeToolWindowFactory.kt` — inline ViewModel wiring
- `NeocodeSettings.kt` — `sessionLimit` setting
- `plugin.xml` — `<action>` registration
- `client.ts` — one-line `registerIDESessionHandlers` call
- `package.json` — `"trash"` dependency

---

## Tasks

### T1: NeocodeSettings sessionLimit field
**Files:** `NeocodeSettings.kt`
- [ ] Step 1: Read existing settings class; confirm `autoRestartOnExit` lives under `State(name = "NeocodeSettings")`
- [ ] Step 2: Add `var sessionLimit: Int = 100` with corresponding getter/setter
- [ ] Step 3: Build plugin (`./gradlew :jetbrains-extension:compileKotlin`)
- [ ] Step 4: Verify compile passes
- [ ] Step 5: Commit

### T2: WSSession sendRequest + readLoop split + writeLock
**Files:** `WSSession.kt`, new `WSSessionTest.kt`
- [ ] Step 1: Write `WSSessionTest.kt` — test `sendRequest` sends id-bearing JSON, `readLoop` dispatches parsed response to pending CompletableFuture
- [ ] Step 2: Run test, verify fails (compile pass but tests fail for now)
- [ ] Step 3: Port `sendRequest(method, params, timeoutMs)` from upstream — generate non-null `id` (UUID), write JSON-RPC 2.0 request frame, park completable future in `outstandingRequests[id]`, block at most timeout ms
- [ ] Step 4: Split `readLoop` from `single-callback` → `(onRequest, onResponse)` — `onRequest` fires for incoming requests (method decode), `onResponse` completes outstanding future by `id`
- [ ] Step 5: Add `@Volatile private val writeLock = Object()` → synchronize all `sendFrame` blocks under lock
- [ ] Step 6: Run test, verify passes
- [ ] Step 7: Commit

### T3: MCPService.sendRequest
**Files:** `MCPService.kt`, new `MCPServiceTest.kt`
- [ ] Step 1: Write `MCPServiceTest.kt` — verifying `sendRequest` delegates through WSSession
- [ ] Step 2: Run test, verify fails
- [ ] Step 3: Add `suspend fun sendRequest(method: String, params: JsonObject, timeout: Long = 20_000): JsonElement` — wraps JSON param as frame and dispatches
- [ ] Step 4: Build, verify compile passes
- [ ] Step 5: Commit

### T4: SessionModels + JsonExtensions
**Files:** `model/SessionModels.kt`, `services/JsonExtensions.kt`
- [ ] Step 1: Write `SessionModels.kt` — `SessionInfo(id, title, summary, lastModified)` + `SessionListResult` + `JsonRpcError`
- [ ] Step 2: Write `JsonExtensions.kt` — inline json parse/serialize + error parse helpers
- [ ] Step 3: Build, verify compile passes
- [ ] Step 4: Commit

### T5: NeocodeToolWindowViewModel + Panel rewrite
**Files:** `NeocodeToolWindowPanel.kt` (rewrite), `NeocodeToolWindowViewModel.kt` (new), `NeocodeToolWindowFactory.kt` (modify)
- [ ] Step 1: Write test `NeocodeToolWindowViewModelTest.kt` — instantiation, session context update, AppStatus states
- [ ] Step 2: Run test, it'll fail on absent class first, then on partial API
- [ ] Step 3: Port `OpenCodeToolWindowViewModel.kt` → `NeocodeToolWindowViewModel.kt`: handle top-bar load + pause on viewModel { start } session
- [ ] Step 4: Port `OpenCodeToolWindowPanel.kt` → replace `NeocodeToolWindowPanel.kt` with MVVM-structure panel that owns a ViewModel
- [ ] Step 5: Wire ViewModel with ViewModelProvider as in spec companion
- [ ] Step 6: `Thread.sleep(1000)` → `delay(1000)` (coroutine)
- [ ] Step 7: Build, verify test passes
- [ ] Step 8: Commit

### T6: NeocodeService 3 deltas
**Files:** `NeocodeService.kt`
- [ ] Step 1: Read current `NeocodeService.kt` to verify current signatures
- [ ] Step 2: Delta 1 — `startServer(port: Int): Boolean` (drop freePort scanning)
- [ ] Step 3: Delta 2 — `private → internal suspend fun isServerRunning(port: Int): Boolean`
- [ ] Step 4: Delta 3 — add field `private val mcpService = MCPConnection`... or use delegated service instance reference
- [ ] Step 5: Build - verify compile passes
- [ ] Step 6: Commit

### T7: SessionListViewModel + SessionListDialog + ShowSessionsAction
**Files:** `ui/SessionListViewModel.kt` (new), `ui/SessionListDialog.kt` (new), `ui/ShowSessionsAction.kt` (new)
- [ ] Step 1: Write `SessionListViewModelTest.kt` — list loading, delete flow, share flow, error stack
- [ ] Step 2: Run test, verify fails
- [ ] Step 3: Port opencode-jb `SessionListViewModel`: all state fields + `loadSessions()`, `newSession()`, `deleteSession()`, `onShare()`
- [ ] Step 4: Port `SessionListDialog.kt` — dialog layout with filter panel + session list + CRUD buttons + error handling + share/unshare actions
- [ ] Step 5: Port `ShowSessionsAction.kt` — toolbar toggle action with icon badge → open dialog
- [ ] Step 6: Register in `plugin.xml` under `<actions>`
- [ ] Step 7: Run test, verify passes
- [ ] Step 8: Commit

### T8: NeocodeService 6 session methods
**Files:** `NeocodeService.kt`
- [ ] Step 1: Add 6 suspend methods each calling `mcpService.sendRequest()` with appropriate JSON decode:
  - `suspend fun listSessions(timeout: Long = 20_000L): List<SessionInfo>`
  - `suspend fun createSession(name: String, title: String, timeout: Long = 20_000L): String` — returns new sessionId
  - `suspend fun deleteSession(sessionId: String, timeout: Long = 20_000L): Unit`
  - `suspend fun shareSession(sessionId: String, timeout: Long = 20_000L): String` — returns shareLink or token
  - `suspend fun unshareSession(sessionId: String, timeout: Long = 20_000L): Unit`
  - `suspend fun switchSession(sessionId: String, timeout: Long = 20_000L): Unit`
- [ ] Step 2: Build — verify when compiled
- [ ] Step 3: Commit

### T9: CLI-side session RPC handlers + mapper
**Files:** `src/commands/ideSessionHandlers.ts` (new), `src/utils/projectToRpcSessionIcon.ts` (new), `src/services/mcp/client.ts` (modify), `package.json` (add trunk dependency after verification)
- [ ] Step 1: Write `projectToRpcSessionInfo.ts` — Framework -> flat `{ id, title, summary, lastModified }`
- [ ] Step 2: Write `idesessionHandlers.ts` — 6 handlers:
  - `listSessions`: scan `listSessionsImpl` → truncate to `sessionLimit` from config → return array
  - `createSession`: `write_new_sessions` records → uses `saveCustomTitle` → returns session-envelope
  - `deleteSession`: `trash(path)` recycle-bin delete
  - `shareSession`: returns `share-link` —this is simple string future, actual impl shallow
  - `unshareSession`: returns empty success
  - `switchSession`: returns `success` (with self-later caveat about focus in tool window)
- [ ] Step 3: Add `trash` as dependency in `package.json` (`"trash": "^9.0.0"`)
- [ ] Step 4: Register `registerIDESessionHandlers(client)` at the output in `client.ts`, call inline method right after `registerAddToContextHandler(client)` at line 1232
- [ ] Step 5: Run `bun build`, confirm no build errors
- [ ] Step 6: Commit

### T10: Final verification gate
**Files:** all new + modified
- [ ] Step 1: Run all plugin tests (`./gradlew :jetbrains-extension:test`)
- [ ] Step 2: Run full Neocode build (`bun run build`)
- [ ] Step 3: Run `bun test` against `bun src/commands/ideSessionHandlers.??` test
- [ ] Step 4: Manual smoke checklist (10 steps):
  1. Launch IDE → Neocode tool window icon appeared
  2. Click icon → HomeMain andSpinner loading occurs
  3. Toolbar has "Session list" icon → click → session Dialog opens
  4. Dialog shows existing session(s) from JSONL
  5. Create New session button → success → session appears in list
  6. Delete session → recycle bin → list removes item
  7. Close and reopen dialog — session counts delivered
  8. Error state display (disconnect WS) shows error view
  9. Restart IDE while connected — session persists, list re-labels
  10. Final sanity: list all arranged sessions → no crash
- [ ] Step 5: Commit final fix if any bug emerges