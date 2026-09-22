package wtf.pana.neocode.jetbrains.util

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

/**
 * Generic JSON helpers used by the session RPC layer. Centralizes the
 * tolerance policy (`ignoreUnknownKeys = true`) so callers don't each
 * reconfigure a [Json] instance.
 */
object JsonExtensions {

    /** Shared tolerant Json — drops unknown keys, allows nullable fields. */
    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = false
    }

    /** Decode a [JsonElement] into [T] using [JsonExtensions.json]. */
    inline fun <reified T> decode(element: JsonElement): T =
        json.decodeFromJsonElement(serializerFor(), element)

    /** Convenience: decode a [JsonObject] field into [T] or return null if absent. */
    inline fun <reified T> decodeField(obj: JsonObject, key: String): T? {
        val element = obj[key] ?: return null
        return runCatching { decode<T>(element) }.getOrNull()
    }

    /** Pull a nullable string from a JSON object field. */
    fun stringField(obj: JsonObject, key: String): String? =
        (obj[key] as? JsonPrimitive)?.contentOrNull

    /** Pull a nullable long from a JSON object field. */
    fun longField(obj: JsonObject, key: String): Long? =
        (obj[key] as? JsonPrimitive)?.longOrNull

    /** Pull a nullable boolean from a JSON object field. */
    fun boolField(obj: JsonObject, key: String): Boolean? =
        (obj[key] as? JsonPrimitive)?.booleanOrNull

    /** Pull a nested object field, or null if absent/not-an-object. */
    fun objectField(obj: JsonObject, key: String): JsonObject? =
        obj[key] as? JsonObject

    /** Pull a nested array field, or null if absent/not-an-array. */
    fun arrayField(obj: JsonObject, key: String): JsonArray? =
        obj[key] as? JsonArray

    /**
     * Decode any [JsonElement] using a reified serializer. Reified because
     * `serializerFor()` is reified; broken out as a public function for
     * non-inline callers.
     */
    @PublishedApi
    internal inline fun <reified T> serializerFor(): KSerializer<T> =
        serializer<T>()
}
