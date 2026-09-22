package wtf.pana.neocode.jetbrains.tools

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffDialogHints
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import wtf.pana.neocode.jetbrains.services.MCPService
import wtf.pana.neocode.jetbrains.util.Utils

/**
 * Handlers for diff-related MCP RPC methods.
 *
 * `openDiff`: shows a diff view between the on-disk contents of `old_file_path`
 * and the proposed `new_file_contents` via the public `DiffManager.showDiff`
 * API.
 *
 * `close_tab`: closes the editor whose file name matches `tab_name` via
 * `FileEditorManager.closeFile`. Diff tool-window tabs are tracked by us so we
 * can close them too.
 *
 * `closeAllDiffTabs`: closes every tracked diff tool window.
 */
object DiffTools {
    private val json = Json { ignoreUnknownKeys = true; classDiscriminator = "type" }

    /** Tracks which tab names we have opened via [handleOpenDiff] so close_tab can find them. */
    private val openDiffTabNames = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun register(mcpService: MCPService, project: Project) {
        mcpService.addTool(
            ToolDef(
                name = "openDiff",
                description = "opens a diff in the IDE",
                inputSchema = """{"type":"object","properties":{"old_file_path":{"type":"string"},"new_file_path":{"type":"string"},"new_file_contents":{"type":"string"},"tab_name":{"type":"string"}},"required":["old_file_path","new_file_path","new_file_contents","tab_name"]}""",
                handler = { args -> handleOpenDiff(args) },
            )
        )
        mcpService.addTool(
            ToolDef(
                name = "close_tab",
                description = "closes a tab by name",
                inputSchema = """{"type":"object","properties":{"tab_name":{"type":"string"}},"required":["tab_name"]}""",
                handler = { args -> handleCloseTab(project, args) },
            )
        )
        mcpService.addTool(
            ToolDef(
                name = "closeAllDiffTabs",
                description = "closes all diff tabs opened by openDiff",
                inputSchema = """{"type":"object","additionalProperties":false}""",
                handler = { _ -> handleCloseAllDiffTabs(project) },
            )
        )
    }

    private fun handleOpenDiff(args: JsonElement?): CallToolResult {
        val openDiffArgs = try {
            json.decodeFromJsonElement(OpenDiffToolArgs.serializer(), args ?: return error("Missing arguments"))
        } catch (t: Throwable) {
            return error("Invalid arguments: ${t.message}")
        }

        val project = Utils.getLastFocusedOpenedProject()
            ?: return error("No active project")
        val projectDir = Utils.getProjectDir(project)
            ?: return error("Project directory not available")

        // The MCP handler runs on the WS reader thread (off-EDT). Diff APIs
        // require the EDT; wrap the whole flow in invokeAndWait so we can
        // return a synchronous CallToolResult from the tool handler.
        var failureMessage: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val originalFile = Utils.openVirtualFileFromPath(openDiffArgs.old_file_path, projectDir)
                val fileType = originalFile?.fileType

                val oldContents = originalFile
                    ?.let { FileDocumentManager.getInstance().getDocument(it)?.text }
                    ?: ""

                val contentFactory = DiffContentFactory.getInstance()
                val originalDiffContent = if (fileType != null) {
                    contentFactory.create(project, oldContents, fileType)
                } else {
                    contentFactory.create(project, oldContents)
                }
                val proposedDiffContent = if (fileType != null) {
                    contentFactory.create(project, openDiffArgs.new_file_contents, fileType)
                } else {
                    contentFactory.create(project, openDiffArgs.new_file_contents)
                }

                val originalTitlePrefix = if (originalFile != null) "Source: " else "New: "
                val diffRequest = SimpleDiffRequest(
                    openDiffArgs.tab_name,
                    originalDiffContent,
                    proposedDiffContent,
                    "$originalTitlePrefix${openDiffArgs.old_file_path}",
                    "Proposed",
                )
                val diffRequestChain = SimpleDiffRequestChain(diffRequest)

                DiffManager.getInstance().showDiff(project, diffRequestChain, DiffDialogHints.DEFAULT)
            } catch (t: Throwable) {
                failureMessage = t.message ?: t::class.simpleName
            }
        }

        if (failureMessage != null) return error(failureMessage ?: "openDiff failed")

        openDiffTabNames.add(openDiffArgs.tab_name)

        return CallToolResult(
            content = listOf(TextContent(text = "Opened diff tab '${openDiffArgs.tab_name}'")),
        )
    }

    private fun handleCloseTab(project: Project, args: JsonElement?): CallToolResult {
        val closeArgs = try {
            json.decodeFromJsonElement(CloseTabToolArgs.serializer(), args ?: return error("Missing arguments"))
        } catch (t: Throwable) {
            return error("Invalid arguments: ${t.message}")
        }

        var closedAsEditor = false
        var closedAsDiff = false
        ApplicationManager.getApplication().invokeAndWait {
            val manager = FileEditorManager.getInstance(project)
            // First check regular file editors by file name match.
            for (file in manager.getOpenFiles()) {
                if (file.name == closeArgs.tab_name) {
                    manager.closeFile(file)
                    closedAsEditor = true
                    break
                }
            }
            if (closedAsEditor) return@invokeAndWait

            // Then check tracked diff windows — IntelliJ's diff tool window is
            // a single platform-registered tool window with id "Diff". Hide it
            // to close the most-recently-shown diff.
            if (!openDiffTabNames.remove(closeArgs.tab_name)) return@invokeAndWait
            val diffToolWindow = ToolWindowManager.getInstance(project).getToolWindow("Diff")
            if (diffToolWindow != null) {
                diffToolWindow.hide()
                closedAsDiff = true
            }
        }

        return when {
            closedAsEditor -> CallToolResult(content = listOf(TextContent(text = "Closed editor tab '${closeArgs.tab_name}'")))
            closedAsDiff -> CallToolResult(content = listOf(TextContent(text = "Closed diff tab '${closeArgs.tab_name}'")))
            else -> CallToolResult(
                content = listOf(TextContent(text = "No tab named '${closeArgs.tab_name}'")),
                isError = true,
            )
        }
    }

    private fun handleCloseAllDiffTabs(project: Project): CallToolResult {
        var count = 0
        ApplicationManager.getApplication().invokeAndWait {
            val diffToolWindow = ToolWindowManager.getInstance(project).getToolWindow("Diff")
            if (diffToolWindow != null) {
                diffToolWindow.hide()
                count++
            }
            openDiffTabNames.clear()
        }

        return CallToolResult(
            content = listOf(TextContent(text = "Closed $count diff tab(s)")),
        )
    }

    private fun error(message: String): CallToolResult =
        CallToolResult(content = listOf(TextContent(text = message)), isError = true)
}
