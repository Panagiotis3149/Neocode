package wtf.pana.neocode.jetbrains.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import wtf.pana.neocode.jetbrains.services.MCPService
import wtf.pana.neocode.jetbrains.services.McpRemoteException

/**
 * MVVM ViewModel for the Neocode tool window.
 *
 * Owns UI state (connection status, current session, error message) and the
 * coroutine scope driving periodic health checks + reconnect attempts. The
 * Panel observes [uiState] and re-renders on every emit; all mutations happen
 * on [scope]'s IO dispatcher.
 *
 * Architecture: the ViewModel deliberately exposes a small sealed [UiState]
 * surface so the Panel can stay declarative — no business logic leaks into the
 * Swing layer. Mirrors opencode-jb's OpenCodeToolWindowViewModel.
 *
 * @property project The IntelliJ project hosting this VM.
 */
@Service(Service.Level.PROJECT)
class NeocodeToolWindowViewModel(private val project: Project) {

    private val log = logger<NeocodeToolWindowViewModel>()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    sealed class UiState {
        /** No CLI connected yet; polling for connection. */
        object Disconnected : UiState()
        /** CLI websocket connected, no active session running. */
        object Idle : UiState()
        /** CLI is running a session; tool window is in follow mode. */
        object Active : UiState()
        /** Last operation failed; show error banner. */
        data class Error(val message: String) : UiState()
    }

    private val _uiState = MutableStateFlow<UiState>(UiState.Disconnected)
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    /** Session id currently focused in the tool window, or null when idle. */
    private val _activeSessionId = MutableStateFlow<String?>(null)
    val activeSessionId: StateFlow<String?> = _activeSessionId.asStateFlow()

    private var monitorJob: Job? = null

    init {
        startMonitoring()
    }

    /**
     * Start the per-second MCP connection poll. On transition Disconnected →
     * Idle, publishes [UiState.Idle]. Replaces the panel's old
     * `Thread.sleep(1000)` busy loop with a coroutine `delay(1000)`.
     */
    fun startMonitoring() {
        if (monitorJob?.isActive == true) return
        monitorJob = scope.launch {
            while (true) {
                val connected = mcpService().isConnected
                val currentState = _uiState.value
                if (connected && currentState is UiState.Disconnected) {
                    _uiState.value = UiState.Idle
                } else if (!connected && currentState !is UiState.Disconnected) {
                    _uiState.value = UiState.Disconnected
                    _activeSessionId.value = null
                }
                delay(1000)
            }
        }
    }

    fun stopMonitoring() {
        monitorJob?.cancel()
        monitorJob = null
    }

    /**
     * Mark [sessionId] as active and flip state to [UiState.Active]. Called by
     * toolbar/panel actions when the user picks or creates a session.
     */
    fun setActiveSession(sessionId: String) {
        _activeSessionId.value = sessionId
        _uiState.value = UiState.Active
    }

    /** Clear the active session and return to [UiState.Idle] (if connected). */
    fun clearActiveSession() {
        _activeSessionId.value = null
        _uiState.value =
            if (mcpService().isConnected) UiState.Idle else UiState.Disconnected
    }

    /**
     * Ping the CLI with a no-op `ping` to surface connection errors. Mostly
     * used by the Panel's manual "Reconnect" action.
     */
    fun probe(): Boolean {
        return try {
            mcpService().sendRequest("ping", kotlinx.serialization.json.JsonObject(emptyMap()), 3_000L)
            true
        } catch (e: McpRemoteException) {
            _uiState.value = UiState.Error("CLI error: ${e.message}")
            false
        } catch (e: IllegalStateException) {
            // No session connected — not an error worth a banner.
            false
        } catch (e: Throwable) {
            _uiState.value = UiState.Error(e.message ?: "Unknown error")
            false
        }
    }

    fun clearError() {
        if (_uiState.value is UiState.Error) {
            _uiState.value =
                if (mcpService().isConnected) UiState.Idle else UiState.Disconnected
        }
    }

    private fun mcpService(): MCPService =
        ApplicationManager.getApplication().getService(MCPService::class.java)

    fun dispose() {
        stopMonitoring()
        scope.cancel()
    }
}
