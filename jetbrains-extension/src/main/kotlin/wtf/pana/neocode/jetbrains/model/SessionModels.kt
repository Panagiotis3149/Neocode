package wtf.pana.neocode.jetbrains.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray

/**
 * Mirror of the Neocode CLI `SessionInfo` type defined at
 * `src/utils/listSessionsImpl.ts:33`. Fields are nullable on the Kotlin side
 * because the CLI may omit any of them depending on session contents and
 * `listSessionsImpl` filtering.
 */
@Serializable
data class SessionInfo(
    @SerialName("sessionId") val sessionId: String,
    @SerialName("summary") val summary: String? = null,
    @SerialName("lastModified") val lastModified: Long = 0L,
    @SerialName("fileSize") val fileSize: Long? = null,
    @SerialName("customTitle") val customTitle: String? = null,
    @SerialName("firstPrompt") val firstPrompt: String? = null,
    @SerialName("gitBranch") val gitBranch: String? = null,
    @SerialName("cwd") val cwd: String? = null,
    @SerialName("tag") val tag: String? = null,
    /** Epoch ms — from first entry's ISO timestamp. Undefined if unparseable. */
    @SerialName("createdAt") val createdAt: Long? = null,
)

/** Wrapper returned by `listSessions` JSON-RPC. */
@Serializable
data class ListSessionsResult(
    val sessions: List<SessionInfo> = emptyList(),
)

/** Wrapper returned by `createSession` JSON-RPC. */
@Serializable
data class CreateSessionResult(
    val sessionId: String,
)

/** Wrapper returned by `switchSession` JSON-RPC. */
@Serializable
data class SwitchSessionResult(
    val sessionId: String,
    /** whether the CLI had to spawn a new process vs just switching focus */
    val started: Boolean = false,
)

/** Wrapper returned by `deleteSession` JSON-RPC. */
@Serializable
data class DeleteSessionResult(
    val ok: Boolean = true,
    /** where the file was moved (recycle bin path) */
    val movedTo: String? = null,
)

/** Wrapper returned by `shareSession` JSON-RPC. */
@Serializable
data class ShareSessionResult(
    val ok: Boolean = true,
    val url: String? = null,
)

/** Wrapper returned by `unshareSession` JSON-RPC. */
@Serializable
data class UnshareSessionResult(
    val ok: Boolean = true,
)
