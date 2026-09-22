package wtf.pana.neocode.jetbrains.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import wtf.pana.neocode.jetbrains.model.SessionInfo
import wtf.pana.neocode.jetbrains.service.NeocodeService

private val LOG = logger<SessionListViewModel>()

/**
 * MVVM ViewModel behind the SessionListDialog. Owns a [StateFlow] of loaded
 * sessions + error state and triggers NeocodeService session RPCs from
 * background coroutines. The Dialog observes [state] and re-renders on every
 * emit; no business logic leaks into the Swing layer.
 *
 * State machine:
 *   - [State.Loading] : a fetch is in flight
 *   - [State.Loaded]  : sessions available for the list
 *   - [State.Error]   : RPC failed; dialog shows the message
 *   - [State.OpDone]  : a mutating RPC finished; dialog refreshes list
 */
@Service(Service.Level.PROJECT)
class SessionListViewModel(private val project: Project) {

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    sealed class State {
        object Loading : State()
        data class Loaded(val sessions: List<SessionInfo>) : State()
        data class Error(val message: String) : State()
        /** Latch state used by the Dialog to refresh after a mutating op. */
        data class OpDone(val op: String) : State()
    }

    private val _state = MutableStateFlow<State>(State.Loading)
    val state: StateFlow<State> = _state.asStateFlow()

    private var refreshJob: Job? = null

    /**
     * Fetch sessions for [project]'s cwd. Safe to call multiple times: the
     * latest invocation wins and replaces any in-flight fetch.
     */
    fun refresh() {
        refreshJob?.cancel()
        refreshJob = scope.launch {
            _state.value = State.Loading
            try {
                val result = service().listSessions()
                _state.value = State.Loaded(result.sessions)
            } catch (e: Throwable) {
                LOG.warn("listSessions failed", e)
                _state.value = State.Error(e.message ?: "Failed to load sessions")
            }
        }
    }

    fun createSession(onDone: (String) -> Unit = {}) {
        scope.launch {
            try {
                val id = service().createSession()
                _state.value = State.OpDone("create")
                withContext(Dispatchers.Main) { onDone(id) }
                refresh()
            } catch (e: Throwable) {
                _state.value = State.Error(e.message ?: "Failed to create session")
            }
        }
    }

    fun switchTo(sessionId: String, onDone: (String) -> Unit = {}) {
        scope.launch {
            try {
                service().switchSession(sessionId)
                _state.value = State.OpDone("switch")
                withContext(Dispatchers.Main) { onDone(sessionId) }
            } catch (e: Throwable) {
                _state.value = State.Error(e.message ?: "Failed to switch session")
            }
        }
    }

    fun delete(sessionId: String) {
        scope.launch {
            try {
                service().deleteSession(sessionId)
                _state.value = State.OpDone("delete")
                refresh()
            } catch (e: Throwable) {
                _state.value = State.Error(e.message ?: "Failed to delete session")
            }
        }
    }

    fun share(sessionId: String, onDone: (String?) -> Unit = {}) {
        scope.launch {
            try {
                val r = service().shareSession(sessionId)
                _state.value = State.OpDone("share")
                withContext(Dispatchers.Main) { onDone(if (r.ok) r.url else null) }
            } catch (e: Throwable) {
                _state.value = State.Error(e.message ?: "Failed to share session")
            }
        }
    }

    fun unshare(sessionId: String) {
        scope.launch {
            try {
                service().unshareSession(sessionId)
                _state.value = State.OpDone("unshare")
            } catch (e: Throwable) {
                _state.value = State.Error(e.message ?: "Failed to unshare session")
            }
        }
    }

    private fun service(): NeocodeService = project.service<NeocodeService>()

    fun dispose() {
        scope.cancel()
    }
}
