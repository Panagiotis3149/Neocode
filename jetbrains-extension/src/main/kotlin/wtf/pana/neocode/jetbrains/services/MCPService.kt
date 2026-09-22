package wtf.pana.neocode.jetbrains.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import java.net.InetSocketAddress
import java.nio.channels.AsynchronousServerSocketChannel
import java.nio.channels.AsynchronousSocketChannel
import java.nio.channels.CompletionHandler
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import wtf.pana.neocode.jetbrains.tools.CallToolResult
import wtf.pana.neocode.jetbrains.tools.InitializeResult
import wtf.pana.neocode.jetbrains.tools.JsonRpcError
import wtf.pana.neocode.jetbrains.tools.JsonRpcRequest
import wtf.pana.neocode.jetbrains.tools.JsonRpcResponse
import wtf.pana.neocode.jetbrains.tools.MCP_PROTOCOL_VERSION
import wtf.pana.neocode.jetbrains.tools.ServerCapabilities
import wtf.pana.neocode.jetbrains.tools.ServerInfo
import wtf.pana.neocode.jetbrains.tools.TextContent
import wtf.pana.neocode.jetbrains.tools.ToolDef

/**
 * MCP WebSocket server lifecycle.
 *
 * Runs an embedded MCP server inside the IDE; the Neocode CLI connects as
 * the MCP client. Exposes:
 *   - tool registration (openDiff, close_tab, openFile, getDiagnostics, ...)
 *   - notification pipelining (mcp__ide__addToContext, ide_connected)
 *   - lifecycle (start on PostStartupActivity, stop on plugin unload)
 *
 * Lockfile: written to `~/.claude/ide/{port}.lock` by [ServerPortUtil] once
 * the server is up. Neocode detects connected IDEs by scanning that directory.
 *
 * Architecture: hand-rolled WS server per design spec §2. Uses java.nio
 * `AsynchronousServerSocketChannel` for the listen socket and a minimal
 * RFC 6455 frame parser for client->server messages. JSON-RPC dispatch is a
 * flat dispatcher (`dispatch()`) -- Option A from the design spec §3.
 */
class MCPService {
    private val log = logger<MCPService>()
    private val json = Json { ignoreUnknownKeys = true; classDiscriminator = "type" }

    val isConnected: Boolean
        get() = _isConnected.get()
    private val _isConnected = AtomicBoolean(false)

    /** Active port the WS server is bound to, or 0 if not started. */
    var port: Int = 0
        private set

    /** Bearer token clients must send in `X-Claude-Code-Ide-Authorization`. */
    var authToken: String = ""
        private set

    private val toolRegistry: ConcurrentHashMap<String, ToolDef> = ConcurrentHashMap()
    private val openSessions: MutableSet<WSSession> = Collections.synchronizedSet(java.util.LinkedHashSet())

    private var listener: AsynchronousServerSocketChannel? = null
    private val wsExecutor = Executors.newCachedThreadPool { r ->
        Thread(r, "neocode-mcp-ws").apply { isDaemon = true }
    }
    private val running = AtomicBoolean(false)

    /**
     * Bind the MCP server to a free port and start listening.
     * Called from [wtf.pana.neocode.jetbrains.startup.PostStartupActivity].
     */
    fun start() {
        if (!running.compareAndSet(false, true)) {
            log.warn("MCPService.start() called but already running")
            return
        }
        try {
            port = ServerPortUtil.findFreePort()
            authToken = ServerPortUtil.generateAuthToken()

            val serverChannel = AsynchronousServerSocketChannel.open()
            serverChannel.bind(InetSocketAddress("127.0.0.1", port))
            listener = serverChannel

            ServerPortUtil.writeLockfile(
                port = port,
                ideName = ideName(),
                pid = ProcessHandle.current().pid(),
                workspaceFolders = emptyList(),
                authToken = authToken,
            )

            serverChannel.accept<Any?>(null, AcceptHandler(serverChannel))
            log.info("Neocode MCP server listening on ws://127.0.0.1:$port")
        } catch (t: Throwable) {
            log.error("Failed to start Neocode MCP server", t)
            running.set(false)
            throw t
        }
    }

    /**
     * Stop the server, close all sessions, and delete the lockfile.
     */
    fun stop() {
        if (!running.compareAndSet(true, false)) return
        try {
            listener?.close()
            listener = null
            synchronized(openSessions) {
                openSessions.toList().forEach { it.close() }
                openSessions.clear()
            }
            wsExecutor.shutdownNow()
            if (port > 0) {
                ServerPortUtil.deleteLockfile(port)
            }
            _isConnected.set(false)
            log.info("Neocode MCP server stopped")
        } catch (t: Throwable) {
            log.warn("Error during MCPService.stop()", t)
        }
    }

    fun addTool(def: ToolDef) {
        toolRegistry[def.name] = def
        log.info("Registered MCP tool: ${def.name}")
    }

    fun removeTool(name: String) {
        toolRegistry.remove(name)
    }

    fun registeredToolNames(): Set<String> = toolRegistry.keys.toSet()

    /**
     * Send the `mcp__ide__addToContext` notification (server -> client) to every
     * connected WS session. Neocode-side listens via `setNotificationHandler` and
     * injects the payload into the active conversation context.
     *
     * Payload: `{ text: string, filePath?: string, language?: string }`.
     *
     * No-op when there are no open sessions (Neocode isn't connected, lockfile
     * may have been written but the CLI hasn't dialed in yet).
     */
    fun sendAddToContext(text: String, filePath: String?, language: String?) {
        val maxContextChars = System.getProperty("neocode.maxContextChars")?.toIntOrNull()
            ?: DEFAULT_MAX_CONTEXT_CHARS
        val params = buildJsonObject {
            put("text", JsonPrimitive(text))
            filePath?.let { put("filePath", JsonPrimitive(it)) }
            language?.let { put("language", JsonPrimitive(it)) }
            put("fits", JsonPrimitive(text.length <= maxContextChars))
        }
        broadcastNotification(method = "mcp__ide__addToContext", params = params)
    }

    /**
     * Send a JSON-RPC notification (no `id`, no response expected) to every open
     * session. Server-side notifications from this plugin to the Neocode CLI.
     */
    private fun broadcastNotification(method: String, params: JsonElement) {
        val message = buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("method", JsonPrimitive(method))
            put("params", params)
        }
        val payload = json.encodeToString(JsonElement.serializer(), message)
        val sessions: List<WSSession> = synchronized(openSessions) { openSessions.toList() }
        if (sessions.isEmpty()) {
            log.info("broadcastNotification($method) dropped: no connected Neocode sessions")
            return
        }
        for (session in sessions) {
            try {
                session.sendText(payload)
            } catch (t: Throwable) {
                log.warn("Failed to send notification $method to session", t)
            }
        }
    }

    /**
     * Dispatch a JSON-RPC request to the right handler. Returns null for
     * notifications (caller should not write a response in that case).
     */
    fun dispatch(request: JsonRpcRequest): JsonRpcResponse? {
        return when (request.method) {
            "initialize" -> handleInitialize(request)
            "notifications/initialized" -> null
            "tools/list" -> handleToolsList(request)
            "tools/call" -> handleToolsCall(request)
            "ping" -> JsonRpcResponse(id = request.id, result = buildJsonObject {})
            "notifications/ide_connected" -> {
                log.info("Neocode connected (params: ${request.params})")
                null
            }
            else -> JsonRpcResponse(
                id = request.id,
                error = JsonRpcError(JsonRpcError.METHOD_NOT_FOUND, "Method not found: ${request.method}"),
            )
        }
    }

    private fun handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
        val result = InitializeResult(
            protocolVersion = MCP_PROTOCOL_VERSION,
            capabilities = ServerCapabilities(),
            serverInfo = ServerInfo(),
        )
        return JsonRpcResponse(
            id = request.id,
            result = json.encodeToJsonElement(InitializeResult.serializer(), result),
        )
    }

    private fun handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
        val toolsArray = JsonArray(toolRegistry.values.map { def ->
            buildJsonObject {
                put("name", JsonPrimitive(def.name))
                put("description", JsonPrimitive(def.description))
                put("inputSchema", Json.parseToJsonElement(def.inputSchema))
            }
        })
        val result = buildJsonObject { put("tools", toolsArray) }
        return JsonRpcResponse(id = request.id, result = result)
    }

    private fun handleToolsCall(request: JsonRpcRequest): JsonRpcResponse {
        val params = request.params?.jsonObject
            ?: return errorResponse(request.id, JsonRpcError.INVALID_PARAMS, "Missing params")
        val name = params["name"]?.let { (it as? JsonPrimitive)?.content }
            ?: return errorResponse(request.id, JsonRpcError.INVALID_PARAMS, "Missing tool name")
        val args = params["arguments"]
        val def = toolRegistry[name]
            ?: return errorResponse(request.id, JsonRpcError.METHOD_NOT_FOUND, "Unknown tool: $name")

        val result = try {
            def.handler(args)
        } catch (t: Throwable) {
            log.error("Tool handler error: $name", t)
            CallToolResult(
                content = listOf(TextContent(text = "Internal error: ${t.message}")),
                isError = true,
            )
        }
        val resultJson = json.encodeToJsonElement(CallToolResult.serializer(), result)
        return JsonRpcResponse(id = request.id, result = resultJson)
    }

    private fun errorResponse(id: JsonElement?, code: Int, message: String): JsonRpcResponse {
        return JsonRpcResponse(id = id, error = JsonRpcError(code, message))
    }

    private val authRand = java.security.SecureRandom()
    private fun newAuthToken(): String {
        val bytes = ByteArray(32)
        authRand.nextBytes(bytes)
        return bytes.joinToString(separator = "") { "%02x".format(it) }
    }

    private fun ideName(): String {
        val app = com.intellij.openapi.application.ApplicationInfo.getInstance()
        // ApplicationInfo in 2024.2 exposes fullApplicationName + versionName;
        // productName was removed. Map fullApplicationName → snake-case ideName.
        val fullName = app.fullApplicationName.ifBlank { "intellij" }
        // e.g. "IntelliJ IDEA 2024.2.3" → "intellijidea", "PyCharm 2024.2.3" → "pycharm"
        val withoutVersion = fullName.replace(Regex("\\s+\\d.*$"), "").trim()
        return withoutVersion.lowercase().replace(" ", "")
    }

    private inner class AcceptHandler(
        private val serverChannel: AsynchronousServerSocketChannel,
    ) : CompletionHandler<AsynchronousSocketChannel, Any?> {
        override fun completed(client: AsynchronousSocketChannel, attachment: Any?) {
            if (!running.get()) {
                runCatching { client.close() }
                return
            }
            try {
                serverChannel.accept<Any?>(null, this)
            } catch (t: Throwable) {
                log.warn("Accept loop ended", t)
                return
            }
            wsExecutor.submit { handleNewConnection(client) }
        }

        override fun failed(exc: Throwable, attachment: Any?) {
            log.warn("Accept failed", exc)
        }
    }

    private fun handleNewConnection(client: AsynchronousSocketChannel) {
        val session = WSSession(client)
        try {
            session.performHandshake()
            synchronized(openSessions) { openSessions.add(session) }
            _isConnected.set(true)
            session.readLoop(
                onRequest = { req -> dispatch(req) },
                onResponse = { /* server side does not issue sendRequest; outbound responses are written via onRequest's return */ },
            )
        } catch (t: Throwable) {
            log.info("Connection closed during handshake: ${t.message}")
            session.close()
        } finally {
            synchronized(openSessions) { openSessions.remove(session) }
            if (openSessions.isEmpty()) _isConnected.set(false)
        }
    }

    // ------------------------------------------------------------------
    // Outbound JSON-RPC (IDE → CLI). Used by session CRUD actions to call
    // Neocode-side handlers (listSessions, createSession, deleteSession,
    // ...). Picks any open session, sends a JSON-RPC request frame with a
    // fresh UUID id, and awaits the matching response. Throws
    // [IllegalStateException] if no session is connected.
    // ------------------------------------------------------------------

    /**
     * Send a JSON-RPC request to the connected Neocode CLI and await the
     * matching response. Returns the `result` element on success; throws
     * [McpRemoteException] when the CLI responds with an `error` payload.
     */
    fun sendRequest(
        method: String,
        params: JsonObject,
        timeoutMs: Long = 20_000L,
    ): JsonObject {
        val session = pickSession()
            ?: throw IllegalStateException("No Neocode CLI session is connected")
        val resp: JsonRpcResponse = session.sendRequest(method, params, timeoutMs)
        resp.error?.let { err ->
            throw McpRemoteException(err.code, err.message)
        }
        return (resp.result as? JsonObject)
            ?: JsonObject(emptyMap())
    }

    /** Pick any connected session (prefer the most recently added). */
    private fun pickSession(): WSSession? =
        synchronized(openSessions) {
            openSessions.maxByOrNull { System.identityHashCode(it) }
        }

    /** Test-only hook: inject a pre-handshaked session into [openSessions]. */
    internal fun injectSessionForTest(session: WSSession) {
        synchronized(openSessions) { openSessions.add(session) }
        _isConnected.set(true)
    }

    companion object {
        /** Default context-window character budget used when computing the `fits` hint. */
        const val DEFAULT_MAX_CONTEXT_CHARS = 200_000

        @JvmStatic
        fun getInstance(): MCPService =
            ApplicationManager.getApplication().getService(MCPService::class.java)
    }
}

/**
 * Thrown by [MCPService.sendRequest] when the Neocode CLI responds with a
 * JSON-RPC `error` payload. Carries the remote `code` + `message` so action
 * handlers can surface them in the UI.
 */
class McpRemoteException(val code: Int, override val message: String) : RuntimeException(message)
