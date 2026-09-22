package wtf.pana.neocode.jetbrains.tools

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * JSON-RPC / MCP data models for tool arguments and results.
 *
 * All field names use snake_case to match the Neocode CLI's RPC schema
 * (see src/hooks/useDiffInIDE.ts and src/services/diagnosticTracking.ts).
 */

@Serializable
data class OpenDiffToolArgs(
    val old_file_path: String,
    val new_file_path: String,
    val new_file_contents: String,
    val tab_name: String,
)

@Serializable
data class CloseTabToolArgs(
    val tab_name: String,
)

@Serializable
data class OpenFileToolArgs(
    val filePath: String,
    val preview: Boolean = false,
    val startText: String? = null,
    val endText: String? = null,
    val selectToEndOfLine: Boolean = false,
    val makeFrontmost: Boolean = false,
)

@Serializable
data class GetDiagnosticsToolArgs(
    val uri: String? = null,  // "file://..." or null for all files
)

/**
 * Result of an MCP tool call. Mirrors the upstream `CallToolResult` shape
 * used in `DiffTools.addTools()` — content is a list of `TextContent` blocks.
 */
@Serializable
data class CallToolResult(
    val content: List<TextContent> = emptyList(),
    val isError: Boolean = false,
)

@Serializable
data class TextContent(
    val type: String = "text",
    val text: String,
)

/**
 * MCP protocol version advertised during `initialize` handshake.
 */
const val MCP_PROTOCOL_VERSION: String = "2024-11-05"

/**
 * Server info payload returned by `initialize`.
 */
@Serializable
data class ServerInfo(
    val name: String = "neocode-jetbrains",
    val version: String = "0.1.0",
)

@Serializable
data class InitializeResult(
    val protocolVersion: String,
    val capabilities: ServerCapabilities,
    val serverInfo: ServerInfo,
)

@Serializable
data class ServerCapabilities(
    val tools: ToolsCapability = ToolsCapability(),
)

@Serializable
data class ToolsCapability(
    val listChanged: Boolean = false,
)

/**
 * Registration record for one MCP tool. Mirrors the shape used by upstream
 * `DiffTools.addTools()`: each tool has a name, description, JSON-Schema
 * string for its input, and a handler that takes the deserialized args
 * and returns a [CallToolResult].
 */
data class ToolDef(
    val name: String,
    val description: String,
    val inputSchema: String,
    val handler: (JsonElement?) -> CallToolResult,
)

/**
 * A JSON-RPC 2.0 request envelope.
 */
@Serializable
data class JsonRpcRequest(
    val jsonrpc: String = "2.0",
    val id: JsonElement? = null,
    val method: String,
    val params: JsonElement? = null,
)

/**
 * A JSON-RPC 2.0 response envelope.
 */
@Serializable
data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: JsonElement? = null,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null,
)

@Serializable
data class JsonRpcError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null,
) {
    companion object {
        const val PARSE_ERROR = -32700
        const val INVALID_REQUEST = -32600
        const val METHOD_NOT_FOUND = -32601
        const val INVALID_PARAMS = -32602
        const val INTERNAL_ERROR = -32603
    }
}

/**
 * Minimal JSON-Schema generator placeholder. Real implementation in
 * milestone 3 (DiffTools needs `OpenDiffToolArgs` to map to a schema).
 *
 * For now, returns a permissive schema that accepts any object.
 */
fun argsClassToToolInputSchema(@Suppress("UNUSED_PARAMETER") klass: kotlin.reflect.KClass<*>): String {
    return """{"type":"object","additionalProperties":true}"""
}
