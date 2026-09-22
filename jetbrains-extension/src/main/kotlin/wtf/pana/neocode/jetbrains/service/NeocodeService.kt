package wtf.pana.neocode.jetbrains.service

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.terminal.JBTerminalWidget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.put

private val LOG = logger<NeocodeService>()

/**
 * Project-level service bridging the IntelliJ plugin and the running Neocode
 * CLI session.
 *
 * Neocode is launched by the user (typically inside the tool window's own
 * terminal widget — see [NeocodeToolWindowPanel]) with the standard
 * interactive CLI. Bidirectional MCP-over-WebSocket RPC is then established
 * by the IDE-side [wtf.pana.neocode.jetbrains.services.MCPService] using the
 * `ws-ide` transport; no separate gRPC/HTTP server is spawned by this service.
 *
 * The methods on this class are thin Kotlin wrappers over
 * [wtf.pana.neocode.jetbrains.services.MCPService.sendRequest] for the
 * session-management RPCs whose handlers live on the CLI side at
 * `src/commands/ideSessionHandlers.ts`.
 *
 * @property project The IntelliJ project this service is associated with
 */
@Service(Service.Level.PROJECT)
class NeocodeService(
    private val project: Project
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Cross-service handle to the MCP websocket service. Provides RPC access
     * to the running Neocode CLI session (used by session-management methods
     * and the tool window ViewModel). Lazily resolved from the application
     * container so callers may invoke before MCP has accepted a connection.
     */
    val mcpService: wtf.pana.neocode.jetbrains.services.MCPService
        get() = ApplicationManager.getApplication()
            .getService(wtf.pana.neocode.jetbrains.services.MCPService::class.java)

    private var registeredWidget: JBTerminalWidget? = null

    /**
     * Initialize the tool window panel reference.
     * Called from NeocodeToolWindowPanel constructor.
     */
    fun initToolWindowPanel(panel: Any) {
        LOG.info("NeocodeService initialized with tool window panel")
    }

    /**
     * Register a terminal widget with the service for lifecycle management.
     */
    fun registerWidget(widget: JBTerminalWidget) {
        registeredWidget = widget
        LOG.info("Registered terminal widget")
    }

    /**
     * Unregister a terminal widget.
     */
    fun unregisterWidget(widget: JBTerminalWidget) {
        if (registeredWidget == widget) {
            registeredWidget = null
            LOG.info("Unregistered terminal widget")
        }
    }

    /**
     * Get the currently registered widget.
     */
    fun getRegisteredWidget(): JBTerminalWidget? = registeredWidget

    /**
     * Dispose of resources when service is shut down.
     */
    fun dispose() {
        LOG.info("Disposing NeocodeService")
        scope.cancel()
    }

    // ------------------------------------------------------------------
    // Session RPC: thin Kotlin wrappers over MCPService.sendRequest that
    // build the JSON-RPC params and decode the result into the typed
    // wrapper from wtf.pana.neocode.jetbrains.model. Handlers live on the
    // CLI side (src/commands/ideSessionHandlers.ts).
    // ------------------------------------------------------------------

    /**
     * List sessions for the current project directory. The CLI filters
     * `~/.neocode/projects/<slug>/<uuid>.jsonl` to those matching the
     * provided cwd (defaulting to the current project base path).
     */
    suspend fun listSessions(
        cwd: String = project.basePath ?: System.getProperty("user.home"),
        limit: Int = 100,
    ): wtf.pana.neocode.jetbrains.model.ListSessionsResult {
        val params = kotlinx.serialization.json.buildJsonObject {
            put("cwd", cwd)
            put("limit", limit)
        }
        val result = mcpService.sendRequest("listSessions", params)
        return wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
    }

    /** Create a fresh session and return its id. */
    suspend fun createSession(cwd: String? = null): String {
        val params = kotlinx.serialization.json.buildJsonObject {
            cwd?.let { put("cwd", it) }
        }
        val result = mcpService.sendRequest("createSession", params)
        val r: wtf.pana.neocode.jetbrains.model.CreateSessionResult =
            wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
        return r.sessionId
    }

    /**
     * Tell the CLI to focus the given session. If the session isn't already
     * loaded by a running process, the handler spawns a new one.
     */
    suspend fun switchSession(sessionId: String): wtf.pana.neocode.jetbrains.model.SwitchSessionResult {
        val params = kotlinx.serialization.json.buildJsonObject {
            put("sessionId", sessionId)
        }
        val result = mcpService.sendRequest("switchSession", params)
        return wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
    }

    /**
     * Soft-delete: move a session JSONL to the user's recycle bin. Returns
     * [ok=false] if the file wasn't found.
     */
    suspend fun deleteSession(sessionId: String): wtf.pana.neocode.jetbrains.model.DeleteSessionResult {
        val params = kotlinx.serialization.json.buildJsonObject {
            put("sessionId", sessionId)
        }
        val result = mcpService.sendRequest("deleteSession", params)
        return wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
    }

    /** Generate a public share URL for the session. */
    suspend fun shareSession(sessionId: String): wtf.pana.neocode.jetbrains.model.ShareSessionResult {
        val params = kotlinx.serialization.json.buildJsonObject {
            put("sessionId", sessionId)
        }
        val result = mcpService.sendRequest("shareSession", params)
        return wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
    }

    /** Revoke a previously generated share URL. */
    suspend fun unshareSession(sessionId: String): wtf.pana.neocode.jetbrains.model.UnshareSessionResult {
        val params = kotlinx.serialization.json.buildJsonObject {
            put("sessionId", sessionId)
        }
        val result = mcpService.sendRequest("unshareSession", params)
        return wtf.pana.neocode.jetbrains.util.JsonExtensions.decode(result)
    }
}