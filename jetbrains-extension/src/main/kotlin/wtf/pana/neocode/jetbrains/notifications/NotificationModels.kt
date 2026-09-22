package wtf.pana.neocode.jetbrains.notifications

import kotlinx.serialization.Serializable

/**
 * Data models for IDE-side notifications.
 *
 * These mirror notification payloads received from Neocode via the
 * `mcp__ide__notify` notification (e.g. session lifecycle changes,
 * permission prompts). Not the same as the MCP RPC args themselves.
 *
 * TODO: flesh out once we know which notifications Neocode sends.
 */
@Serializable
data class NeocodeNotification(
    val type: String,           // "info" | "warning" | "error"
    val title: String,
    val content: String,
    val actionLabel: String? = null,
)
