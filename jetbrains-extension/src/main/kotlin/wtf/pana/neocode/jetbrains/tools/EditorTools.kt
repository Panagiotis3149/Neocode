package wtf.pana.neocode.jetbrains.tools

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import wtf.pana.neocode.jetbrains.services.MCPService
import wtf.pana.neocode.jetbrains.util.Utils

/**
 * Handler for the `openFile` MCP RPC method.
 *
 * Resolves the file path (absolute or project-relative), opens it in the
 * active project's editor, optionally with a selection bracketed by
 * `startText` / `endText` (or `selectToEndOfLine`).
 */
object EditorTools {
    private val json = Json { ignoreUnknownKeys = true; classDiscriminator = "type" }

    fun register(mcpService: MCPService, @Suppress("UNUSED_PARAMETER") project: Project) {
        mcpService.addTool(
            ToolDef(
                name = "openFile",
                description = "opens a file in the editor with optional selection",
                inputSchema = """{"type":"object","properties":{"filePath":{"type":"string"},"preview":{"type":"boolean"},"startText":{"type":"string"},"endText":{"type":"string"},"selectToEndOfLine":{"type":"boolean"},"makeFrontmost":{"type":"boolean"}},"required":["filePath"]}""",
                handler = { args -> handleOpenFile(args) },
            )
        )
    }

    private fun handleOpenFile(args: JsonElement?): CallToolResult {
        val openArgs = try {
            json.decodeFromJsonElement(OpenFileToolArgs.serializer(), args ?: return error("Missing arguments"))
        } catch (t: Throwable) {
            return error("Invalid arguments: ${t.message}")
        }

        val activeProject = Utils.getLastFocusedOpenedProject()
            ?: return error("No active project")
        val projectDir = Utils.getProjectDir(activeProject)
            ?: return error("Project directory not available")

        val virtualFile = Utils.openVirtualFileFromPath(openArgs.filePath, projectDir)
            ?: return error("File not found: ${openArgs.filePath}")

        var opened = false
        var statusMessage = "Opened ${virtualFile.name}"
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val document = FileDocumentManager.getInstance().getDocument(virtualFile)
                val selection = computeSelection(document, openArgs)
                // OpenFileDescriptor ctor: (project, file, offset, selEnd, focusEditor).
                val descriptor = if (selection.offset != 0 || selection.endOffset != 0) {
                    OpenFileDescriptor(activeProject, virtualFile, selection.offset, selection.endOffset, true)
                } else {
                    OpenFileDescriptor(activeProject, virtualFile)
                }
                if (openArgs.preview) descriptor.setUsePreviewTab(true)

                val editor = FileEditorManager.getInstance(activeProject).openTextEditor(descriptor, true)
                if (editor != null) {
                    opened = true
                    statusMessage = "Opened ${virtualFile.name}" +
                        if (openArgs.startText != null) " with selection" else ""
                }
            } catch (t: Throwable) {
                statusMessage = "openFile failed: ${t.message ?: t::class.simpleName}"
            }
        }

        return if (opened) {
            CallToolResult(content = listOf(TextContent(text = statusMessage)))
        } else {
            error(statusMessage.ifEmpty { "openFile failed" })
        }
    }

    private data class Selection(val offset: Int, val endOffset: Int)

    /**
     * Compute the (start, end) offsets for the requested selection.
     * Returns (0, 0) when no selection is requested or the startText cannot be found.
     */
    private fun computeSelection(document: Document?, args: OpenFileToolArgs): Selection {
        if (document == null || args.startText == null) return Selection(0, 0)
        val text = document.text
        val startOffset = text.indexOf(args.startText)
        if (startOffset < 0) return Selection(0, 0)

        val endOffset = args.endText?.let { needle ->
            val after = text.indexOf(needle, startOffset + args.startText.length)
            if (after < 0) text.length else after + needle.length
        } ?: if (args.selectToEndOfLine) {
            val line = document.getLineNumber(startOffset)
            document.getLineEndOffset(line)
        } else {
            startOffset + args.startText.length
        }
        return Selection(startOffset, endOffset)
    }

    private fun error(message: String): CallToolResult =
        CallToolResult(content = listOf(TextContent(text = message)), isError = true)
}
