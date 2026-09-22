package wtf.pana.neocode.jetbrains.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.ActionEvent
import javax.swing.AbstractAction
import javax.swing.DefaultListModel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.SwingUtilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import wtf.pana.neocode.jetbrains.model.SessionInfo

/**
 * Modal-ish dialog showing the list of Neocode sessions for the current
 * project. Bound to [SessionListViewModel]: the dialog subscribes to the
 * ViewModel's [StateFlow] and rebuilds the list model on every emit. Toolbar
 * actions delegate mutation RPCs back to the ViewModel.
 */
class SessionListDialog(
    private val project: Project,
    private val viewModel: SessionListViewModel = project.service<SessionListViewModel>(),
) : DialogWrapper(project) {

    private val listModel = DefaultListModel<SessionInfo>()
    private val list = JList(listModel).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = SessionListCellRenderer()
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var observerJob: kotlinx.coroutines.Job? = null

    init {
        title = "Neocode Sessions"
        init()
        startObserving()
        // Kick off initial fetch on the VM's own scope (not the dialog's).
        viewModel.refresh()
    }

    private fun startObserving() {
        observerJob = scope.launch {
            viewModel.state.collect { state ->
                ApplicationManager.getApplication().invokeLater {
                    render(state)
                }
            }
        }
    }

    private fun render(state: SessionListViewModel.State) {
        listModel.clear()
        when (state) {
            is SessionListViewModel.State.Loading -> {
                // Could show a placeholder; for now, empty list + dialog title suffices.
            }
            is SessionListViewModel.State.Loaded -> {
                state.sessions.forEach { listModel.addElement(it) }
            }
            is SessionListViewModel.State.Error -> {
                // Render the error as a single fake entry so it's visible.
                listModel.addElement(SessionInfo(
                    sessionId = "",
                    summary = state.message,
                    lastModified = 0L,
                ))
            }
            is SessionListViewModel.State.OpDone -> {
                // The refresh triggered by the ViewModel's own scope will
                // repopulate the list; nothing extra to do here.
            }
        }
    }

    override fun createCenterPanel(): javax.swing.JComponent {
        val panel = JPanel(BorderLayout())
        val scroll = JBScrollPane(list)
        panel.add(scroll, BorderLayout.CENTER)

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT))
        toolbar.add(javax.swing.JButton(object : AbstractAction("New") {
            override fun actionPerformed(e: ActionEvent?) {
                viewModel.createSession { id ->
                    // After a successful create, switch to it and close the dialog.
                    viewModel.switchTo(id) { sessionId ->
                        SwingUtilities.invokeLater { closeOk() }
                    }
                }
            }
        }))
        toolbar.add(javax.swing.JButton(object : AbstractAction("Switch") {
            override fun actionPerformed(e: ActionEvent?) {
                val sel = list.selectedValue ?: return
                viewModel.switchTo(sel.sessionId) {
                    SwingUtilities.invokeLater { closeOk() }
                }
            }
        }))
        toolbar.add(javax.swing.JButton(object : AbstractAction("Share") {
            override fun actionPerformed(e: ActionEvent?) {
                val sel = list.selectedValue ?: return
                viewModel.share(sel.sessionId) { url ->
                    url?.let {
                        val transferable = java.awt.datatransfer.StringSelection(it)
                        com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(transferable)
                    }
                }
            }
        }))
        toolbar.add(javax.swing.JButton(object : AbstractAction("Unshare") {
            override fun actionPerformed(e: ActionEvent?) {
                val sel = list.selectedValue ?: return
                viewModel.unshare(sel.sessionId)
            }
        }))
        toolbar.add(javax.swing.JButton(object : AbstractAction("Delete") {
            override fun actionPerformed(e: ActionEvent?) {
                val sel = list.selectedValue ?: return
                viewModel.delete(sel.sessionId)
            }
        }))
        toolbar.add(javax.swing.JButton(object : AbstractAction("Refresh") {
            override fun actionPerformed(e: ActionEvent?) {
                viewModel.refresh()
            }
        }))
        panel.add(toolbar, BorderLayout.NORTH)
        return panel
    }

    override fun doOKAction() {
        val sel = list.selectedValue
        if (sel != null) {
            viewModel.switchTo(sel.sessionId)
        }
        super.doOKAction()
    }

    override fun getDimensionServiceKey(): String = "NeocodeSessionListDialog"

    /** Public wrapper for the protected close(OK_EXIT_CODE) — used by async
     *  callbacks that need to close the dialog after a session op completes. */
    fun closeOk() = close(OK_EXIT_CODE)

    override fun dispose() {
        observerJob?.cancel()
        scope.cancel()
        super.dispose()
    }
}

/** Renders a [SessionInfo] as a single list row. */
private class SessionListCellRenderer : javax.swing.ListCellRenderer<SessionInfo> {
    private val panel = JPanel(BorderLayout(8, 4)).apply {
        border = com.intellij.util.ui.JBUI.Borders.empty(4, 8)
    }
    private val title = javax.swing.JLabel("").apply { font = font.deriveFont(font.style or java.awt.Font.BOLD) }
    private val subtitle = javax.swing.JLabel("")

    init {
        panel.add(title, BorderLayout.NORTH)
        panel.add(subtitle, BorderLayout.SOUTH)
    }

    override fun getListCellRendererComponent(
        list: JList<out SessionInfo>?,
        value: SessionInfo?,
        index: Int,
        selected: Boolean,
        cellHasFocus: Boolean,
    ): java.awt.Component {
        val v = value ?: return panel
        title.text = v.customTitle ?: v.firstPrompt ?: v.sessionId.take(8)
        subtitle.text = buildString {
            append(v.sessionId.take(8))
            v.gitBranch?.let { append("  ·  branch: $it") }
            v.summary?.let { append("  ·  $it") }
        }
        if (selected) {
            panel.background = UIUtil.getListSelectionBackground()
            title.foreground = UIUtil.getListSelectionForeground()
            subtitle.foreground = UIUtil.getListSelectionForeground()
        } else {
            panel.background = UIUtil.getListBackground()
            title.foreground = UIUtil.getListForeground()
            subtitle.foreground = UIUtil.getLabelDisabledForeground()
        }
        panel.isOpaque = true
        return panel
    }
}
