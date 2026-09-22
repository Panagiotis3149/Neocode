package wtf.pana.neocode.jetbrains.tools

import com.intellij.openapi.project.Project
import wtf.pana.neocode.jetbrains.services.MCPService

/**
 * Registers all Neocode MCP tools on [MCPService]'s server.
 *
 * Each tool category (`DiffTools`, `EditorTools`, `FileTools`) registers
 * its own set of tools; this class just wires them all up. Milestone 1
 * wires no-op stub tools so `tools/list` returns registered names; real
 * handlers arrive in milestones 3+.
 */
class ToolManager(@Suppress("UNUSED_PARAMETER") private val project: Project) {
    fun registerAll(mcpService: MCPService) {
        DiffTools.register(mcpService, project)
        EditorTools.register(mcpService, project)
        FileTools.register(mcpService, project)
    }
}
