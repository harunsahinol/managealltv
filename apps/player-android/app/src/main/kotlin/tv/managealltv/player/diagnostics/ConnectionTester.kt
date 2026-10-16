package tv.managealltv.player.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.cert.X509Certificate
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import tv.managealltv.player.R
import tv.managealltv.player.core.net.ServerUrls
import tv.managealltv.player.core.protocol.ProtocolJson

/**
 * The installation check of ARCHITECTURE §6.2: DNS → TCP → TLS → GET /health, each with its timing.
 * A browser on the TV is not a reliable test (it may bypass a filtering Wi-Fi); this runs the same
 * trust configuration and HTTP client as the player itself.
 */
class ConnectionTester(context: Context, private val http: OkHttpClient) {
    private val context: Context = context.applicationContext

    enum class Outcome { OK, FAILED, SKIPPED, INFO }

    data class Step(val title: String, val outcome: Outcome, val detail: String)

    data class Report(val steps: List<Step>, val finished: Boolean, val success: Boolean)

    /** Emits the report after every step; the last emission has [Report.finished] set. */
    fun run(serverUrl: String): Flow<Report> =
        flow {
            val steps = ArrayList<Step>()
            fun snapshot(finished: Boolean, success: Boolean) = Report(steps.toList(), finished, success)

            steps += Step(context.getString(R.string.conn_step_clock), Outcome.INFO, describeClock())
            emit(snapshot(finished = false, success = false))

            val baseUrl = ServerUrls.parseBaseUrl(serverUrl)
            if (baseUrl == null) {
                steps += Step(context.getString(R.string.conn_step_address), Outcome.FAILED, context.getString(R.string.conn_address_invalid, serverUrl))
                emit(snapshot(finished = true, success = false))
                return@flow
            }
            steps += Step(context.getString(R.string.conn_step_address), Outcome.INFO, baseUrl.toString().removeSuffix("/"))

            val network = describeNetwork()
            steps += network
            emit(snapshot(finished = false, success = false))
            if (network.outcome == Outcome.FAILED) {
                emit(snapshot(finished = true, success = false))
                return@flow
            }

            val host = baseUrl.host
            val dnsStart = SystemClock.elapsedRealtime()
            val addresses =
                try {
                    InetAddress.getAllByName(host).toList()
                } catch (e: IOException) {
                    steps += Step(context.getString(R.string.conn_step_dns), Outcome.FAILED, ErrorText.describe(context, e))
                    emit(snapshot(finished = true, success = false))
                    return@flow
                }
            val dnsMs = SystemClock.elapsedRealtime() - dnsStart
            val shown = addresses.take(3).joinToString(", ") { it.hostAddress ?: it.toString() }
            steps += Step(context.getString(R.string.conn_step_dns), Outcome.OK, context.getString(R.string.conn_dns_ok, host, shown, dnsMs))
            emit(snapshot(finished = false, success = false))

            val socket = Socket()
            val tcpStart = SystemClock.elapsedRealtime()
            try {
                socket.connect(InetSocketAddress(addresses.first(), baseUrl.port), TIMEOUT_MS)
                socket.soTimeout = TIMEOUT_MS
            } catch (e: IOException) {
                socket.close()
                steps += Step(context.getString(R.string.conn_step_tcp), Outcome.FAILED, ErrorText.describe(context, e))
                emit(snapshot(finished = true, success = false))
                return@flow
            }
            val tcpMs = SystemClock.elapsedRealtime() - tcpStart
            steps += Step(context.getString(R.string.conn_step_tcp), Outcome.OK, context.getString(R.string.conn_tcp_ok, baseUrl.port, tcpMs))
            emit(snapshot(finished = false, success = false))

            val tlsStep =
                try {
                    handshake(baseUrl, socket)
                } catch (e: IOException) {
                    Step(context.getString(R.string.conn_step_tls), Outcome.FAILED, ErrorText.describe(context, e))
                } finally {
                    socket.close()
                }
            steps += tlsStep
            emit(snapshot(finished = false, success = false))
            if (tlsStep.outcome == Outcome.FAILED) {
                emit(snapshot(finished = true, success = false))
                return@flow
            }

            val healthStep = checkHealth(baseUrl)
            steps += healthStep
            emit(snapshot(finished = true, success = healthStep.outcome == Outcome.OK))
        }.flowOn(Dispatchers.IO)

    private fun describeClock(): String {
        val zone = ZoneId.systemDefault()
        val formatter = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss", TURKISH)
        // A wrong clock is the most common cause of TLS failures on TVs that were unplugged.
        return context.getString(R.string.conn_clock, formatter.format(Instant.now().atZone(zone)), zone.id)
    }

    private fun describeNetwork(): Step {
        val title = context.getString(R.string.conn_step_network)
        val manager = ContextCompat.getSystemService(context, ConnectivityManager::class.java)
        val network = manager?.activeNetwork
        val capabilities = if (manager != null && network != null) manager.getNetworkCapabilities(network) else null
        if (capabilities == null) return Step(title, Outcome.FAILED, context.getString(R.string.conn_network_none))
        val kind =
            when {
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> context.getString(R.string.conn_network_wifi)
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> context.getString(R.string.conn_network_ethernet)
                else -> context.getString(R.string.conn_network_other)
            }
        // "Validated" means Android itself reached the internet; a captive portal or filter fails it.
        val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val detail = if (validated) kind else context.getString(R.string.conn_network_not_validated, kind)
        return Step(title, Outcome.OK, detail)
    }

    /** TLS handshake on the connected [socket] with the app's trust anchors, plus the hostname check. */
    private fun handshake(baseUrl: HttpUrl, socket: Socket): Step {
        val title = context.getString(R.string.conn_step_tls)
        if (!baseUrl.isHttps) return Step(title, Outcome.SKIPPED, context.getString(R.string.conn_tls_skipped))
        val host = baseUrl.host
        val start = SystemClock.elapsedRealtime()
        // The default factory follows network_security_config.xml (system CAs + bundled ISRG roots).
        val ssl = HttpsURLConnection.getDefaultSSLSocketFactory().createSocket(socket, host, baseUrl.port, true) as SSLSocket
        ssl.use {
            it.startHandshake()
            val elapsedMs = SystemClock.elapsedRealtime() - start
            val session = it.session
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)) {
                return Step(title, Outcome.FAILED, context.getString(R.string.conn_tls_hostname, host))
            }
            val certificate = session.peerCertificates.firstOrNull() as? X509Certificate
            val issuer = certificate?.let { cert -> commonName(cert.issuerX500Principal.name) } ?: "?"
            val validUntil =
                certificate?.let { cert ->
                    DateTimeFormatter.ofPattern("dd.MM.yyyy", TURKISH).format(Instant.ofEpochMilli(cert.notAfter.time).atZone(ZoneId.systemDefault()))
                } ?: "?"
            return Step(title, Outcome.OK, context.getString(R.string.conn_tls_ok, session.protocol, issuer, validUntil, elapsedMs))
        }
    }

    private suspend fun checkHealth(baseUrl: HttpUrl): Step {
        val title = context.getString(R.string.conn_step_http)
        val url = baseUrl.newBuilder().encodedPath("/health").build()
        val client = http.newBuilder().callTimeout(TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS).build()
        val start = SystemClock.elapsedRealtime()
        val result =
            try {
                client.newCall(Request.Builder().url(url).get().build()).awaitBody()
            } catch (e: IOException) {
                return Step(title, Outcome.FAILED, ErrorText.describe(context, e))
            }
        val elapsedMs = SystemClock.elapsedRealtime() - start
        val healthy = result.code == 200 && isHealthyBody(result.body)
        return if (healthy) {
            Step(title, Outcome.OK, context.getString(R.string.conn_http_ok, elapsedMs))
        } else {
            Step(title, Outcome.FAILED, context.getString(R.string.conn_http_failed, result.code, elapsedMs))
        }
    }

    private fun isHealthyBody(body: String): Boolean =
        try {
            val status = (ProtocolJson.default.parseToJsonElement(body) as? JsonObject)?.get("status") as? JsonPrimitive
            status?.content == "ok"
        } catch (e: IllegalArgumentException) {
            // SerializationException is an IllegalArgumentException.
            false
        }

    private class BodyResult(val code: Int, val body: String)

    /** Asynchronous call that is cancelled with the coroutine; the body is read on OkHttp's thread. */
    private suspend fun Call.awaitBody(): BodyResult =
        suspendCancellableCoroutine { continuation ->
            val call = this
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val result =
                            try {
                                response.use { BodyResult(it.code, it.body?.string().orEmpty().take(MAX_BODY_CHARS)) }
                            } catch (e: IOException) {
                                continuation.resumeWithException(e)
                                return
                            }
                        continuation.resume(result)
                    }
                },
            )
        }

    private fun commonName(distinguishedName: String): String =
        Regex("""CN=([^,]+)""").find(distinguishedName)?.groupValues?.get(1) ?: distinguishedName

    private companion object {
        const val TIMEOUT_MS = 10_000
        const val MAX_BODY_CHARS = 2_000
        val TURKISH: Locale = Locale.forLanguageTag("tr-TR")
    }
}
