package wtf.pana.neocode.jetbrains

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.Content
import com.intellij.openapi.diagnostic.logger
import wtf.pana.neocode.jetbrains.service.NeocodeService
import wtf.pana.neocode.jetbrains.toolwindow.NeocodeToolWindowPanel

/**
 * Tool window factory for the Neocode terminal panel.
 * Creates the panel on first activation; the panel itself launches the
 * interactive `neocode` CLI in its embedded terminal widget.
 */
class NeocodeToolWindowFactory : ToolWindowFactory {
    private val log = logger<NeocodeToolWindowFactory>()

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val contentManager = toolWindow.contentManager
        val existing = contentManager.contents.firstOrNull { it.displayName == "NeocodeTerminal" }
        if (existing != null) return

        val panel = NeocodeToolWindowPanel(project, project.service<NeocodeService>())

        val factory = ContentFactory.getInstance()
        val content = factory.createContent(panel, "NeocodeTerminal", false)
        contentManager.addContent(content)
        log.info("Neocode tool window content created")
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}