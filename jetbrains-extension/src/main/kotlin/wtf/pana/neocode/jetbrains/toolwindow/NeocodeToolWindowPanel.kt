package wtf.pana.neocode.jetbrains.toolwindow

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import com.intellij.openapi.util.Disposer
import com.intellij.terminal.JBTerminalWidget
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.awt.BorderLayout
import java.io.IOException
import javax.swing.JPanel
import wtf.pana.neocode.jetbrains.service.NeocodeService
import wtf.pana.neocode.jetbrains.settings.NeocodeSettings
import wtf.pana.neocode.jetbrains.toolwindow.NeocodeToolWindowViewModel.UiState
import wtf.pana.neocode.jetbrains.util.TerminalUtils

private val LOG = Logger.getInstance(NeocodeToolWindowPanel::class.java)

/**
 * MVVM host panel for the Neocode tool window.
 *
 * Owns:
 *  - the underlying [JBTerminalWidget] (terminal rendering of the Neocode
 *    interactive CLI launched in the project directory)
 *  - a [NeocodeToolWindowViewModel] that publishes connection/session state
 *    via [NeocodeToolWindowViewModel.uiState]
 *
 * The Panel observes the ViewModel's [StateFlow] on the IO dispatcher and
 * re-renders a small status banner in [NORTH] on every emit. The terminal
 * widget lives in [CENTER]; all the existing lifecycle (start/dispose/process
 * exit/auto-restart) is preserved.
 *
 * Architectural note: the heavy UI-from-ViewModel rendering that the upstream
 * opencode-jb plugin does is intentionally trimmed here — the terminal remains
 * the primary UI surface, and the ViewModel's state is used only for the
 * status banner + the periodic health check (replacing the old
 * `Thread.sleep(1000)` busy-wait with `delay(1000)`).
 *
 * @param project The current IntelliJ project
 * @param service The Neocode service for managing server lifecycle
 * @param viewModel The ViewModel owning UI state; defaults to the
 *   project-scoped service instance.
 */
class NeocodeToolWindowPanel(
    private val project: Project,
    private val service: NeocodeService,
    private val viewModel: NeocodeToolWindowViewModel =
        project.service<NeocodeToolWindowViewModel>(),
) : JPanel(BorderLayout()), Disposable {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var widget: JBTerminalWidget? = null
    private var widgetDisposable: Disposable? = null
    private var monitoringJob: kotlinx.coroutines.Job? = null
    private var isMonitoring = false

    private val statusLabel = javax.swing.JLabel("Neocode — Disconnected")

    init {
        background = UIUtil.getPanelBackground()
        // North strip: status banner driven by the ViewModel
        val header = JPanel(BorderLayout()).apply {
            add(statusLabel, BorderLayout.WEST)
        }
        add(header, BorderLayout.NORTH)

        service.initToolWindowPanel(this)
        observeViewModel()
        initializeTerminal()
    }

    private fun observeViewModel() {
        scope.launch {
            viewModel.uiState.collect { state ->
                ApplicationManager.getApplication().invokeLater {
                    renderStatus(state)
                }
            }
        }
    }

    private fun renderStatus(state: UiState) {
        statusLabel.text = when (state) {
            is UiState.Disconnected -> "Neocode — Disconnected"
            is UiState.Idle -> "Neocode — Connected (idle)"
            is UiState.Active -> "Neocode — Session ${viewModel.activeSessionId.value ?: "?"}"
            is UiState.Error -> "Neocode — Error: ${state.message}"
        }
    }

    private fun initializeTerminal() {
        scope.launch {
            try {
                ApplicationManager.getApplication().invokeLater {
                    createTerminalWidget()
                }
            } catch (e: Exception) {
                LOG.error("Failed to initialize Neocode terminal", e)
                ApplicationManager.getApplication().invokeLater {
                    showErrorUI("Failed to start Neocode: ${e.message}")
                }
            }
        }
    }

    private fun createTerminalWidget() {
        if (ApplicationManager.getApplication().isHeadlessEnvironment) {
            LOG.warn("Headless environment detected; skipping terminal widget creation")
            return
        }

        try {
            val widgetDisposable = Disposable { }
            Disposer.register(this, widgetDisposable)
            this.widgetDisposable = widgetDisposable

            val runner = object : org.jetbrains.plugins.terminal.LocalTerminalDirectRunner(project) {
                override fun configureStartupOptions(
                    baseOptions: org.jetbrains.plugins.terminal.ShellStartupOptions
                ): org.jetbrains.plugins.terminal.ShellStartupOptions {
                    val envs = mutableMapOf<String, String>()
                    envs["NEOCODE_CALLER"] = "jetbrains"

                    val neocodeCmd = wtf.pana.neocode.jetbrains.util.TerminalUtils.resolveNeocodeBinaryPath()
                        ?: "neocode"

                    // Launch the normal interactive Neocode CLI inside the terminal.
                    // The working directory is set via ShellStartupOptions (see
                    // startupOptions below) — no --dir flag is needed.
                    // Bidirectional MCP-over-WebSocket IPC is driven from the IDE
                    // side (MCPService, ws-ide transport) once the CLI is up.
                    val command = TerminalUtils.buildTerminalCommand(neocodeCmd)
                    LOG.info("Terminal command configured: ${command.joinToString(" ")}")

                    return baseOptions.builder()
                        .shellCommand(command)
                        .envVariables(envs)
                        .build()
                }
            }

            val startupOptions = org.jetbrains.plugins.terminal.ShellStartupOptions.Builder()
                .workingDirectory(project.basePath ?: System.getProperty("user.home"))
                .build()

            LOG.info("Starting shell terminal widget...")
            val terminalWidget = runner.startShellTerminalWidget(
                widgetDisposable,
                startupOptions,
                true
            )
            LOG.info("Shell terminal widget started: ${terminalWidget.javaClass.simpleName}")

            val jbWidget = JBTerminalWidget.asJediTermWidget(terminalWidget)
                ?: throw IllegalStateException("Failed to create JBTerminalWidget")

            LOG.info("JBTerminalWidget created")

            this.widget = jbWidget
            service.registerWidget(jbWidget)

            removeAll()
            add(statusLabel.parent as? javax.swing.JComponent ?: statusLabel, BorderLayout.NORTH)
            add(jbWidget.component, BorderLayout.CENTER)
            revalidate()
            repaint()

            startProcessMonitoring()

            LOG.info("Neocode tool window terminal initialized successfully")
        } catch (e: Throwable) {
            LOG.error("Failed to create terminal widget", e)
            showErrorUI("Failed to initialize Neocode terminal: ${e.message ?: e::class.simpleName}")
        }
    }

    private fun startProcessMonitoring() {
        isMonitoring = true
        monitoringJob = scope.launch {
            LOG.debug("Process monitoring started for tool window panel")
            try {
                while (isMonitoring) {
                    delay(1000)
                    val isAlive = checkIfTerminalAlive()
                    if (!isAlive) {
                        LOG.info("Neocode tool window terminal process has exited")
                        ApplicationManager.getApplication().invokeLater {
                            handleProcessExit()
                        }
                        break
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                LOG.debug("Process monitoring coroutine cancelled")
            }
            LOG.debug("Process monitoring stopped for tool window panel")
        }
    }

    private suspend fun checkIfTerminalAlive(): Boolean {
        val currentWidget = widget ?: return false
        return try {
            val ttyConnector = currentWidget.ttyConnector
            if (ttyConnector != null) {
                ttyConnector.isConnected
            } else {
                // No TTY connector yet — terminal has not finished initializing.
                // Treat as alive so the monitoring loop doesn't tear it down
                // before it has a chance to come up.
                true
            }
        } catch (e: IOException) {
            LOG.warn("Failed to check TTY connector status", e)
            false
        }
    }

    private fun handleProcessExit() {
        // Diagnostic: capture the neocode process exit code AND any remaining
        // bytes on its stdout/stderr streams to the IDE log so we can see WHY
        // neocode died (its stderr/stdout is otherwise trapped in the PTY and
        // invisible once the process exits). Remove once root cause is
        // identified and fixed.
        captureProcessExitDiagnostics()
        dumpTerminalScreen()
        cleanupWidget()
        val settings = NeocodeSettings.getInstance()
        if (!settings.state.autoRestartOnExit) {
            showRestartUI()
        } else {
            initializeTerminal()
        }
    }

    /**
     * Dump the visible terminal screen lines to the IDE log. Uses the public
     * JediTerm API: JBTerminalWidget (extends JediTermWidget) -> TerminalPanel
     * -> TerminalTextBuffer -> getLine(i) -> TerminalLine. Best-effort — any
     * failure is logged but does not abort the exit handling.
     */
    private fun dumpTerminalScreen() {
        val w = widget ?: run {
            LOG.warn("dumpTerminalScreen: widget is null (already disposed?)")
            return
        }
        try {
            // JBTerminalWidget extends JediTermWidget which exposes
            // getTerminalPanel(): TerminalPanel — public API on JediTermWidget.
            val panel = com.jediterm.terminal.ui.JediTermWidget::class.java
                .getMethod("getTerminalPanel").invoke(w)
                as com.jediterm.terminal.ui.TerminalPanel
            val buffer = panel.terminalTextBuffer
            val height = buffer.height
            val sb = StringBuilder("\n========== Neocode terminal screen dump (height=$height) ==========\n")
            for (i in 0 until height) {
                val line = try { buffer.getLine(i) } catch (e: Exception) { null } ?: continue
                val text = try { line.getText() } catch (e: Exception) {
                    try { line.toString() } catch (_: Exception) { "" }
                }
                sb.append("[line $i] $text\n")
            }
            sb.append("=================================================================\n")
            LOG.warn(sb.toString())
        } catch (e: Throwable) {
            LOG.warn("Failed to dump terminal screen", e)
        }
    }

    /**
     * Diagnostic: capture the neocode process exit code and any remaining
     * bytes on the process's raw stdout/stderr streams. JediTerm normally
     * drains the stdout stream into the terminal buffer, but the exit code
     * is only available via the underlying Process. Cast the TtyConnector to
     * ProcessTtyConnector (used by the Windows ConPTY backend) and probe it.
     * Best-effort — any failure is logged but does not abort exit handling.
     */
    private fun captureProcessExitDiagnostics() {
        val w = widget ?: run {
            LOG.warn("captureProcessExitDiagnostics: widget is null (already disposed?)")
            return
        }
        try {
            val tty = w.ttyConnector ?: run {
                LOG.warn("captureProcessExitDiagnostics: ttyConnector is null")
                return
            }
            LOG.warn("captureProcessExitDiagnostics: ttyConnector class=${tty.javaClass.name} isConnected=${tty.isConnected}")
            if (tty !is com.jediterm.terminal.ProcessTtyConnector) {
                LOG.warn("captureProcessExitDiagnostics: ttyConnector is NOT a ProcessTtyConnector — cannot read process exit code")
                return
            }
            val proc = tty.process
            val pid = try { proc.pid() } catch (e: Throwable) { "unknown" }
            val exitCode = try { proc.exitValue() } catch (e: IllegalThreadStateException) {
                LOG.warn("captureProcessExitDiagnostics: process still alive when exit-hander ran? pid=$pid")
                return
            } catch (e: Throwable) {
                LOG.warn("captureProcessExitDiagnostics: failed to read exitValue", e)
                return
            }
            LOG.warn("captureProcessExitDiagnostics: neocode process pid=$pid exitCode=$exitCode cmdline=${tty.commandLine}")

            // Best-effort: probe the raw process streams for any bytes
            // JediTerm didn't drain (race window before container disposal).
            // ConPTY merges stdout+stderr, so getInputStream() usually holds
            // everything; still probe getErrorStream() in case they're split.
            tryReadRemainingStream("process.getInputStream", proc.inputStream)
            tryReadRemainingStream("process.getErrorStream", proc.errorStream)
        } catch (e: Throwable) {
            LOG.warn("captureProcessExitDiagnostics: failed", e)
        }
    }

    private fun tryReadRemainingStream(label: String, stream: java.io.InputStream) {
        try {
            val avail = stream.available()
            LOG.warn("$label: available=$avail")
            if (avail <= 0) return
            val buf = ByteArray(avail)
            val read = stream.read(buf)
            if (read > 0) {
                val text = String(buf, 0, read, Charsets.UTF_8)
                LOG.warn("$label: read $read bytes: ${text.replace("\r", "\\r").replace("\n", "\\n")}")
            }
        } catch (e: Throwable) {
            LOG.warn("$label: failed to read", e)
        }
    }

    private fun showRestartUI() {
        ApplicationManager.getApplication().invokeLater {
            removeAll()
            val panel = JPanel(java.awt.GridBagLayout())
            panel.background = UIUtil.getPanelBackground()

            val gbc = java.awt.GridBagConstraints()
            gbc.gridx = 0
            gbc.gridy = 0
            gbc.insets = java.awt.Insets(10, 10, 5, 10)
            gbc.anchor = java.awt.GridBagConstraints.CENTER

            val messageLabel = javax.swing.JLabel("● Neocode has stopped")
            panel.add(messageLabel, gbc)

            gbc.gridy = 1
            gbc.insets = java.awt.Insets(10, 10, 20, 10)
            val restartButton = javax.swing.JButton("Restart Neocode")
            restartButton.addActionListener { restartTerminal() }
            panel.add(restartButton, gbc)

            add(panel, BorderLayout.CENTER)
            revalidate()
            repaint()
            LOG.info("Restart UI displayed for tool window panel")
        }
    }

    private fun showErrorUI(message: String) {
        ApplicationManager.getApplication().invokeLater {
            removeAll()
            val panel = JPanel(java.awt.GridBagLayout())
            panel.background = UIUtil.getPanelBackground()

            val gbc = java.awt.GridBagConstraints()
            gbc.gridx = 0
            gbc.gridy = 0
            gbc.insets = java.awt.Insets(10, 10, 10, 10)
            gbc.anchor = java.awt.GridBagConstraints.CENTER

            val errorLabel = javax.swing.JLabel("<html><center>$message</center></html>")
            panel.add(errorLabel, gbc)

            add(panel, BorderLayout.CENTER)
            revalidate()
            repaint()
        }
    }

    private fun restartTerminal() {
        LOG.info("Restarting Neocode tool window terminal (user request)")
        isMonitoring = false
        monitoringJob?.cancel()
        monitoringJob = null
        cleanupWidget()
        initializeTerminal()
    }

    private fun cleanupWidget() {
        widget?.let { w -> service.unregisterWidget(w) }
        widget = null

        widgetDisposable?.let { d ->
            if (!Disposer.isDisposed(d)) {
                Disposer.dispose(d)
            }
        }
        widgetDisposable = null
    }

    override fun dispose() {
        LOG.info("NeocodeToolWindowPanel disposed")
        isMonitoring = false
        monitoringJob?.cancel()
        monitoringJob = null
        cleanupWidget()
        viewModel.dispose()
        scope.cancel()
    }
}
