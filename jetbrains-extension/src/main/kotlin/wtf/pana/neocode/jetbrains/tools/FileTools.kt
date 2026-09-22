package wtf.pana.neocode.jetbrains.tools

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiManager
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.encodeToJsonElement
import wtf.pana.neocode.jetbrains.services.MCPService
import wtf.pana.neocode.jetbrains.util.Utils
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * MCP tool handlers for file diagnostics and shell-style code execution.
 *
 * `getDiagnostics`: returns inline inspection results for one file (or all
 * files when no `uri` is given). The Neocode CLI uses these to surface post-edit
 * errors back to the model.
 *
 * `executeCode`: runs an arbitrary shell command via [ProcessBuilder] with a
 * default 30s timeout. Output (stdout/stderr/exit code) is returned in the
 * tool result. The command is launched from `cwd` if supplied, otherwise from
 * the active project's base dir.
 */
object FileTools {
    private val json = Json { ignoreUnknownKeys = true; classDiscriminator = "type" }

    private const val DEFAULT_TIMEOUT_MS = 30_000L
    private const val MAX_TIMEOUT_MS = 120_000L
    private const val MAX_OUTPUT_BYTES = 64 * 1024

    fun register(mcpService: MCPService, @Suppress("UNUSED_PARAMETER") project: Project) {
        mcpService.addTool(
            ToolDef(
                name = "getDiagnostics",
                description = "Returns inspection diagnostics for a file (or all files in the project).",
                inputSchema = """{"type":"object","properties":{"uri":{"type":"string","description":"file:// URI of the file to inspect; omit to return all open diagnostics."}},"additionalProperties":false}""",
                handler = { args -> handleGetDiagnostics(args) },
            )
        )
        mcpService.addTool(
            ToolDef(
                name = "executeCode",
                description = "Runs a shell command in the project directory and returns stdout/stderr/exit code.",
                inputSchema = """{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"integer"}},"required":["command"]}""",
                handler = { args -> handleExecuteCode(args) },
            )
        )
    }

    // -----------------------------------------------------------------------
    // getDiagnostics
    // -----------------------------------------------------------------------

    private fun handleGetDiagnostics(args: JsonElement?): CallToolResult {
        val parsed = try {
            args?.let { json.decodeFromJsonElement(GetDiagnosticsToolArgs.serializer(), it) } ?: GetDiagnosticsToolArgs()
        } catch (t: Throwable) {
            return error("Invalid arguments: ${t.message}")
        }

        val activeProject = Utils.getLastFocusedOpenedProject()
            ?: return error("No active project")

        val targetFile: VirtualFile? = parsed.uri?.let { uri -> resolveFromUri(uri, activeProject) }

        val entries = mutableListOf<DiagnosticEntry>()
        var failureMessage: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                if (targetFile != null) {
                    collectForFile(activeProject, targetFile, entries)
                } else {
                    // No uri → enumerate dirty/open files. Keep scope small: we walk the
                    // project's FileEditorManager open files plus the FileDocumentManager
                    // committed documents so unsaved-but-known files show diagnostics too.
                    val fem = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(activeProject)
                    val seen = mutableSetOf<String>()
                    for (vf in fem.openFiles) {
                        if (seen.add(vf.path)) collectForFile(activeProject, vf, entries)
                    }
                    for (doc in FileDocumentManager.getInstance().unsavedDocuments) {
                        val vf = FileDocumentManager.getInstance().getFile(doc) ?: continue
                        if (seen.add(vf.path)) collectForFile(activeProject, vf, entries)
                    }
                }
            } catch (t: Throwable) {
                failureMessage = t.message ?: t::class.simpleName
            }
        }

        if (failureMessage != null) return error(failureMessage ?: "getDiagnostics failed")

        val payload = GetDiagnosticsResult(entries = entries)
        return CallToolResult(
            content = listOf(TextContent(text = json.encodeToString(GetDiagnosticsResult.serializer(), payload))),
        )
    }

    /**
     * Walk [HighlightInfo] for a single file (file-level + per-highlight ranges),
     * converting each to a [DiagnosticEntry]. Runs on the EDT.
     */
    private fun collectForFile(project: Project, vFile: VirtualFile, out: MutableList<DiagnosticEntry>) {
        val psiFile = PsiManager.getInstance(project).findFile(vFile) ?: return
        val document = FileDocumentManager.getInstance().getDocument(vFile) ?: return

        val daemon = DaemonCodeAnalyzer.getInstance(project) as DaemonCodeAnalyzerImpl
        val infos = daemon.getFileLevelHighlights(project, psiFile).orEmpty()

        for (info in infos) {
            appendEntry(document, vFile, info, out)
        }
    }

    private fun appendEntry(document: Document, vFile: VirtualFile, info: HighlightInfo, out: MutableList<DiagnosticEntry>) {
        val severity = severityName(info.severity)
        val start = info.startOffset.coerceIn(0, document.textLength)
        val end = info.endOffset.coerceIn(start, document.textLength)
        out += DiagnosticEntry(
            uri = URI.create("file://" + vFile.path.replace('\\', '/')).toString(),
            severity = severity,
            message = info.description.orEmpty(),
            startLine = document.getLineNumber(start),
            startColumn = start - document.getLineStartOffset(document.getLineNumber(start)),
            endLine = document.getLineNumber(end),
            endColumn = end - document.getLineStartOffset(document.getLineNumber(end)),
        )
    }

    private fun severityName(s: HighlightSeverity?): String = when (s) {
        HighlightSeverity.ERROR -> "error"
        HighlightSeverity.WARNING -> "warning"
        HighlightSeverity.WEAK_WARNING -> "weak_warning"
        HighlightSeverity.INFO -> "info"
        else -> "other"
    }

    /**
     * Resolve a `file://` URI to a [VirtualFile] under the active project.
     * Falls back to `Utils.openVirtualFileFromPath` for `path:` schemes.
     */
    private fun resolveFromUri(uri: String, project: Project): VirtualFile? {
        return try {
            val parsed = URI(uri)
            val rawPath = parsed.path ?: return null
            val projectDir = Utils.getProjectDir(project) ?: return null
            Utils.openVirtualFileFromPath(rawPath, projectDir)
        } catch (_: Throwable) {
            null
        }
    }

    // -----------------------------------------------------------------------
    // executeCode
    // -----------------------------------------------------------------------

    private fun handleExecuteCode(args: JsonElement?): CallToolResult {
        val parsed = try {
            json.decodeFromJsonElement(ExecuteCodeToolArgs.serializer(), args ?: return error("Missing arguments"))
        } catch (t: Throwable) {
            return error("Invalid arguments: ${t.message}")
        }

        val activeProject = Utils.getLastFocusedOpenedProject()
            ?: return error("No active project")
        val baseDir = parsed.cwd?.let { File(it) }
            ?: Utils.getProjectDir(activeProject)?.toFile()
            ?: return error("Working directory not available")

        if (!baseDir.exists()) return error("Working directory does not exist: ${baseDir.absolutePath}")

        val timeoutMs = (parsed.timeoutMs ?: DEFAULT_TIMEOUT_MS).coerceIn(1L, MAX_TIMEOUT_MS)

        val result = try {
            runProcess(baseDir, parsed.command, timeoutMs)
        } catch (t: Throwable) {
            return error("executeCode failed: ${t.message ?: t::class.simpleName}")
        }

        val payload = ExecuteCodeResult(
            stdout = result.stdout,
            stderr = result.stderr,
            exitCode = result.exitCode,
            timedOut = result.timedOut,
        )
        return CallToolResult(
            content = listOf(TextContent(text = json.encodeToString(ExecuteCodeResult.serializer(), payload))),
            isError = result.exitCode != 0 || result.timedOut,
        )
    }

    private data class ProcessOutcome(
        val stdout: String,
        val stderr: String,
        val exitCode: Int,
        val timedOut: Boolean,
    )

    private fun runProcess(cwd: File, command: String, timeoutMs: Long): ProcessOutcome {
        val pb = ProcessBuilder("/bin/sh", "-c", command)
            .directory(cwd)
            .redirectErrorStream(false)
        val proc = pb.start()

        val stdoutThread = Thread { /* drain */ proc.inputStream.readBytes() }.apply { isDaemon = true; start() }
        val stderrThread = Thread { /* drain */ proc.errorStream.readBytes() }.apply { isDaemon = true; start() }

        val finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            proc.destroyForcibly()
            stdoutThread.join(1_000)
            stderrThread.join(1_000)
            val stdout = proc.inputStream.readBytes().toTruncatedString()
            val stderr = proc.errorStream.readBytes().toTruncatedString()
            return ProcessOutcome(stdout, stderr, exitCode = -1, timedOut = true)
        }

        stdoutThread.join(1_000)
        stderrThread.join(1_000)
        val stdout = proc.inputStream.readBytes().toTruncatedString()
        val stderr = proc.errorStream.readBytes().toTruncatedString()
        return ProcessOutcome(stdout, stderr, proc.exitValue(), timedOut = false)
    }

    private fun ByteArray.toTruncatedString(): String {
        if (size <= MAX_OUTPUT_BYTES) return toString(Charsets.UTF_8)
        val head = copyOfRange(0, MAX_OUTPUT_BYTES).toString(Charsets.UTF_8)
        return head + "\n...[truncated ${size - MAX_OUTPUT_BYTES} bytes]"
    }

    private fun error(message: String): CallToolResult =
        CallToolResult(content = listOf(TextContent(text = message)), isError = true)
}

// ---------------------------------------------------------------------------
// Tool arg + result models
// ---------------------------------------------------------------------------

@Serializable
data class ExecuteCodeToolArgs(
    val command: String,
    val cwd: String? = null,
    val timeoutMs: Long? = null,
)

@Serializable
data class DiagnosticEntry(
    val uri: String,
    val severity: String,    // "error" | "warning" | "weak_warning" | "info" | "other"
    val message: String,
    val startLine: Int,
    val startColumn: Int,
    val endLine: Int,
    val endColumn: Int,
)

@Serializable
data class GetDiagnosticsResult(
    val entries: List<DiagnosticEntry> = emptyList(),
)

@Serializable
data class ExecuteCodeResult(
    val stdout: String,
    val stderr: String,
    val exitCode: Int,
    val timedOut: Boolean,
)
