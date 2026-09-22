package wtf.pana.neocode.jetbrains.services

import java.net.InetSocketAddress
import java.nio.channels.AsynchronousServerSocketChannel
import java.nio.channels.AsynchronousSocketChannel
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout

/**
 * Tests [MCPService.sendRequest] routing: when a session is parked in
 * `openSessions`, calling `sendRequest` on the service must round-trip a
 * JSON-RPC request/response through that session.
 */
class MCPServiceSendRequestTest {

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    fun `sendRequest routes through an open session and returns the result`() {
        val serverChannel = AsynchronousServerSocketChannel.open()
            .bind(InetSocketAddress("127.0.0.1", 0))
        val port = (serverChannel.localAddress as InetSocketAddress).port
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            // Server side (peer of the IDE-side session): accept + handshake,
            // then loop replying to "listSessions" with a stub result.
            val serverAccept = scope.async {
                val ch = serverChannel.accept().get()
                val session = WSSession(ch)
                session.performHandshake()
                session
            }
            val clientCh = AsynchronousSocketChannel.open()
            clientCh.connect(InetSocketAddress("127.0.0.1", port)).get()
            val clientSession = WSSession(clientCh)
            clientSession.performClientHandshake(port = port)
            val server = kotlinx.coroutines.runBlocking { serverAccept.await() }

            val serverLoopJob = scope.launch {
                server.readLoop(
                    onRequest = { req ->
                        wtf.pana.neocode.jetbrains.tools.JsonRpcResponse(
                            id = req.id,
                            result = buildJsonObject {
                                put("ok", true)
                                put("via", "mcpService")
                            }
                        )
                    },
                    onResponse = { /* peer does not issue sendRequest */ }
                )
            }
            val clientLoopJob = scope.launch {
                clientSession.readLoop(
                    onRequest = { null },
                    onResponse = { /* no-op */ },
                )
            }

            try {
                // Manually register the client session into a service instance.
                val service = MCPService()
                // Inject the session via the public test hook.
                service.injectSessionForTest(clientSession)

                val result: JsonObject = service.sendRequest(
                    method = "listSessions",
                    params = buildJsonObject { put("limit", 100) },
                    timeoutMs = 10_000L,
                )

                assertEquals(JsonPrimitive(true), result["ok"])
                assertEquals(JsonPrimitive("mcpService"), result["via"])
            } finally {
                clientLoopJob.cancel()
                serverLoopJob.cancel()
                clientSession.close()
                server.close()
            }
        } finally {
            scope.cancel()
            serverChannel.close()
        }
    }
}
