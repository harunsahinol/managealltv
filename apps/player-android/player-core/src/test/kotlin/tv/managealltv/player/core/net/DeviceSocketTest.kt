package tv.managealltv.player.core.net

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import tv.managealltv.player.core.Fixtures
import tv.managealltv.player.core.net.DeviceSocket.ConnectionState
import tv.managealltv.player.core.protocol.Command
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.DeviceToServer
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.ServerToDevice
import tv.managealltv.player.core.util.ExponentialBackoff

class DeviceSocketTest {
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val status = ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), Fixtures.read("device-status.json"))
    private val listener = RecordingListener()
    private var socket: DeviceSocket? = null

    private class RecordingListener : DeviceSocket.Listener {
        val messages = LinkedBlockingQueue<ServerToDevice>()
        val states = CopyOnWriteArrayList<ConnectionState>()

        override fun onMessage(message: ServerToDevice) {
            messages += message
        }

        override fun onStateChanged(state: ConnectionState) {
            states += state
        }
    }

    /** The server end of one WebSocket connection. */
    private open class ServerEnd : WebSocketListener() {
        val opened = LinkedBlockingQueue<WebSocket>()
        val received = LinkedBlockingQueue<String>()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            opened += webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received += text
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        fun awaitOpen(): WebSocket = assertNotNull(opened.poll(5, TimeUnit.SECONDS), "connection did not open")

        fun nextMessage(): DeviceToServer {
            val text = assertNotNull(received.poll(5, TimeUnit.SECONDS), "no message from the device")
            return ProtocolJson.strict.decodeFromString(DeviceToServer.serializer(), text)
        }
    }

    @BeforeEach
    fun setUp() {
        server.start()
    }

    @AfterEach
    fun tearDown() {
        socket?.stop()
        scope.cancel()
        server.shutdown()
    }

    private fun start(
        token: String? = "mtv_d_token",
        heartbeatMs: Long = 60_000,
        fallback: StatusFallback? = null,
    ): DeviceSocket {
        val config =
            DeviceSocket.Config(
                heartbeatIntervalMs = heartbeatMs,
                backoff = ExponentialBackoff(initialDelayMs = 50, maxDelayMs = 200, jitterRatio = 0.0),
            )
        return DeviceSocket(HttpClients.create(), server.url("/"), { token }, { status }, listener, scope, config, fallback)
            .also {
                socket = it
                it.start()
            }
    }

    private fun DeviceSocket.awaitState(expected: ConnectionState) =
        runBlocking { withTimeout(5_000) { state.first { it == expected } } }

    @Test
    fun `connects with the bearer token, reports status first and delivers messages`() {
        val end = ServerEnd()
        server.enqueue(MockResponse().withWebSocketUpgrade(end))
        val socket = start()

        val ws = end.awaitOpen()
        assertEquals(DeviceToServer.StatusMessage(status), end.nextMessage())
        val upgrade = server.takeRequest()
        assertEquals("/api/device/v1/ws", upgrade.path)
        assertEquals("Bearer mtv_d_token", upgrade.getHeader("Authorization"))
        socket.awaitState(ConnectionState.CONNECTED)

        ws.send("""{"type":"manifest_updated","version":8}""")
        ws.send("""{"type":"screenshot","future":true}""")
        ws.send("""{"type":"command","id":"cmd_4","command":{"type":"set_volume","volume":40}}""")
        assertEquals(ServerToDevice.ManifestUpdated(8), listener.messages.poll(5, TimeUnit.SECONDS))
        assertEquals(ServerToDevice.CommandMessage("cmd_4", Command.SetVolume(40)), listener.messages.poll(5, TimeUnit.SECONDS))

        assertTrue(socket.sendCommandResult("cmd_4", CommandResult(ok = true, message = null)))
        assertEquals(DeviceToServer.CommandResultMessage("cmd_4", ok = true, message = null), end.nextMessage())
    }

    @Test
    fun `sends the status heartbeat periodically`() {
        val end = ServerEnd()
        server.enqueue(MockResponse().withWebSocketUpgrade(end))
        start(heartbeatMs = 100)
        end.awaitOpen()
        repeat(4) { assertIs<DeviceToServer.StatusMessage>(end.nextMessage()) }
    }

    @Test
    fun `reconnects after the server closes the connection`() {
        val first =
            object : ServerEnd() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    super.onOpen(webSocket, response)
                    webSocket.close(1001, "replaced")
                }
            }
        val second = ServerEnd()
        server.enqueue(MockResponse().withWebSocketUpgrade(first))
        server.enqueue(MockResponse().withWebSocketUpgrade(second))
        val socket = start()

        second.awaitOpen()
        socket.awaitState(ConnectionState.CONNECTED)
        assertEquals(2, server.requestCount)
        assertTrue(ConnectionState.DISCONNECTED in listener.states)
    }

    @Test
    fun `failed connections back off and the heartbeat falls back to HTTP`() {
        val attempts = AtomicInteger()
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    attempts.incrementAndGet()
                    return MockResponse().setResponseCode(503)
                }
            }
        val posted = LinkedBlockingQueue<DeviceStatus>()
        start(heartbeatMs = 100, fallback = { posted += it })

        assertEquals(status, posted.poll(5, TimeUnit.SECONDS))
        assertEquals(status, posted.poll(5, TimeUnit.SECONDS))
        assertTrue(attempts.get() >= 2, "kept reconnecting")
    }

    @Test
    fun `401 on the upgrade stops reconnecting`() {
        server.enqueue(MockResponse().setResponseCode(401))
        val socket = start()
        socket.awaitState(ConnectionState.UNAUTHORIZED)
        Thread.sleep(300)
        assertEquals(1, server.requestCount)
        assertEquals(ConnectionState.UNAUTHORIZED, socket.state.value)
    }

    @Test
    fun `unpaired is delivered and stops reconnecting`() {
        val end =
            object : ServerEnd() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    super.onOpen(webSocket, response)
                    webSocket.send("""{"type":"unpaired"}""")
                }
            }
        server.enqueue(MockResponse().withWebSocketUpgrade(end))
        val socket = start()

        assertEquals(ServerToDevice.Unpaired, listener.messages.poll(5, TimeUnit.SECONDS))
        socket.awaitState(ConnectionState.UNAUTHORIZED)
        Thread.sleep(300)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `no token means unauthorized without connecting`() {
        val socket = start(token = null)
        socket.awaitState(ConnectionState.UNAUTHORIZED)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `stop closes the connection and the state`() {
        val end = ServerEnd()
        server.enqueue(MockResponse().withWebSocketUpgrade(end))
        val socket = start()
        end.awaitOpen()
        socket.awaitState(ConnectionState.CONNECTED)
        socket.stop()
        assertEquals(ConnectionState.STOPPED, socket.state.value)
        assertEquals(false, socket.send(DeviceToServer.StatusMessage(status)))
    }
}
