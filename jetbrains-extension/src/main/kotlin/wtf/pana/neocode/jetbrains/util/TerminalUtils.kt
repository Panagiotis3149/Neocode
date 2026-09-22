package wtf.pana.neocode.jetbrains.util

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ToolWindowAnchor
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Helpers for Neocode CLI integration.
 *
 * - resolveNeocodeBinaryPath(): Locate the `neocode` executable (for terminal action).
 * - openNeocodeInTerminal(): Open Neocode CLI in an IDE terminal tab.
 */
object TerminalUtils {
    private val log = logger<TerminalUtils>()

    /**
     * Resolve the `neocode` executable path for the current OS.
     * Returns null if not found.
     *
     * Lookup order:
     *   1. `NEOCODE_BIN` env var (if set and executable)
     *   2. PATH lookup (OS-aware extension)
     *   3. Common install locations
     */
    fun resolveNeocodeBinaryPath(): String? {
        System.getenv("NEOCODE_BIN")?.takeIf { Files.isExecutable(Paths.get(it)) }?.let { return it }

        // PATH lookup: try each candidate extension (Windows dev installs ship as
        // neocode.exe; npm-global shims are neocode.cmd; bare `neocode` on *nix).
        binaryCandidates().forEach { name ->
            findInPath(name)?.let { return it }
        }

        // Fallback: shell out to `where neocode` (Windows) or `which neocode` (*nix)
        // This catches cases where PATH is resolvable by the shell but not by our
        // manual PATH split (e.g., PATH entries with trailing spaces, symlinks, etc.).
        resolveViaWhichOrWhere()?.let { return it }

        return KNOWN_INSTALL_PATHS.asSequence()
            .flatMap { dir -> binaryCandidates().map { name -> Paths.get(dir, name) } }
            .firstOrNull { Files.isExecutable(it) }
            ?.toString()
    }

    fun buildTerminalCommand(binaryPath: String): List<String> {
        if (!isWindows()) return listOf(binaryPath)

        val escapedPath = binaryPath.replace("\"", "\\\"")
        return listOf("cmd.exe", "/d", "/s", "/c", "\"$escapedPath\"")
    }

    /**
     * OS-aware executable name candidates, in preference order.
     * On Windows: native installs ship `neocode.exe`, npm-global shims are `neocode.cmd`,
     * and bare `neocode` works under WSL/git-bash PATH entries.
     * On *nix: only `neocode` (no extension).
     */
    private fun binaryCandidates(): List<String> =
        if (isWindows()) listOf("neocode.exe", "neocode.cmd", "neocode.bat", "neocode")
        else listOf("neocode")

    /** Kept for backward compatibility; prefer [binaryCandidates]. */
    private fun binaryName(): String = binaryCandidates().first()

    /** Linear PATH search. Splits `PATH` and tests each entry with [Files.isExecutable]. */
    private fun findInPath(name: String): String? {
        val pathEnv = System.getenv("PATH") ?: return null
        val separator = if (isWindows()) ';' else ':'
        return pathEnv.split(separator)
            .asSequence()
            .map { Paths.get(it, name) }
            .firstOrNull { Files.isExecutable(it) }
            ?.toString()
    }

    /**
     * Fallback: shell out to `where neocode` (Windows) or `which neocode` (Unix).
     * IntelliJ's `findInPath` / manual PATH split sometimes misses PATH entries that
     * the actual shell resolves correctly (e.g. trailing spaces, App Paths registry
     * entries on Windows). This is the last resort before KNOWN_INSTALL_PATHS.
     */
    private fun resolveViaWhichOrWhere(): String? {
        return try {
            val cmd = if (isWindows()) listOf("where", "neocode") else listOf("which", "neocode")
            val proc = ProcessBuilder(cmd)
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().readText().trim()
            if (proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) && proc.exitValue() == 0 && output.isNotEmpty()) {
                val candidates = output.lines().map { it.trim() }.filter { it.isNotEmpty() }

                // Multiple installations: prefer .exe over .cmd (real binary over shim),
                // then prefer the install under HOME (dev/global install) over system paths.
                val selected = candidates
                    .minWithOrNull(compareBy<String> { path ->
                        // Prefer .exe over .cmd/.bat (real binary vs npm shim)
                        when {
                            path.endsWith(".exe", ignoreCase = true) -> 0
                            path.endsWith(".cmd", ignoreCase = true) -> 1
                            path.endsWith(".bat", ignoreCase = true) -> 2
                            else -> 3
                        }
                    }.thenBy { path ->
                        // Prefer user-local paths (AppData, ~\.bun, etc.) over system (Program Files, System32)
                        if (path.contains("bun", ignoreCase = true) ||
                            path.contains("AppData", ignoreCase = true) ||
                            path.contains("Users", ignoreCase = true)) 0 else 1
                    })
                log.info("resolveViaWhichOrWhere resolved neocode to: $selected (from ${candidates.size} candidates)")
                selected
            } else {
                null
            }
        } catch (e: Exception) {
            log.warn("resolveViaWhichOrWhere failed", e)
            null
        }
    }

    /** Default search dirs beyond PATH. Conservative hints only. */
    private val KNOWN_INSTALL_PATHS: List<String>
        get() {
            val home = System.getProperty("user.home") ?: ""
            return if (isWindows()) {
                val local = System.getenv("LOCALAPPDATA") ?: "$home\\AppData\\Local"
                val programFiles = System.getenv("ProgramFiles") ?: "C:\\Program Files"
                listOf(
                    "$home\\.bun\\bin",                    // `bun install -g` / dev installs
                    "$local\\Programs\\Neocode",
                    "$local\\Microsoft\\WindowsApps",
                    "$programFiles\\Neocode",
                    "$home\\AppData\\Roaming\\npm",        // npm-global shims (neocode.cmd)
                )
            } else {
                listOf(
                    "/usr/local/bin",
                    "$home/.local/bin",
                    "$home/.cargo/bin",
                    "/opt/neocode/bin",
                )
            }
        }

    private fun isWindows(): Boolean =
        System.getProperty("os.name")?.startsWith("Windows") == true

    /**
     * Check whether a path is executable. Wraps [Files.isExecutable] to
     * swallow platform-specific permission glitches.
     */
    fun isExecutable(path: Path): Boolean = runCatching { Files.isExecutable(path) }.getOrDefault(false)

    /**
     * Open Neocode CLI in an IDE terminal tab.
     * Called from [OpenClaudeInTerminalAction].
     */
    fun openNeocodeInTerminal(project: Project) {
        val binPath = resolveNeocodeBinaryPath()
            ?: throw IllegalStateException("neocode binary not found")

        val terminalToolWindow = ToolWindowManager.getInstance(project).getToolWindow("Terminal")
        terminalToolWindow?.activate {
            // Use the terminal API to create a new session with `neocode`
            // Note: This is a simplified approach; the actual API depends on
            // the Terminal plugin being enabled. For 2024.2+, we can use
            // TerminalManager.createSession().
            try {
                val terminalManagerClass = Class.forName("com.intellij.terminal.TerminalManager")
                val terminalManager = terminalManagerClass.getMethod("getInstance", Project::class.java)
                    .invoke(null, project)
                val createSession = terminalManagerClass.getMethod("createSession")
                val session = createSession.invoke(terminalManager)
                val startMethod = session.javaClass.getMethod("start")
                startMethod.invoke(session)
                val setNameMethod = session.javaClass.getMethod("setName", String::class.java)
                setNameMethod.invoke(session, "Neocode")
                val sendTextMethod = session.javaClass.getMethod("sendText", String::class.java, Boolean::class.java)
                sendTextMethod.invoke(session, "$binPath\n", true)
            } catch (e: ClassNotFoundException) {
                log.warn("Terminal plugin not available; falling back to tool window activation")
                // Fallback: just activate the terminal tool window
                terminalToolWindow.activate(null)
            } catch (e: Exception) {
                log.warn("Failed to create terminal session", e)
                terminalToolWindow.activate(null)
            }
        }
    }
}
