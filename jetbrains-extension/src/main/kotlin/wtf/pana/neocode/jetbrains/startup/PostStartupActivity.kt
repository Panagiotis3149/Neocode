package wtf.pana.neocode.jetbrains.startup

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import wtf.pana.neocode.jetbrains.services.MCPService
import wtf.pana.neocode.jetbrains.tools.ToolManager

/**
 * Runs once per project open as the plugin's bootstrap:
 *   1. Start the MCP server via [MCPService]
 *   2. Write the lockfile so Neocode CLI detects the connected IDE
 *   3. Register MCP tools via [ToolManager]
 *
 * Registered as `<postStartupActivity>` in plugin.xml.
 *
 * TODO: implementation.
 */
class PostStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val mcpService = MCPService.getInstance()
        mcpService.start()
        ToolManager(project).registerAll(mcpService)
    }
}
