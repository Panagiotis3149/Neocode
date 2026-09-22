package wtf.pana.neocode.jetbrains.services

import java.io.IOException
import java.net.InetSocketAddress
import java.nio.channels.AsynchronousServerSocketChannel
import java.nio.channels.AsynchronousSocketChannel
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import wtf.pana.neocode.jetbrains.tools.JsonRpcResponse

/**
 * Round-trip tests for [WSSession.sendRequest] + [WSSession.readLoop] response
 * dispatch. Spins up a real loopback WebSocket pair (server + client) so the
 * handshake, frame write, and frame read paths are exercised end-to-end.
 *
 * All coroutines run on [Dispatchers.IO] so the blocking nio `.get()` calls and
 * the blocking [WSSession.readLoop] in the background never deadlock the
 * foreground `sendRequest` call.
 */
class WSSessionTest {

    /**
     * Client sends `sendRequest` with method "listSessions"; server's
     * `onRequest` returns a stub response carrying the request's id + a
     * `result`. Client's `readLoop` receives the response, completes the
     * parked future, and `sendRequest` returns.
     */
    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    fun `sendRequest sends id-bearing JSON-RPC and readLoop dispatches response to pending future`() {
        val serverChannel = AsynchronousServerSocketChannel.open()
            .bind(InetSocketAddress("127.0.0.1", 0))
        val port = (serverChannel.localAddress as InetSocketAddress).port

        // Dedicated IO scope so each blocking call runs on its own thread.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            val serverAccept = scope.async {
                val ch = serverChannel.accept().get()
                val session = WSSession(ch)
                session.performHandshake()
                session
            }
            val clientCh = AsynchronousSocketChannel.open()
            clientCh.connect(InetSocketAddress("127.0.0.1", port)).get()
            val client = WSSession(clientCh)
            client.performClientHandshake(port = port)
            val server = runBlocking { serverAccept.await() }

            // Server loop: echo a stub response for each request.
            val serverLoopJob: Job = scope.launch {
                server.readLoop(
                    onRequest = { req ->
                        JsonRpcResponse(
                            id = req.id,
                            result = buildJsonObject {
                                put("ok", true)
                                put("count", 0)
                            }
                        )
                    },
                    onResponse = { /* server does not issue sendRequest */ }
                )
            }
            // Client loop: route incoming responses to parked futures.
            val clientLoopJob: Job = scope.launch {
                client.readLoop(
                    onRequest = { null },
                    onResponse = { /* completion happens inside readLoop */ },
                )
            }

            val response: JsonRpcResponse = client.sendRequest(
                method = "listSessions",
                params = buildJsonObject { put("limit", 100) },
                timeoutMs = 10_000L,
            )

            assertNotNull(response.id, "Response must have an id")
            assertTrue(response.id is JsonPrimitive, "Response id must be JsonPrimitive")
            assertNotNull(response.result, "Response must carry a result")
            val resultObj = response.result as JsonObject
            assertEquals(JsonPrimitive(true), resultObj["ok"])
            assertEquals(JsonPrimitive(0), resultObj["count"])

            clientLoopJob.cancel()
            serverLoopJob.cancel()
            client.close()
            server.close()
        } finally {
            scope.cancel()
            serverChannel.close()
        }
    }

    /**
     * When the server side closes mid-request, the client's readLoop observes
     * the close, completes parked `sendRequest` futures exceptionally via
     * `WSSession.close()`, and `sendRequest` rethrows as `IOException`.
     */
    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    fun `sendRequest fails with IOException when session closes before response`() {
        val serverChannel = AsynchronousServerSocketChannel.open()
            .bind(InetSocketAddress("127.0.0.1", 0))
        val port = (serverChannel.localAddress as InetSocketAddress).port

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            val serverAccept = scope.async {
                val ch = serverChannel.accept().get()
                val session = WSSession(ch)
                session.performHandshake()
                session
            }
            val clientCh = AsynchronousSocketChannel.open()
            clientCh.connect(InetSocketAddress("127.0.0.1", port)).get()
            val client = WSSession(clientCh)
            client.performClientHandshake(port = port)
            val server = runBlocking { serverAccept.await() }

            val clientLoopJob: Job = scope.launch {
                client.readLoop(
                    onRequest = { null },
                    onResponse = { /* no-op */ },
                )
            }

            // Close server immediately — no onRequest reply.
            server.close()
            // Give the client readLoop a beat to notice the channel close.
            Thread.sleep(200)

            var threw = false
            try {
                client.sendRequest(
                    method = "ping",
                    params = JsonObject(emptyMap()),
                    timeoutMs = 3_000L,
                )
            } catch (e: IOException) {
                threw = true
            }
            assertTrue(threw, "sendRequest must throw IOException when session closes before a response arrives")

            clientLoopJob.cancel()
            client.close()
        } finally {
            scope.cancel()
            serverChannel.close()
        }
    }
}
