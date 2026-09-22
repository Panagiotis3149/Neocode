package wtf.pana.neocode.jetbrains.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import org.jetbrains.plugins.terminal.TerminalView
import wtf.pana.neocode.jetbrains.notifications.NotificationManager
import wtf.pana.neocode.jetbrains.util.TerminalUtils
import wtf.pana.neocode.jetbrains.util.Utils

/**
 * Opens a Neocode CLI session in the IDE's terminal panel.
 *
 * Flow:
 *   1. Resolve the `neocode` binary path (NEOCODE_BIN env var → PATH → known install dirs)
 *   2. Open a new local shell terminal tab rooted at the project's base directory
 *   3. Execute the resolved binary path inside that terminal
 *
 * Visible only when a project is open. If the binary can't be located we fall back
 * to launching a plain shell terminal with a notification explaining why.
 */
class OpenClaudeInTerminalAction : AnAction() {
    private val log = Logger.getInstance(OpenClaudeInTerminalAction::class.java)

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val projectDir = Utils.getProjectDir(project)?.toString()
            ?: run {
                NotificationManager.notifyError(
                    project,
                    title = "Neocode",
                    content = "Could not determine project directory.",
                )
                return
            }

        // Binary lookup may hit disk I/O for the install-dir fallback list; push it
        // off the EDT. `createLocalShellWidget` itself requires the EDT, so we hop
        // back via invokeAndWait for the UI call.
        ApplicationManager.getApplication().executeOnPooledThread {
            val binaryPath = TerminalUtils.resolveNeocodeBinaryPath()
            ApplicationManager.getApplication().invokeAndWait {
                try {
                    val widget = TerminalView.getInstance(project)
                        .createLocalShellWidget(projectDir, null)
                    if (binaryPath != null) {
                        widget.executeCommand(binaryPath)
                    } else {
                        log.warn("neocode binary not found; opened empty terminal at $projectDir")
                        NotificationManager.notifyError(
                            project,
                            title = "Neocode",
                            content = "Could not locate the `neocode` binary in PATH or known install dirs. " +
                                "Set NEOCODE_BIN or install Neocode, then run `neocode` manually in the terminal.",
                        )
                    }
                } catch (t: Throwable) {
                    log.error("Failed to spawn neocode terminal", t)
                    NotificationManager.notifyError(
                        project,
                        title = "Neocode",
                        content = "Failed to open terminal: ${t.message ?: t::class.simpleName}",
                    )
                }
            }
        }
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
