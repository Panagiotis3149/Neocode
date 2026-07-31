# JetBrains Plugin — Tool Window Renderer Skid Design Spec

**Date:** 2026-07-31
**Status:** Design approved (brainstorm gate passed)
**Scope:** Plugin (jetbrains-extension/) — tool window renderer MVVM refactor + `SessionListDialog`/`SessionListViewModel` port + bidirectional JSON-RPC delta + CLI-side session RPC handlers.
**Not in scope:** Implementation (invoking `writing-plans` as next step).

---

## 1. Context

User directive: *"We need to /skid the WHOLE renderer from https://github.com/titonio/opencode-jb/ (while still adapting), you barely made any changes."*

This spec covers a wholesale port-and-adapt of the upstream `opencode-jb` JetBrains renderer into the Neocode fork's plugin. Source lives in `opencode-jb-upstream/src/main/kotlin/com/opencode/...` on this dev machine. Three locked clarifications from the brainstorming AskUserQuestion rounds:

- **Scope** = "Tool window + ViewModel only" (skip editor/VFS subsystem), including `SessionListDialog` + `SessionListViewModel`.
- **Session API** = "Build session API too" — real endpoints on the CLI side reading session JSONL from disk.
- **Approach** = "Approach 1: MCP (Recommended)" — reuse existing WS transport via bidirectional JSON-RPC, NOT an HTTP server.

### OpenCode → Neocode rename span

Package: `com.opencode.*` → `wtf.pana.neocode.jetbrains.*`.
Class renames: `OpenCodeService` → `NeocodeService`, `OpenCodeToolWindow{Factory,Panel,ViewModel}` → `NeocodeToolWindow{Factory,Panel,ViewModel}`.
String/label deltas: `"OpenCode Sessions"` → `"Neocode Sessions"`, settings reach-through renamed to `NeocodeSettings`.

### Components inventory (this skid touches)

New (Kotlin):
- `wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowViewModel.kt` (Section 2)
- `wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowPanel.kt` (Section 3, file move + MVVM refactor)
- `wtf/pana/neocode/jetbrains/model/SessionModels.kt` (Section 5, verbatim data-class port)
- `wtf/pana/neocode/jetbrains/ui/SessionListViewModel.kt` (Section 5)
- `wtf/pana/neocode/jetbrains/ui/SessionListDialog.kt` (Section 5)
- `wtf/pana/neocode/jetbrains/ui/ShowSessionsAction.kt` (Section 5.5)
- `wtf/pana/neocode/jetbrains/service/JsonExtensions.kt` (Section 5.4)
- `wtf/pana/neocode/jetbrains/tools/JsonRpcException.kt` (Section 6.3)

Modified (Kotlin):
- `wtf/pana/neocode/jetbrains/service/NeocodeService.kt` (Sections 4 + 5.4)
- `wtf/pana/neocode/jetbrains/services/WSSession.kt` (Section 6.2-6.5)
- `wtf/pana/neocode/jetbrains/services/MCPService.kt` (Section 6.4)
- `wtf/pana/neocode/jetbrains/NeocodeToolWindowFactory.kt` → moves to `toolwindow/` subpackage (Section 4)
- `jetbrains-extension/src/main/resources/META-INF/plugin.xml` (Sections 4 + 5.5)

New (TypeScript):
- `src/services/mcp/ideSessionHandlers.ts` (Section 7)

Modified (TypeScript):
- `src/services/mcp/client.ts` (Section 7.5, one-line registration)

Unchanged:
- `wtf/pana/neocode/jetbrains/util/TerminalUtils.kt` (Section 1 confirmed no change)

---

## 2. ViewModel extraction (NeocodeToolWindowViewModel)

Source: `opencode-jb-upstream/.../toolwindow/OpenCodeToolWindowViewModel.kt` (276 LOC).

### Class signature

```kotlin
class NeocodeToolWindowViewModel(
    private val service: NeocodeService,
    private val scope: CoroutineScope
) {
    @Volatile var currentState: State = State.INITIALIZING
        private set
    @Volatile var currentPort: Int? = null
        private set
    @Volatile private var isMonitoring = false
    private var callback: ViewCallback? = null

    enum class State { INITIALIZING, RUNNING, EXITED, RESTARTING }
    interface ViewCallback {
        fun onStateChanged(state: State)
        fun onPortReady(port: Int)
        fun onError(message: String)
        fun onProcessExited()
    }

    companion object {
        private const val MIN_PORT = 16384
        private const val MAX_PORT = 65536
    }
}
```

### Method provenance

| Method | Skid source line | Provenance |
|---|---|---|
| `setCallback`, `getState`, `getPort`, `isMonitoring` | same | verbatim |
| `initialize()` | upstream `initialize()` | verbatim; calls `service.startServer(port)` is **NOT** done here — see Section 3 |
| `startMonitoring()` | upstream | verbatim coroutine loop |
| `checkServerHealth()` | upstream | calls `service.isServerRunning(port)` — needs Section 4 visibility change from `private` → `internal` |
| `restart()` | upstream | keeps `Random.nextInt(MIN_PORT, MAX_PORT)` port reallocation on each call |
| `dispose()` | upstream | nulls callback, cancels scope |
| `getAutoRestartSetting()` | upstream `getAutoRestartSetting()` | reads upstream `OpenCodeSettings` — renamed `NeocodeSettings` |

### Adaptations (4 deltas)

1. `service` parameter type: `OpenCodeService` → `NeocodeService`.
2. `getAutoRestartSetting()` reads `NeocodeSettings` (renamed settings class).
3. `checkServerHealth()` calls `service.isServerRunning(port)` — requires Section 4.3 visibility change.
4. Lifecycle split: ViewModel no longer calls `service.startServer(port)`. The Panel (Section 3) owns that call inside `onPortReady(port)` so it can sequence `startServer → createTerminalWidget → service.registerWidget` on the Swing thread.

### Files added

- `wtf/pana/neocode/jetbrains/toolwindow/NeocodeToolWindowViewModel.kt` (~276 LOC)

---

## 3. Panel refactor (NeocodeToolWindowPanel)

Source: `opencode-jb-upstream/.../toolwindow/OpenCodeToolWindowPanel.kt` (375 LOC) → our `NeocodeToolWindowPanel.kt` (currently 303 LOC, monolithic, NO ViewModel).

### Class signature

```kotlin
class NeocodeToolWindowPanel(
    project: Project,
    service: NeocodeService
) : JPanel(BorderLayout()), Disposable, NeocodeToolWindowViewModel.ViewCallback {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val viewModel = NeocodeToolWindowViewModel(service, scope)
    private var widget: JBTerminalWidget<*>? = null

    init {
        background = UIUtil.getPanelBackground()
        viewModel.setCallback(this)
        viewModel.initialize()
    }
}
```

### Load-bearing decisions

1. **`service.startServer(port)` lives in the Panel** (not the ViewModel). The Panel's `onPortReady(port)` callback sequences `startServer(port) → createTerminalWidget(port) → service.registerWidget(widget, port)` so all three calls run on the Swing thread via `ApplicationManager.getApplication().invokeLater { ... }`.
2. **`Thread.sleep(1000L)` → `kotlinx.coroutines.delay(1000)`** in the health-monitoring loop. Upstream uses the suspending `delay`; our current code blocks `Dispatchers.IO`. **Load-bearing bug fix**: blocking the IO dispatcher freezes the panel under load.
3. **Drops the phantom `scope.launch { viewModel.checkServerHealth() }` line** that upstream's `checkIfTerminalAlive` has — dead code that fires a spurious health probe.
4. **`handleProcessExit` delegates to `viewModel.restart()`** instead of doing Panel-level auto-restart. The restart decision (port reallocation + state transition) belongs in the ViewModel.
5. **`dispose()` calls `viewModel.dispose()` then `scope.cancel()`** — the current code omits `viewModel.dispose()`, leaking the callback reference.

### File moves

- `NeocodeToolWindowPanel.kt` moves from `wtf/pana/neocode/jetbrains/` to `wtf/pana/neocode/jetbrains/toolwindow/`.

### Net

~280 LOC (down from 303) due to extracting the ViewModel body.

---

## 4. Factory port + Service adaptation

### Factory (NeocodeToolWindowFactory)

Source: `opencode-jb-upstream/.../toolwindow/OpenCodeToolWindowFactory.kt` (23 LOC).

**Decision**: keep our richer current factory (37 LOC with content-existence guard + `shouldBeAvailable` override) — it covers the multi-project case where content might already exist. One import path edit for the moved `NeocodeToolWindowPanel`.

`plugin.xml` edit (line 40-44): `factoryClass="...NeocodeToolWindowFactory"` → `factoryClass="...toolwindow.NeocodeToolWindowFactory"`.

### NeocodeService adaptations (Section 4)

Three deltas to `wtf/pana/neocode/jetbrains/service/NeocodeService.kt` (currently 215 LOC):

1. **`startServer(): Int` → `startServer(port: Int): Boolean`**

   ```kotlin
   suspend fun startServer(port: Int): Boolean = withContext(Dispatchers.IO) {
       // Kill previous PID if port changed (unique to our skid; upstream uses fixed-port lifecycle)
       if (serverPort != null && serverPort != port) {
           serverProcess?.let { p ->
               p.destroy()
               if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroyForcibly()
           }
           serverProcess = null
           serverPort = null
       }
       if (serverPort == port && serverProcess?.isAlive == true) return@withContext true
       // Start process bound to supplied port
       val pb = ProcessBuilder(neocodeCmd, "--grpc", "--port", port.toString())
           .redirectErrorStream(true)
       serverProcess = pb.start()
       serverPort = port
       Thread.sleep(500)   // brief settle; replaced by health-check polling in ViewModel
       true
   }
   ```

   Drops `findFreePort()` usage entirely (the ViewModel now allocates random ports via `MIN_PORT=16384`/`MAX_PORT=65536`). The private `findFreePort()` method is removed.

2. **`isServerRunning(port: Int)`**: visibility `private` → `internal`. Lets the ViewModel's `checkServerHealth()` call `service.isServerRunning(port)` with the exact upstream call shape.

3. **Delete dead methods**:
   - `fun initToolWindowPanel(panel: Any) { LOG.info("...") }` — dead log-only method, removed.
   - `suspend fun checkServerHealth(): Boolean` (no-arg) — dead (not called by anything; ViewModel only checks via `isServerRunning(port)`), removed.

---

## 5. SessionListDialog + SessionListViewModel port

Sources:
- `opencode-jb-upstream/.../model/SessionModels.kt` (107 LOC)
- `opencode-jb-upstream/.../ui/SessionListViewModel.kt` (213 LOC)
- `opencode-jb-upstream/.../ui/SessionListDialog.kt` (373 LOC)

### 5.1 Data models port (verbatim, package rename only)

`wtf/pana/neocode/jetbrains/model/SessionModels.kt`:

```kotlin
data class SessionInfo(
    @SerializedName("id") val id: String,
    @SerializedName("title") val title: String,
    @SerializedName("directory") val directory: String,
    @SerializedName("projectID") val projectID: String,
    @SerializedName("time") val time: TimeInfo,
    @SerializedName("share") val share: ShareInfo? = null
) {
    val isShared: Boolean get() = share != null
    val shareUrl: String? get() = share?.url
}
data class TimeInfo(
    @SerializedName("created") val created: Long,
    @SerializedName("updated") val updated: Long,
    @SerializedName("archived") val archived: Long? = null
)
data class ShareInfo(@SerializedName("url") val url: String)
data class CreateSessionRequest(@SerializedName("title") val title: String)
data class SessionResponse(
    @SerializedName("id") val id: String,
    @SerializedName("title") val title: String,
    @SerializedName("directory") val directory: String
)
```

No field changes. JSONL→SessionInfo mapping happens CLI-side (Section 7.4).

### 5.2 SessionListViewModel port

`wtf/pana/neocode/jetbrains/ui/SessionListViewModel.kt` (~213 LOC + ~6 LOC for `switchSession`).

Verbatim port: same `ViewCallback` interface (5 callbacks), same `private var sessions / selectedSession / callback`, same `scope.launch`-wrapped `loadSessions/createSession/deleteSession/shareSession/unshareSession/selectSession`, same `CoroutineScope(Dispatchers.Main)` default ctor scope.

**One delta**: `service` constructor parameter type `OpenCodeService` → `NeocodeService`. All call sites textually identical.

**One addition** (per Section 5.6 approval — OK action sends a `switchSession` RPC):

```kotlin
fun switchSession(session: SessionInfo) {
    scope.launch {
        try {
            service.switchSession(session.id)
            callback?.onSuccess("Session selected — restart Neocode with --resume ${session.id}")
        } catch (e: Exception) {
            callback?.onError(e.message ?: "Failed to switch session")
        }
    }
}
```

### 5.3 SessionListDialog port

`wtf/pana/neocode/jetbrains/ui/SessionListDialog.kt` (~373 LOC + 2 deltas).

Kept verbatim:
- `interface DialogProvider` + `DefaultDialogProvider` (testability abstraction)
- `class SessionListDialog(project, service, dialogProvider = DefaultDialogProvider()) : DialogWrapper(project), SessionListViewModel.ViewCallback`
- `DefaultListModel<SessionInfo>`, `JBList(sessionListModel)`, `rootPanel: JPanel?`
- `viewModelScope = CoroutineScope(Dispatchers.Main + SupervisorJob())`, `viewModel = SessionListViewModel(service, viewModelScope)`
- `createButtonPanel`: New Session / Delete / Share / Refresh, `BoxLayout.X_AXIS` + struts
- ViewCallback impl: `onSessionsLoaded` → `SwingUtilities.invokeLater` clear + addElements + `isOKActionEnabled = !empty`; `onError` → `dialogProvider.showErrorDialog`; `onShareUrlGenerated` → clipboard + info
- `deleteSelectedSession` (yes/no confirm), `shareSelectedSession` (option dialog Copy URL / Unshare / Cancel)
- Private `SessionCellRenderer : DefaultListCellRenderer` with `DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault())`, renders `<html><b>$title</b>$shareIcon<br><small>ID: ${id.take(12)}... | Updated: $time</small></html>`
- Constants: `DIALOG_WIDTH=600`, `DIALOG_HEIGHT=400`, `BUTTON_SPACING=5`, `ID_DISPLAY_LENGTH=12`

**Three deltas**:
1. `title = "OpenCode Sessions"` → `"Neocode Sessions"` (init block).
2. `doOKAction`: super + `viewModel.switchSession(selectedSession)` (per Section 5.6) + `viewModel.setCallback(null)` + `viewModelScope.cancel()` (per Section 8.4 — `setCallback(null)` is the +1 LOC delta).
3. `doCancelAction`: super + `viewModel.setCallback(null)` + `viewModelScope.cancel()` (Section 8.4 — `setCallback(null)` is the +1 LOC delta).

`setOKButtonText("Open Session")` stays textually (the OK action's switchSession semantic makes the label accurate).

### 5.4 NeocodeService adaptations (5 + 1 = 6 new suspend methods)

On `wtf/pana/neocode/jetbrains/service/NeocodeService.kt`, add:

```kotlin
private val mcpService = project.service<MCPService>()

suspend fun listSessions(forceRefresh: Boolean): List<SessionInfo> =
    mcpService.sendRequest("listSessions", buildJsonObject {
        put("forceRefresh", forceRefresh)
    }).asJsonArray.asSessionList()
suspend fun createSession(title: String?): String =
    mcpService.sendRequest("createSession", buildJsonObject {
        title?.let { put("title", it) }
    }).jsonObject["id"]!!.jsonPrimitive.content
suspend fun deleteSession(id: String): Boolean =
    mcpService.sendRequest("deleteSession", buildJsonObject { put("id", id) })
        .jsonObject["success"]!!.jsonPrimitive.boolean
suspend fun shareSession(id: String): String? =
    mcpService.sendRequest("shareSession", buildJsonObject { put("id", id) })
        .jsonObject["url"]?.jsonPrimitive?.contentOrNull
suspend fun unshareSession(id: String): Boolean =
    mcpService.sendRequest("unshareSession", buildJsonObject { put("id", id) })
        .jsonObject["success"]!!.jsonPrimitive.boolean
suspend fun switchSession(id: String): Boolean =
    mcpService.sendRequest("switchSession", buildJsonObject { put("id", id) })
        .jsonObject["success"]!!.jsonPrimitive.boolean
```

`mcpService.sendRequest(method, params)` is added in Section 6.4. Unpack helpers (`asSessionList`, `contentOrNull`, `boolean`) live in a new `wtf/pana/neocode/jetbrains/service/JsonExtensions.kt` (~15 LOC of Gson/kotlinx-serialization extensions).

`listSessions(forceRefresh: Boolean)` keeps upstream's exact signature so the ViewModel's `service.listSessions(forceRefresh = forceRefresh)` ports verbatim.

### 5.5 Dialog entry points (per Section 5.7 — both b + c)

Two triggers fire the same `ShowSessionsAction`:

- **Main menu**: Tools → Neocode → Sessions (uses IntelliJ action `<add-to-group group-id="ToolsMenu" .../>` nested under a Neocode group)
- **Tool window toolbar**: a button on the right-side toolbar of the Neocode tool window

`plugin.xml` additions:

```xml
<actions>
    <group id="Neocode.MainMenu" text="Neocode" popup="true">
        <add-to-group group-id="ToolsMenu" anchor="last"/>
        <action id="Neocode.ShowSessions"
                class="wtf.pana.neocode.jetbrains.ui.ShowSessionsAction"
                text="Sessions..."
                description="List, create, and manage Neocode sessions"
                icon="AllIcons.Toolwindows.ToolWindowProject"/>
    </group>
</actions>
```

The toolbar button is wired via the toolWindow's `action` child element or via `ToolWindow.titleActions` registration (verify exact pattern during implementation).

`ShowSessionsAction.kt` (~12 LOC): `AnAction` whose `actionPerformed` does:

```kotlin
override fun actionPerformed(e: AnActionEvent) {
    val project = e.project ?: return
    val service = project.service<NeocodeService>()
    SessionListDialog(project, service).show()
}
```

### 5.6 OK-action semantics (confirmed decision)

`doOKAction` sends the `switchSession` RPC. The CLI handler (Section 7.3-#6) returns `{success:true, requiresRestart:true, sessionId}` because Neocode CLI is boot-time-only `--resume` and has no in-process session swap today. The Dialog shows an info message: `"Selected — restart Neocode with --resume <id>"` via `dialogProvider.showInfoMessage`.

### 5.7 Dialog trigger (confirmed decision)

Both entry points (main menu Tools → Neocode → Sessions, and a button on the right-side toolbar of the Neocode tool window) fire the same action.

### 5.8 Session ID display

Keep upstream's truncation `id.take(12) + "..."`. Real Neocode session IDs are full UUIDs — the truncation is unchanged.

---

## 6. Bidirectional JSON-RPC delta (WSSession + MCPService)

### 6.1 The gap

Today's transport only supports:
- Outbound: fire-and-forget notifications (`MCPService.broadcastNotification`, line 169). `sendAddToContext` (line 153) uses this.
- Inbound: requests from CLI dispatched in `readLoop { onRequest }` (`MCPService.start()` line 307).

There is no path for plugin→CLI *requests with responses*. Section 5 needs it for six service methods.

### 6.2 WSSession.sendRequest (new public method)

```kotlin
private val pendingRequests = ConcurrentHashMap<String, CompletableFuture<JsonElement>>()
private val nextRequestId = AtomicLong(0)
private val writeLock = Any()

fun sendRequest(method: String, params: JsonElement, timeoutMs: Long = 10_000): CompletableFuture<JsonElement> {
    val id = nextRequestId.incrementAndGet().toString()
    val future = CompletableFuture<JsonElement>()
    pendingRequests[id] = future
    val req = buildJsonObject {
        put("jsonrpc", JsonPrimitive("2.0"))
        put("id", JsonPrimitive(id))
        put("method", JsonPrimitive(method))
        put("params", params)
    }
    val payload = json.encodeToString(JsonElement.serializer(), req)
    try {
        sendText(payload)
    } catch (t: Throwable) {
        pendingRequests.remove(id)
        future.completeExceptionally(t)
    }
    future.orTimeout(timeoutMs, TimeUnit.MILLISECONDS).handle { _, ex ->
        if (ex != null) pendingRequests.remove(id)
        null
    }
    return future
}
```

### 6.3 WSSession.readLoop distinguishes requests vs responses

Inbound messages are now either:
- **Response** (has `result` or `error` and an `id`, no `method`) → match against `pendingRequests`, complete the future.
- **Request from CLI** (has `method`, no `result`/`error`) → existing `onRequest` path, unchanged.

New `readLoop` body:

```kotlin
fun readLoop(onRequest: (JsonRpcRequest) -> JsonRpcResponse?) {
    while (!closed.get()) {
        try {
            val (opcode, payload) = readFrame()
            when (opcode) {
                OPCODE_TEXT -> {
                    val text = payload.toString(Charsets.UTF_8)
                    val element = json.parseToJsonElement(text).jsonObject
                    if ("result" in element || "error" in element) {
                        val id = element["id"]?.jsonPrimitive?.contentOrNull()
                        if (id != null) {
                            val future = pendingRequests.remove(id)
                            if (future != null) {
                                val err = element["error"]?.let {
                                    Json.decodeFromJsonElement(JsonRpcError.serializer(), it)
                                }
                                if (err != null) future.completeExceptionally(JsonRpcException(err))
                                else future.complete(element["result"] ?: JsonNull)
                            }
                        }
                        // else: stray response, ignore
                    } else if ("method" in element) {
                        val req = json.decodeFromBodyJson(JsonRpcRequest.serializer(), element)
                        val resp = onRequest(req)
                        if (resp != null) {
                            val out = json.encodeToString(JsonRpcResponse.serializer(), resp)
                            writeTextFrame(out)
                        }
                    }
                }
                OPCODE_CLOSE -> { close(); return }
                OPCODE_PING -> writeFrame(OPCODE_PONG, payload)
                OPCODE_PONG -> { /* ignore */ }
                else -> throw ProtocolException("Unsupported opcode: $opcode")
            }
        } catch (e: ClosedChannelException) { return }
        catch (e: IOException) { return }
        finally {
            // Fail all pending requests on loop exit (channel dying).
            // Idempotent guard prevents double-firing on cooperative close paths.
            if (!closed.get()) closed.set(true)
            pendingRequests.values.forEach { it.completeExceptionally(IOException("Session closed")) }
            pendingRequests.clear()
        }
    }
}
```

The `finally` block is load-bearing: without it `NeocodeService.listSessions` hangs for the full timeout after CLI disconnects.

New file `wtf/pana/neocode/jetbrains/tools/JsonRpcException.kt` (~10 LOC):

```kotlin
class JsonRpcException(val error: JsonRpcError) : Exception(error.message)
```

### 6.4 MCPService.sendRequest (new public suspend method)

```kotlin
suspend fun sendRequest(method: String, params: JsonElement): JsonElement = withContext(Dispatchers.IO) {
    val session = synchronized(openSessions) { openSessions.firstOrNull() }
        ?: throw IllegalStateException("No Neocode CLI session connected")
    try {
        session.sendRequest(method, params).await()
    } catch (e: JsonRpcException) {
        throw e   // propagate structured error to ViewModel.onError
    } catch (e: Throwable) {
        throw e
    }
}
```

`withContext(Dispatchers.IO)` because `CompletableFuture.await()` blocks. If multiple sessions exist (multi-window project), we pick the first — matches upstream HTTP client behavior. Multi-session routing is explicitly out-of-scope.

### 6.5 Write-lock scope (confirmed decision)

Wrap only `sendText` and `writeTextFrame` in `synchronized(writeLock)`. `writeFrame` stays un-synchronized because both its callers are now inside the lock. Load-bearing: without this, a CLI request arriving during a session-list fetch corrupts the WS stream via interleaved frame bytes.

```kotlin
fun sendText(text: String) = synchronized(writeLock) { writeTextFrame(text) }

private fun writeTextFrame(text: String) {
    synchronized(writeLock) {
        writeFrame(OPCODE_TEXT, text.toByteArray(Charsets.UTF_8))
    }
}
```

### 6.6 Timeouts (confirmed decisions)

- **Session-metadata RPCs** (`listSessions` / `createSession` / `deleteSession` / `shareSession` / `unshareSession` / `switchSession`): 10s default. These are pure metadata, no model touching.
- **Future RPCs touching the model layer** (queued sessions, summary generation, etc.): ≥20min minimum timeout.
- **All errors surface**: no silent swallowing. Every exception from transport reaches `ViewModel.onError(message)` → `dialogProvider.showErrorDialog`.

### 6.7 Error categories surfaced to UI

ViewModel's `callback.onError(message)` is the single fan-in point:

| Source | Failure | Surface text |
|---|---|---|
| No CLI connected | `IllegalStateException` | `"No Neocode CLI session connected"` |
| CLI timeout (10s) | `TimeoutException` | `"Request timed out after 10s: <method>"` |
| CLI exited mid-request | `IOException("Session closed")` | `"Session closed"` |
| CLI returned RPC error | `JsonRpcException` | `"[CLI <code>] <message>"` e.g. `"[CLI -32601] Session sharing not supported by this Neocode build"` |

### 6.8 What stays untouched

- `broadcastNotification` (MCPService.kt:169) — unchanged.
- `dispatch` (MCPService.kt:194) — unchanged.
- `AcceptHandler` / `handleNewConnection` (MCPService.kt:279, 301) — unchanged.

---

## 7. CLI-side session RPC handlers

### 7.1 Infrastructure already exists (findings)

- `client.setRequestHandler(Schema, async (req) => result)` is the dispatch entry — already used by `ListRootsRequestSchema` (client.ts:1032) and `ElicitRequestSchema` (client.ts:1215).
- JSON-RPC envelope is handled by the SDK: handlers return `result`, SDK wraps as `{jsonrpc:"2.0", id, result}`. Errors throw `McpError` → SDK wraps as `{error:{code,message}}`. `id` correlation is automatic.
- `listSessions` already implemented in `src/utils/listSessionsImpl.ts:439`: `listSessionsImpl(options): Promise<SessionInfo[]>` scans `~/.neocode/projects/<slug>/<uuid>.jsonl`, sorts by `lastModified` desc, returns the existing TS `SessionInfo` shape.
- No `createSession`/`deleteSession`/`shareSession`/`unshareSession`/`switchSession` in `src/utils/` today.

### 7.2 Registration wiring in client.ts

At client.ts:1232, alongside `registerAddToContextHandler`:

```ts
registerAddToContextHandler(client)
registerIDESessionHandlers(client)    // NEW — Section 7
```

### 7.3 The six handlers (new file)

`src/services/mcp/ideSessionHandlers.ts` (~250 LOC):

Each handler uses an inline zod schema (same pattern as ide.ts:914) and returns the Kotlin-side `SessionInfo` shape via `projectToRpcSessionInfo`.

#### (1) `listSessions`
```ts
client.setRequestHandler(ListSessionsSchema, async (req) => {
  const sessions = await listSessionsImpl({
    dir: req.params.directory ?? undefined,
    includeWorktrees: false,
  })
  return { sessions: sessions.map(projectToRpcSessionInfo) }
})
```

#### (2) `createSession(title)` — confirmed: writes a customTitle record line
```ts
client.setRequestHandler(CreateSessionSchema, async (req) => {
  const cwd = resolveCurrentWorkingDirectory()
  const sessionId = uuid()
  const projectSlug = slugify(cwd)
  const filePath = join(getProjectsDir(), projectSlug, `${sessionId}.jsonl`)
  await mkdir(dirname(filePath), { recursive: true })
  const now = Date.now()
  const header: SessionRecord = {
    sessionId,
    timestamp: new Date(now).toISOString(),
    cwd,
    gitBranch: await gitBranchOrNull(cwd),
    version: getCurrentVersion(),
  }
  await writeFile(filePath, JSON.stringify(header) + '\n')
  // Section 7.6.1.b (confirmed): persist user-provided title as a customTitle record
  if (req.params.title && req.params.title.trim().length > 0) {
    const titleRecord = {
      type: 'customTitle',
      sessionId,
      timestamp: new Date(now + 1).toISOString(),
      value: req.params.title,
    }
    await appendFile(filePath, JSON.stringify(titleRecord) + '\n')
  }
  return { id: sessionId, title: req.params.title ?? 'Untitled', directory: cwd }
})
```

The exact JSONL record schema for `customTitle` is verified against the real format during the implementation plan / Section 9 smoke test. If Neocode's existing session reader doesn't recognize `{type:"customTitle", value:...}` records, the implementation plan must introduce a compatible record shape (or extend the reader).

#### (3) `deleteSession(id)` — confirmed: recycle-bin move
```ts
client.setRequestHandler(DeleteSessionSchema, async (req) => {
  const filePath = await findSessionFileById(req.params.id)
  if (!filePath) throw new McpError(ErrorCode.InvalidParams, `Session not found: ${req.params.id}`)
  try {
    await trash(filePath)   // sends to OS recycle bin (cross-platform via `trash` npm pkg)
  } catch (e) {
    // Fallback: rename to .deleted if trash unavailable
    await rename(filePath, `${filePath}.deleted`)
  }
  return { success: true }
})
```

`trash` is the cross-platform npm package (sends to OS recycle bin on Windows via SHFileOperation, on macOS via NSWorkspace, on Linux via free-desktop trash spec). Add to `package.json` deps.

#### (4) `shareSession(id)` / (5) `unshareSession(id)` — confirmed: hand-crafted -32601

Neocode CLI has no shared-session backend today. Handlers exist for API symmetry with the Kotlin port (keeps the ViewModel code verbatim):

```ts
client.setRequestHandler(ShareSessionSchema, async () => {
  throw new McpError(-32601, 'Session sharing not supported by this Neocode build')
})
// unshareSession: same -32601
```

Errors flow through `ViewModel.onError` → `dialogProvider.showErrorDialog`, displaying the canonical message.

#### (6) `switchSession(id)` — confirmed: success-with-caveat

Neocode CLI is boot-time-only `--resume`; no in-process session swap API. Handler returns:

```ts
client.setRequestHandler(SwitchSessionSchema, async (req) => {
  const exists = await findSessionFileById(req.params.id)
  if (!exists) throw new McpError(ErrorCode.InvalidParams, `Session not found: ${req.params.id}`)
  return { success: true, requiresRestart: true, sessionId: req.params.id }
})
```

The Dialog's `onSuccess` path shows `"Selected — restart Neocode with --resume <id>"` via `dialogProvider.showInfoMessage`. Not an error path.

### 7.4 Shape projection mapper

TS `SessionInfo` → Kotlin `SessionInfo`:

```ts
function projectToRpcSessionInfo(s: SessionInfo): RpcSessionInfo {
  return {
    id: s.sessionId,
    title: s.customTitle ?? s.firstPrompt ?? s.summary ?? 'Untitled session',
    directory: s.cwd ?? '',
    projectID: slugify(s.cwd ?? ''),
    time: {
      created: s.createdAt ?? s.lastModified,
      updated: s.lastModified,
      archived: null,
    },
    share: null,
  }
}
```

Single translation point. `share: ShareInfo? = null` forever today.

### 7.5 Open items deferred to implementation plan

1. **JSONL customTitle record schema**: Neocode's existing session reader needs to recognize the new `{type:"customTitle", value:...}` record. If the reader doesn't today, the implementation plan must (a) introduce the record shape and (b) extend the reader (`sessionStoragePortable.ts` or `sessionStorage.ts`) to expose `customTitle` from such records. **Implementation plan gates Section 7-1 #1 on this verification**.
2. **`findSessionFileById`**: implementation uses a `readdir` scan of all `~/.neocode/projects/*/<id>.jsonl` (lift the helper from `listSessionsImpl.gatherAllCandidates`).
3. **`gitBranchOrNull`, `getCurrentVersion`, `resolveCurrentWorkingDirectory`, `slugify`**: reuse existing helpers where available; verify paths during implementation.

---

## 8. Error handling

### 8.1 Three zones

The end-to-end flow has three zones with distinct failure modes. **All errors surface** (per user instruction Section 6.6). `ViewModel.callback.onError(message)` is the single fan-in → `dialogProvider.showErrorDialog`.

### 8.2 Zone A — Plugin-side transport (Section 6)

| Source | Exception | Surface |
|---|---|---|
| No CLI connected when dialog opens | `IllegalStateException("No Neocode CLI session connected")` | `MCPService.sendRequest` throws → ViewModel.onError |
| CLI timeout (10s metadata RPCs) | `TimeoutException` (CompletableFuture.orTimeout) | `"Request timed out after 10s: <method>"` |
| CLI exited mid-request | `IOException("Session closed")` (set by readLoop finally block) | `"Session closed"` |
| CLI returned RPC error | `JsonRpcException(error: JsonRpcError)` | `"[CLI <code>] <message>"` |

Prevention (Section 6.5): `writeLock` serialization, `readLoop` finally-block exception drain, `orTimeout(10_000)` per session-metadata RPC.

### 8.3 Zone B — CLI-side handler failures (Section 7)

- **Schema/payload failure**: zod validates inbound params; invalid → SDK auto-rejects with `-32602 InvalidParams`.
- **Filesystem failure** (createSession/deleteSession): `McpError(-32601, message)` with OS errno text.
- **`trash()` unavailable** (deleteSession): try/catch around `trash(filePath)` catches `trash` pkg missing → falls back to rename `${filePath}.deleted`. If rename also fails, throws `McpError`. Never silently returns success.
- **Deliberate -32601** for unsupported features: hand-crafted `McpError(-32601, 'Session sharing not supported by this Neocode build')`. Maps to honest UI error, not silent no-op.
- **`switchSession` success-with-caveat**: NOT an error path. Returns `{success:true, requiresRestart:true}` → Dialog info message.

### 8.4 Zone C — UI-level race conditions (Dialog)

- **Dialog disposed before async result lands**: `SwingUtilities.invokeLater { if (Disposer.isDisposed(this)) return@invokeLater; ... }` — matches `NeocodeToolWindowPanel.onPortReady` pattern (Section 3).
- **`viewModelScope` cancelled on dialog close**: explicit `viewModelScope.cancel()` in doOKAction and doCancelAction.
- **Network response arrives after doCancelAction**: **Mild delta on verbatim port** — add `viewModel.setCallback(null)` in both `doOKAction` and `doCancelAction` before `viewModelScope.cancel()` (+2 LOC total). Confirmed decision: add. Matches Panel dispose pattern from Section 3.

### 8.5 Logging discipline

Every exception logged:
- Plugin side: `logger<NeocodeService>().warn("listSessions RPC failed: $id", e)`.
- CLI side: `logError` (same pattern as `[ide] addToContext notification missing/invalid params, dropping`).

User sees one dialog; developer sees a stack trace in the IDE's `neocode.log`.

### 8.6 Explicitly out of scope

- **Retry-with-backoff**: upstream port has none. User refreshes manually.
- **Connection re-establishment**: user restarts Neocode + reopens dialog.
- **Multiple concurrent SessionListDialogs**: not prevented. Upstream behavior preserved.

---

## 9. Testing

### 9.1 Surface A — Kotlin unit: WSSession round-trip

`jetbrains-extension/src/test/kotlin/.../services/WSSessionTest.kt` (~150 LOC):

- `test sendRequest receives matching response`: paired `AsynchronousSocketChannel` pipes; one side calls `session.sendRequest("ping", JsonNull)`; other side reads the request frame, writes `{jsonrpc:"2.0", id:<same id>, result:{}}`. Assert `CompletableFuture` completes within 200ms with `result == {}`.
- `test response without matching id is ignored`: stray response id → no callback fires, `readLoop` continues.
- `test request handler invoked sequentially with method+params`: `onRequest` gets method+params verbatim, returns a `JsonRpcResponse`, wire bytes are `{jsonrpc:"2.0", id:<same id>, result:...}`.
- `test session close fails pending requests`: `session.sendRequest(...)` then `channel.close()`. Assert `CompletableFuture` completes with `IOException("Session closed")`. **Critical: regression test for Section 6.3 finally block**.
- `test ortimeout fires after 50ms`: invoke with `timeoutMs = 50`, never respond, assert `TimeoutException` after ~50ms.
- `test concurrent sendRequest + inbound response never corrupts frames`: 50 concurrent `sendRequest`s, peer echoes each response. Assert every future completes with matching result, no IOExceptions. **Write-lock fix regression test**.

No mocking needed — `AsynchronousSocketChannel.open()` paired pipes work on the JVM.

### 9.2 Surface B — Kotlin unit: SessionListViewModel + Dialog with mock provider

`jetbrains-extension/src/test/kotlin/.../ui/SessionListViewModelTest.kt` (~120 LOC):
- Fake `NeocodeService` subclass with canned `listSessions`/`createSession` results (via `Dispatchers.Unconfined` for synchronous test perf).
- `loadSessions happy path`: `onSessionsLoaded` fires with the canned list, `onSessionSelected(null)`.
- `loadSessions error path`: fake service throws → `onError(message)`.
- `deleteSession success → loadSessions refresh`: delete RPC called, then list-refresh RPC called in order.
- `selectSession / getSelectedSession round-trip`: trivial, catches state leakage.
- `switchSession success → onSuccess with requiresRestart payload`.

`jetbrains-extension/src/test/kotlin/.../ui/SessionListDialogTest.kt` (~80 LOC):
- `RecordingDialogProvider` capturing all `showInfoMessage`/`showErrorDialog`/`showYesNoDialog`/`showInputDialog` calls.
- `deleteSelectedSession yes/no`: "No" → no delete RPC; "Yes" → delete RPC fires.
- `shareSelectedSession already-shared shows option dialog`: `share != null` → `showOptionDialog(["Copy URL", "Unshare", "Cancel"])`.
- `doOKAction nulls callback then cancels scope`: log/reflection spy asserting the +2 LOC Section 8.4 delta.

### 9.3 Surface C — Bun test: CLI-side handler sanity

`src/services/mcp/ideSessionHandlers.test.ts` (~200 LOC):

- `projectToRpcSessionInfo maps all fields`: stub TS `SessionInfo` → Kotlin-shape output with `id/title/directory/projectID/time{created,updated,archived:null}/share:null`.
- `listSessions handler returns sorted list`: `bun:test` mock of `listSessionsImpl` → handler calls with `includeWorktrees:false`, returns mapped list.
- `listSessions handler with directory param passes it through`: `params.directory:"/foo"` → `listSessionsImpl({dir:"/foo", includeWorktrees:false})`.
- `createSession writes a header + customTitle record`: in-memory `tmpdir()` shadow of `getProjectsDir()`, mock `getClaudeConfigHomeDir`. Fire handler → read `.jsonl` → first record is `SessionRecord` header, second line is `{type:"customTitle", value:"<title>"}`.
- `createSession no-title → header only`: title `null` → only the header, no second line.
- `deleteSession moves file to recycle bin (`.deleted` fallback)`: monkey-patch `trash()` to throw → assert fallback renames `${id}.jsonl` → `${id}.jsonl.deleted`. Then assert trash-available path actually calls `trash(filePath)`.
- `deleteSession unknown id → error`: `McpError(InvalidParams)` with `"Session not found"`.
- `shareSession returns -32601 unsupported`: `McpError(-32601)` with canonical message.
- `switchSession returns success+requiresRestart:true`: known id → handler succeeds, returns structured payload (no disk mutations).
- `switchSession unknown id → error`.

Mock pattern: `import { mock, spyOn } from 'bun:test'`. `spyOn(ideSessionHandlers, 'listSessionsImpl').mockResolvedValue([...])`.

Bun test command follows the `./` path-prefix convention (per team memory): `bun test ./src/services/mcp/ideSessionHandlers.test.ts`.

### 9.4 Surface D — Manual smoke (IDE runIde): end-to-end verification checklist

Hard part is the IDE ↔ CLI round-trip. Unit tests above cover each side separately. The "do they actually speak to each other" check is a manual `:runIde` smoke (user runs and verifies). The implementation plan treats this checklist as a verification gate.

**Steps**:

1. Run `:runIde`. Neocode CLI launches via panel. Wait for tool window to show running terminal.
2. **Main menu**: Tools → Neocode → Sessions. Dialog opens.
3. Dialog should be populated from real `~/.neocode/projects/<project-slug>/*.jsonl`. Verify each session has `id (truncated), title, updated time` and a `🔗` icon on shared sessions (none today, since share is unsupported).
4. **Toolbar button** on the right side of the Neocode tool window: click it → same dialog opens. Verify same content.
5. **New Session**: click button → enter title `"My Test Session"` → new entry appears after Refresh/automatic reload. Verify on disk: `ls ~/.neocode/projects/<slug>/*.jsonl` shows a new file; `cat` it → first line is `SessionRecord` header, second line is `{type:"customTitle", value:"My Test Session"}`.
6. **Delete**: select the session just created → press **Delete** → confirm "Yes" in the dialog. Verify on disk: file is gone (recycle bin) or `.deleted` extension present.
7. **Share** button: select any session → press **Share** → error dialog: `"Session sharing not supported by this Neocode build"`.
8. **OK action / switchSession**: select any session → press **Open Session**. Info dialog: `"Selected — restart Neocode with --resume <short-id>"`.
9. **CLI disconnect mid-list**: open dialog, then kill the running Neocode CLI terminal. Dialog shows `"Session closed"` error within ~10s.
10. **Dialog before CLI connected**: kill Neocode, then immediately open Sessions dialog → `"No Neocode CLI session connected"` error.

### 9.5 Explicitly out of scope

- `MCPService.sendRequest` itself in isolation: tested transitively via Dialog tests + WSSession tests.
- JetBrains `Messages` dialog rendering: DialogProvider abstraction covers this; tests cover the adapter, not JetBrains UI rendering.
- Concurrent multi-session routing: explicitly out-of-scope (Section 6.4 first-session).
- Bun runtime loading the new test file: covered by existing `bun test` harness.

### 9.6 Test files summary

| Path | LOC est | Layer |
|---|---|---|
| `jetbrains-extension/src/test/kotlin/.../services/WSSessionTest.kt` | ~150 | A |
| `jetbrains-extension/src/test/kotlin/.../ui/SessionListViewModelTest.kt` | ~120 | B |
| `jetbrains-extension/src/test/kotlin/.../ui/SessionListDialogTest.kt` | ~80 | B |
| `src/services/mcp/ideSessionHandlers.test.ts` | ~200 | C |

Total ~550 LOC of tests across Kotlin + Bun.

---

## Appendix A — Confirmed decisions log

| Section | Decision |
|---|---|
| 1 | Scope = "Tool window + ViewModel only" + `SessionListDialog`/`SessionListViewModel` |
| 1 | Session API = "Build real session API too" |
| 1 | Approach = "MCP (Recommended)" — bidirectional JSON-RPC over existing WS transport |
| 2 | 4 adaptation deltas on the ViewModel port (settings name, lifecycle split, visibility reach-through, port reallocation) |
| 3 | Three load-bearing changes: `Thread.sleep` → `delay`; `service.startServer(port)` lives in Panel; `dispose()` calls `viewModel.dispose()` |
| 4 | Keep our richer ToolWindowFactory (vs upstream one-liner); 3 NeocodeService deltas |
| 5.6 | OK action sends `switchSession` RPC |
| 5.7 | Both entry points (Tools menu + tool window right toolbar) |
| 6.5 | Write-lock wraps `sendText`/`writeTextFrame` only |
| 6.6 | 10s for metadata RPCs; ≥20min for any future model-touching RPC; ALL errors surface |
| 7.3 #2 | `createSession` writes a customTitle record line (preserve upstream parity) |
| 7.3 #3 | `deleteSession` uses recycle-bin move (via `trash` npm pkg, `.deleted` fallback) |
| 8.4 | Add `setCallback(null)` in `doOKAction`/`doCancelAction` (+2 LOC) |
| 9.4 | Explicit smoke checklist in the spec as a verification gate |

## Appendix B — Open implementation questions (for the writing-plans phase)

1. **JSONL customTitle record schema**: how does Neocode's existing session reader recognize the new `{type:"customTitle", value:...}` record? Implementation plan must (a) verify the existing reader's record types in `src/utils/sessionStoragePortable.ts` and (b) either align the record shape to an existing recognized type or extend the reader.
2. **Tool window right-toolbar button registration**: exact `plugin.xml` pattern for adding a button to the right-side toolbar of a `ToolWindowFactory`-registered tool window (vs `titleActions`).
3. **`gitBranchOrNull` / `getCurrentVersion` / `slugify`**: identify existing helpers in `src/utils/` to reuse vs write fresh.
