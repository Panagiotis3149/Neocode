package wtf.pana.neocode.jetbrains.toolwindow

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware

/**
 * Opens the [SessionListDialog]. Registered as a tool window toolbar action
 * via `plugin.xml` so the user can list/create/switch/delete Neocode
 * sessions directly from the tool window banner.
 */
class ShowSessionsAction : AnAction(), DumbAware {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val dialog = SessionListDialog(project)
        dialog.show()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
