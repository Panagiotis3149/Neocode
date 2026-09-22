package wtf.pana.neocode.jetbrains.services

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ProtocolException
import java.nio.ByteBuffer
import java.nio.channels.AsynchronousSocketChannel
import java.nio.channels.ClosedChannelException
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import wtf.pana.neocode.jetbrains.tools.JsonRpcRequest
import wtf.pana.neocode.jetbrains.tools.JsonRpcResponse

/**
 * Minimal RFC 6455 WebSocket session over a single [AsynchronousSocketChannel].
 *
 * Implements only what Neocode's MCP client needs:
 *   - Server-side handshake (parse client `Upgrade` request, send `101 Switching Protocols`)
 *   - Server-side frame parsing (FIN, opcode, masked=false check, payload length)
 *   - Text frames routed to a `dispatch` callback
 *   - Single-frame text responses written back
 *
 * Does NOT implement:
 *   - Continuation frames (Neocode always sends one text frame per message)
 *   - Ping/pong (passive — we don't initiate)
 *   - Per-message deflate (Neocode doesn't negotiate it)
 */
class WSSession(private val channel: AsynchronousSocketChannel) {
    private val json = Json { ignoreUnknownKeys = true }
    private val closed = AtomicBoolean(false)
    private val handshakeDone = AtomicBoolean(false)

    /**
     * Outstanding JSON-RPC requests sent via [sendRequest], keyed by their
     * string `id`. The read loop completes the matching future when a response
     * frame arrives.
     */
    private val outstandingRequests: MutableMap<String, CompletableFuture<JsonRpcResponse>> = ConcurrentHashMap()

    /** Serializes all outbound frame writes so concurrent senders don't interleave on the wire. */
    private val writeLock = Any()

    /** Perform server-side WS handshake: read HTTP request, send 101 response. */
    fun performHandshake() {
        val req = readHttpRequest()
        val headers = parseHeaders(req)
        val key = headers["sec-websocket-key"]
            ?: throw ProtocolException("Missing Sec-WebSocket-Key header")
        val accept = computeAccept(key)
        val expectedSubprotocol = headers["sec-websocket-protocol"]
        val subprotocolLine = if (expectedSubprotocol != null) "Sec-WebSocket-Protocol: mcp\r\n" else ""
        val response = (
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n" +
            subprotocolLine +
            "\r\n"
        )
        writeAll(response.toByteArray(Charsets.US_ASCII))
        handshakeDone.set(true)
    }

    /**
     * Client-side WS handshake: send HTTP Upgrade for a connection to a
     * server listening on [port], then read the 101 response. The peer's
     * `Sec-WebSocket-Accept` value is validated against the sent key.
     */
    fun performClientHandshake(port: Int) {
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also { java.security.SecureRandom().nextBytes(it) })
        val req = (
            "GET / HTTP/1.1\r\n" +
            "Host: 127.0.0.1:$port\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $key\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Protocol: mcp\r\n" +
            "\r\n"
        )
        writeAll(req.toByteArray(Charsets.US_ASCII))
        val resp = readHttpRequest()
        if (!resp.startsWith("HTTP/1.1 101")) {
            throw ProtocolException("Server did not switch protocols: ${resp.lineSequence().firstOrNull()}")
        }
        val headers = parseHeaders(resp)
        val accept = headers["sec-websocket-accept"]
            ?: throw ProtocolException("Missing Sec-WebSocket-Accept header")
        val expected = computeAccept(key)
        if (accept != expected) {
            throw ProtocolException("Sec-WebSocket-Accept mismatch")
        }
        handshakeDone.set(true)
    }

    /**
     * Send a JSON-RPC request and await the matching response.
     *
     * Generates a UUID string `id`, parks a [CompletableFuture] in
     * [outstandingRequests], writes the request frame, and blocks for at most
     * [timeoutMs]. On timeout the future is removed and an [IOException] is
     * thrown; the peer may still send a late response (which will be dropped
     * by the read loop).
     */
    fun sendRequest(
        method: String,
        params: JsonObject,
        timeoutMs: Long = 20_000L,
    ): JsonRpcResponse {
        val id = UUID.randomUUID().toString()
        val request = JsonRpcRequest(
            id = JsonPrimitive(id),
            method = method,
            params = params,
        )
        val future = CompletableFuture<JsonRpcResponse>()
        outstandingRequests[id] = future
        val frame = json.encodeToString(JsonRpcRequest.serializer(), request)
        try {
            synchronized(writeLock) {
                writeTextFrame(frame)
            }
        } catch (e: Throwable) {
            outstandingRequests.remove(id)
            throw e
        }
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
                ?: throw IOException("sendRequest returned null future for id=$id")
        } catch (e: java.util.concurrent.TimeoutException) {
            outstandingRequests.remove(id)
            throw IOException("Timed out waiting for response to $method (id=$id)", e)
        } catch (e: java.util.concurrent.ExecutionException) {
            outstandingRequests.remove(id)
            throw (e.cause as? IOException) ?: IOException("sendRequest failed for $method", e)
        } catch (e: InterruptedException) {
            outstandingRequests.remove(id)
            Thread.currentThread().interrupt()
            throw IOException("Interrupted waiting for response to $method (id=$id)", e)
        }
    }

    /**
     * Loop: read frames, dispatch text frames to either [onRequest] (incoming
     * request — has `method`) or [onResponse] (incoming response — has `result`
     * or `error` and matches a parked [sendRequest] future). Write any
     * non-null response returned by [onRequest]. Terminates on EOF, frame
     * error, or `close()`.
     */
    fun readLoop(
        onRequest: (JsonRpcRequest) -> JsonRpcResponse? = { null },
        onResponse: (JsonRpcResponse) -> Unit = {},
    ) {
        while (!closed.get()) {
            try {
                val (opcode, payload) = readFrame()
                when (opcode) {
                    OPCODE_TEXT -> {
                        val text = payload.toString(Charsets.UTF_8)
                        // Peek at the JSON object's keys to decide request vs response:
                        // requests carry `method`, responses carry `result` or `error`.
                        // Both carry `id`. We try response first because responses have
                        // a parked future only when sent via sendRequest; if no future is
                        // parked under the id, fall through to the request branch.
                        val parsed: JsonObject = json.parseToJsonElement(text).jsonObject
                        val idElem = parsed["id"]
                        val idKey = idElem?.let { idKeyOf(it) }
                        if (idKey != null && ("result" in parsed || "error" in parsed) && outstandingRequests.containsKey(idKey)) {
                            val resp = json.decodeFromString(JsonRpcResponse.serializer(), text)
                            val fut = outstandingRequests.remove(idKey)
                            fut?.complete(resp)
                            onResponse(resp)
                        } else {
                            val req = json.decodeFromString(JsonRpcRequest.serializer(), text)
                            val resp = onRequest(req)
                            if (resp != null) {
                                val out = json.encodeToString(JsonRpcResponse.serializer(), resp)
                                synchronized(writeLock) { writeTextFrame(out) }
                            }
                        }
                    }
                    OPCODE_CLOSE -> {
                        close()
                        return
                    }
                    OPCODE_PING -> {
                        synchronized(writeLock) { writeFrame(OPCODE_PONG, payload) }
                    }
                    OPCODE_PONG -> { /* ignore */ }
                    else -> throw ProtocolException("Unsupported opcode: $opcode")
                }
            } catch (e: ClosedChannelException) {
                return
            } catch (e: IOException) {
                return
            }
        }
    }

    fun close() {
        if (closed.compareAndSet(false, true)) {
            try {
                channel.close()
            } catch (_: Throwable) { /* ignore */ }
            // Fail any parked sendRequest futures so callers don't hang.
            val ex = IOException("WSSession closed")
            outstandingRequests.values.forEach { it.completeExceptionally(ex) }
            outstandingRequests.clear()
        }
    }

    /** Extracts a string map key from an `id` [JsonElement] (string/number). */
    private fun idKeyOf(id: JsonElement): String? = when (id) {
        is JsonPrimitive -> id.content
        else -> null
    }

    // ---- HTTP handshake helpers ----

    private fun readHttpRequest(): String {
        val buf = ByteArray(2048)
        val builder = StringBuilder()
        var total = 0
        while (total < 65536) {
            val n = channel.read(ByteBuffer.wrap(buf)).get()
            if (n <= 0) throw IOException("EOF during HTTP handshake")
            builder.append(String(buf, 0, n, Charsets.US_ASCII))
            total += n
            if (builder.contains("\r\n\r\n")) return builder.toString()
        }
        throw IOException("HTTP request too large")
    }

    private fun parseHeaders(req: String): Map<String, String> {
        val lines = req.split("\r\n").drop(1).takeWhile { it.isNotEmpty() }
        val map = mutableMapOf<String, String>()
        for (line in lines) {
            val idx = line.indexOf(':')
            if (idx < 0) continue
            val key = line.substring(0, idx).trim().lowercase()
            val value = line.substring(idx + 1).trim()
            map[key] = value
        }
        return map
    }

    private fun computeAccept(key: String): String {
        val magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        val digest = MessageDigest.getInstance("SHA-1").digest((key + magic).toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(digest)
    }

    private fun writeAll(bytes: ByteArray) {
        val buf = ByteBuffer.wrap(bytes)
        while (buf.hasRemaining()) {
            channel.write(buf).get()
        }
    }

    /**
     * Public entry point for outbound text frames (used by [MCPService] to push
     * notifications to Neocode). Safe to call from any thread.
     */
    fun sendText(text: String) {
        synchronized(writeLock) { writeTextFrame(text) }
    }

    // ---- Frame I/O ----

    private data class Frame(val opcode: Int, val payload: ByteArray)

    /** Read a single WS frame. Throws on protocol error or EOF. */
    private fun readFrame(): Frame {
        val header = readBytes(2)
        val fin = (header[0].toInt() and 0x80) != 0
        val opcode = header[0].toInt() and 0x0F
        val masked = (header[1].toInt() and 0x80) != 0
        val lenField = header[1].toInt() and 0x7F
        if (!fin) throw ProtocolException("Fragmented frames not supported")
        if (masked) throw ProtocolException("Client frames must be masked, but received unmasked")

        val len: Long = when (lenField) {
            in 0..125 -> lenField.toLong()
            126 -> {
                val ext = readBytes(2)
                ((ext[0].toInt() and 0xFF) shl 8 or (ext[1].toInt() and 0xFF)).toLong()
            }
            127 -> {
                val ext = readBytes(8)
                var v = 0L
                for (b in ext) v = (v shl 8) or (b.toLong() and 0xFF)
                v
            }
            else -> throw ProtocolException("Invalid length field: $lenField")
        }
        val payload = readBytes(len.toInt())
        return Frame(opcode, payload)
    }

    private fun readBytes(n: Int): ByteArray {
        val out = ByteArrayOutputStream(n)
        val buf: ByteBuffer = ByteBuffer.allocate(maxOf(4096, n))
        while (out.size() < n) {
            val need = n - out.size()
            buf.limit(need.coerceAtMost(buf.capacity()))
            buf.position(0)
            val read = channel.read(buf).get()
            if (read <= 0) throw IOException("EOF reading $n bytes (got ${out.size()})")
            buf.flip()
            val arr = ByteArray(read)
            buf.get(arr)
            buf.clear()
            out.write(arr)
        }
        return out.toByteArray()
    }

    /** Write a server→client text frame (server frames are NOT masked). */
    private fun writeTextFrame(text: String) {
        writeFrame(OPCODE_TEXT, text.toByteArray(Charsets.UTF_8))
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val header = ByteArray(2)
        header[0] = (0x80 or (opcode and 0x0F)).toByte() // FIN=1
        val len = payload.size
        if (len < 126) {
            header[1] = (len and 0x7F).toByte()
        } else if (len < 65536) {
            header[1] = 126.toByte()
        } else {
            header[1] = 127.toByte()
        }
        val out = ByteArrayOutputStream(header.size + (if (len >= 126) (if (len >= 65536) 8 else 2) else 0) + len)
        out.write(header)
        if (len >= 126 && len < 65536) {
            out.write(byteArrayOf(((len shr 8) and 0xFF).toByte(), (len and 0xFF).toByte()))
        } else if (len >= 65536) {
            for (i in 7 downTo 0) out.write(((len shr (i * 8)) and 0xFF).toByte().toInt())
        }
        out.write(payload)
        writeAll(out.toByteArray())
    }

    companion object {
        const val OPCODE_CONTINUATION = 0x0
        const val OPCODE_TEXT = 0x1
        const val OPCODE_BINARY = 0x2
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xA
    }
}
