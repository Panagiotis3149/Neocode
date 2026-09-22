package wtf.pana.neocode.jetbrains.services

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.security.SecureRandom

/**
 * Lockfile management for the Neocode IDE plugin.
 *
 * Format mirrors the Claude Code spec so Neocode's existing detection logic
 * (see src/utils/jetbrains.ts in the Neocode repo) works unmodified:
 *
 *   ~/.claude/ide/{port}.lock
 *
 * Content (JSON):
 *   {
 *     "transport": "ws",
 *     "port": 12345,
 *     "pid": <ide process id>,
 *     "ideName": "intellij" | "webstorm" | ...,
 *     "workspaceFolders": [<list of open project base dirs>],
 *     "runningInWindows": true | false,
 *     "authToken": "<optional bearer token>"
 *   }
 */
object ServerPortUtil {
    private const val IDE_DIR_NAME = ".claude"
    private const val IDE_SUBDIR = "ide"
    const val TRANSPORT_WS = "ws"

    /**
     * Find a free TCP port on localhost.
     *
     * Implementation: bind a [ServerSocket] on port 0 (OS-assigned), read the assigned
     * port, then close. The kernel won't immediately reuse the port — there is a small
     * race window during the close() → start(server) gap. For local loopback usage
     * (localhost MCP, single-user IDE) this is acceptable. If a race is observed,
     * switch to retries with a fallback port range.
     */
    fun findFreePort(): Int {
        ServerSocket(0).use { socket ->
            return socket.localPort
        }
    }

    /**
     * Generate a 32-byte (64 hex chars) bearer token for the X-Claude-Code-Ide-Authorization header.
     */
    fun generateAuthToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString(separator = "") { "%02x".format(it) }
    }

    /**
     * Write the lockfile for [port] with the given metadata, creating ~/.claude/ide/
     * if it doesn't exist. Returns the written [Path].
     */
    fun writeLockfile(
        port: Int,
        ideName: String,
        pid: Long,
        workspaceFolders: List<String>,
        authToken: String? = null,
    ): Path {
        val dir = ideDir()
        Files.createDirectories(dir)

        val payload = buildJsonObject {
            put("transport", JsonPrimitive(TRANSPORT_WS))
            put("port", JsonPrimitive(port))
            put("pid", JsonPrimitive(pid))
            put("ideName", JsonPrimitive(ideName))
            put("workspaceFolders", buildJsonArray {
                workspaceFolders.forEach { add(JsonPrimitive(it)) }
            })
            put("runningInWindows", JsonPrimitive(isWindows()))
            if (authToken != null) {
                put("authToken", JsonPrimitive(authToken))
            }
        }

        val lockPath = dir.resolve("$port.lock")
        Files.writeString(lockPath, Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), payload))
        return lockPath
    }

    /**
     * Remove the lockfile for [port] (idempotent).
     */
    fun deleteLockfile(port: Int) {
        val lockPath = ideDir().resolve("$port.lock")
        runCatching { Files.deleteIfExists(lockPath) }
    }

    private fun ideDir(): Path {
        val home = System.getProperty("user.home")
            ?: error("user.home not set; cannot determine ~/.claude/ide location")
        return Paths.get(home, IDE_DIR_NAME, IDE_SUBDIR)
    }

    private fun isWindows(): Boolean {
        val os = System.getProperty("os.name") ?: return false
        return os.lowercase().contains("windows")
    }
}
