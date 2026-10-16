package tv.managealltv.player.core.net

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.DeviceToServer
import tv.managealltv.player.core.protocol.ProtocolConstants
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.ServerToDevice
import tv.managealltv.player.core.time.TimeSource
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.ExponentialBackoff

/** Supplies the status to report; called on every heartbeat, so it must be cheap and thread-safe. */
fun interface StatusProvider {
    fun currentStatus(): DeviceStatus
}

/** Sends a heartbeat over HTTP (`ApiClient.postStatus`) while the WebSocket is down. */
fun interface StatusFallback {
    suspend fun postStatus(status: DeviceStatus)
}

/**
 * The device WebSocket (GET /api/device/v1/ws). Keeps one connection open, reconnects with
 * exponential backoff + jitter (1 s → 60 s) and sends a `status` message on connect and every
 * [Config.heartbeatIntervalMs]. While disconnected the heartbeat goes to [statusFallback] instead.
 *
 * A 401 on the upgrade, a missing token or an `unpaired` message end the loop with
 * [ConnectionState.UNAUTHORIZED]: the app must drop the token, pair again and call [start] anew.
 */
class DeviceSocket(
    httpClient: OkHttpClient,
    baseUrl: HttpUrl,
    private val tokenProvider: TokenProvider,
    private val statusProvider: StatusProvider,
    private val listener: Listener,
    private val scope: CoroutineScope,
    private val config: Config = Config(),
    private val statusFallback: StatusFallback? = null,
    private val json: Json = ProtocolJson.default,
    private val timeSource: TimeSource = TimeSource.SYSTEM,
) {
    interface Listener {
        /**
         * Every parsed server message, on an OkHttp thread. Unknown message types are logged and
         * skipped so a newer server does not break an older player.
         */
        fun onMessage(message: ServerToDevice)

        fun onStateChanged(state: ConnectionState) {}
    }

    enum class ConnectionState { STOPPED, CONNECTING, CONNECTED, DISCONNECTED, UNAUTHORIZED }

    data class Config(
        val heartbeatIntervalMs: Long = ProtocolConstants.HEARTBEAT_INTERVAL_SEC * 1000L,
        val backoff: ExponentialBackoff = ExponentialBackoff(initialDelayMs = 1_000, maxDelayMs = 60_000),
        /**
         * A connection that lasted this long resets the backoff. Resetting on every open would let a
         * server that accepts and immediately drops the socket be hammered once a second.
         */
        val stableConnectionMs: Long = 30_000,
        /** WebSocket pings detect a dead Wi-Fi connection long before TCP would. */
        val pingIntervalMs: Long = 20_000,
    )

    private val wsClient = httpClient.newBuilder().pingInterval(config.pingIntervalMs, TimeUnit.MILLISECONDS).build()
    private val wsUrl = ServerUrls.deviceApi(baseUrl, "ws")
    private val _state = MutableStateFlow(ConnectionState.STOPPED)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val lock = Any()
    private var loopJob: Job? = null
    private var heartbeatJob: Job? = null
    private val wakeUp = Channel<Unit>(Channel.CONFLATED)

    @Volatile
    private var socket: WebSocket? = null

    /** False after [stop]; late callbacks of a cancelled connection must not resurrect the state. */
    @Volatile
    private var running = false

    /** Starts connecting; no-op while already running. */
    fun start() {
        synchronized(lock) {
            if (loopJob?.isActive == true) return
            running = true
            heartbeatJob?.cancel()
            loopJob = scope.launch { connectLoop() }
            heartbeatJob = scope.launch { heartbeatLoop() }
        }
    }

    /** Closes the connection and stops reconnecting. */
    fun stop() {
        synchronized(lock) {
            running = false
            loopJob?.cancel()
            heartbeatJob?.cancel()
            loopJob = null
            heartbeatJob = null
        }
        socket?.close(NORMAL_CLOSURE, null)
        socket = null
        setState(ConnectionState.STOPPED, force = true)
    }

    /** Skips the current backoff wait, e.g. when the app sees the network come back. */
    fun reconnectNow() {
        wakeUp.trySend(Unit)
    }

    /** Sends [message] if connected; returns false otherwise (use the HTTP fallback then). */
    fun send(message: DeviceToServer): Boolean {
        val ws = socket ?: return false
        return ws.send(json.encodeToString(DeviceToServer.serializer(), message))
    }

    /** Sends a status message now (e.g. right after a sync finished) if connected. */
    fun sendStatusNow(): Boolean = send(DeviceToServer.StatusMessage(statusProvider.currentStatus()))

    fun sendCommandResult(commandId: String, result: CommandResult): Boolean =
        send(DeviceToServer.CommandResultMessage(commandId, result.ok, result.message))

    private suspend fun connectLoop() {
        var attempt = 0
        while (currentCoroutineContext().isActive) {
            val token = tokenProvider.token()
            if (token == null) {
                becomeUnauthorized()
                return
            }
            setState(ConnectionState.CONNECTING)
            when (val outcome = connectOnce(token)) {
                Outcome.Unauthorized -> {
                    becomeUnauthorized()
                    return
                }
                is Outcome.Closed -> {
                    val openedAt = outcome.openedAtMs
                    if (openedAt != null && timeSource.monotonicMs() - openedAt >= config.stableConnectionMs) attempt = 0
                }
            }
            setState(ConnectionState.DISCONNECTED)
            val waitMs = config.backoff.delayMs(attempt++)
            CoreLog.d(TAG, "Reconnecting in $waitMs ms")
            withTimeoutOrNull(waitMs) { wakeUp.receive() }
        }
    }

    private suspend fun connectOnce(token: String): Outcome {
        val done = CompletableDeferred<Outcome>()
        // Monotonic time of onOpen; -1 while the upgrade has not succeeded.
        val openedAt = AtomicLong(-1)
        val request = Request.Builder().url(wsUrl).header("Authorization", "Bearer $token").build()
        val ws =
            wsClient.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        if (!running || done.isCompleted) {
                            webSocket.cancel()
                            return
                        }
                        openedAt.set(timeSource.monotonicMs())
                        socket = webSocket
                        setState(ConnectionState.CONNECTED)
                        // The server learns our manifest version from the first status and answers
                        // with manifest_updated if it differs.
                        sendStatusNow()
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (!running) return
                        val message =
                            try {
                                json.decodeFromString(ServerToDevice.serializer(), text)
                            } catch (e: IllegalArgumentException) {
                                CoreLog.w(TAG, "Ignoring unknown message: ${text.take(200)}", e)
                                return
                            }
                        try {
                            listener.onMessage(message)
                        } catch (e: RuntimeException) {
                            // An app bug must not tear down the connection (OkHttp would fail it).
                            CoreLog.e(TAG, "Listener failed on $message", e)
                        }
                        if (message is ServerToDevice.Unpaired) {
                            webSocket.close(NORMAL_CLOSURE, null)
                            done.complete(Outcome.Unauthorized)
                        }
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(NORMAL_CLOSURE, null)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        done.complete(Outcome.Closed(openedAt.get().takeIf { it >= 0 }))
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        if (response?.code == 401) {
                            done.complete(Outcome.Unauthorized)
                        } else {
                            CoreLog.i(TAG, "WebSocket failed: ${t.message}")
                            done.complete(Outcome.Closed(openedAt.get().takeIf { it >= 0 }))
                        }
                    }
                },
            )
        try {
            return done.await()
        } finally {
            if (socket === ws) socket = null
            // Normally already closed; on cancellation (stop) this releases the connection.
            ws.cancel()
        }
    }

    private suspend fun heartbeatLoop() {
        while (currentCoroutineContext().isActive) {
            delay(config.heartbeatIntervalMs)
            when (_state.value) {
                ConnectionState.CONNECTED -> if (!sendStatusNow()) fallback()
                ConnectionState.UNAUTHORIZED, ConnectionState.STOPPED -> Unit
                else -> fallback()
            }
        }
    }

    private suspend fun fallback() {
        val fallback = statusFallback ?: return
        try {
            fallback.postStatus(statusProvider.currentStatus())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The heartbeat must survive any failure of the app's callback.
            CoreLog.i(TAG, "HTTP status fallback failed: ${e.message}")
        }
    }

    private fun becomeUnauthorized() {
        setState(ConnectionState.UNAUTHORIZED)
        synchronized(lock) { heartbeatJob?.cancel() }
    }

    private fun setState(newState: ConnectionState, force: Boolean = false) {
        if (!force && !running) return
        val old = _state.getAndUpdate { newState }
        if (old != newState) listener.onStateChanged(newState)
    }

    private sealed interface Outcome {
        /** [openedAtMs] is null when the connection never opened. */
        data class Closed(val openedAtMs: Long?) : Outcome

        data object Unauthorized : Outcome
    }

    private companion object {
        const val TAG = "DeviceSocket"
        const val NORMAL_CLOSURE = 1000
    }
}
