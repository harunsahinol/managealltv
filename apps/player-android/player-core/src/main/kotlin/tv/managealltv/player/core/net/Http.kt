package tv.managealltv.player.core.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Response
import tv.managealltv.player.core.protocol.ProtocolConstants

/** Supplies the current device token; null means the device is not paired. */
fun interface TokenProvider {
    fun token(): String?
}

/**
 * The device has no token or the server rejected it (HTTP 401, or `unpaired` on the WebSocket).
 * The app must delete the token and show the pairing screen again.
 */
class UnauthorizedException(message: String = "Device token missing or rejected") : IOException(message)

/** A non-2xx response other than 401, with the parsed `ApiError` body when there was one. */
class ApiException(
    val httpStatus: Int,
    /** Stable English code from the error body, e.g. "rate_limited". */
    val code: String?,
    /** Turkish message from the error body; may be shown to users. */
    val serverMessage: String?,
) : IOException("HTTP $httpStatus" + (code?.let { " $it" } ?: "") + (serverMessage?.let { ": $it" } ?: ""))

/** The server answered with something that does not match the protocol. */
class ProtocolException(message: String, cause: Throwable? = null) : IOException(message, cause)

/** URL helpers shared by [ApiClient], [DeviceSocket] and the downloader. */
object ServerUrls {
    /**
     * Parses the server address typed during setup, e.g. "https://tv.example.com". Only the origin is
     * kept: device API paths and manifest media paths are absolute ("/api/device/v1/...").
     * Returns null when the value is not an http(s) URL.
     */
    fun parseBaseUrl(value: String): HttpUrl? {
        val url = value.trim().toHttpUrlOrNull() ?: return null
        return url.newBuilder().encodedPath("/").query(null).fragment(null).username("").password("").build()
    }

    /** `{base}/api/device/v1/<segments...>`; segments are escaped individually. */
    fun deviceApi(baseUrl: HttpUrl, vararg segments: String): HttpUrl {
        val builder = baseUrl.newBuilder().encodedPath("/").addPathSegments(ProtocolConstants.DEVICE_API_BASE.trimStart('/'))
        for (segment in segments) builder.addPathSegment(segment)
        return builder.build()
    }

    /**
     * Resolves a server-relative path from the manifest (e.g. `/api/device/v1/media/<id>`). Refuses
     * anything that would leave the server — "//host/x" is a valid relative reference to another
     * host, and the request carries the device token.
     */
    fun resolveServerPath(baseUrl: HttpUrl, path: String): HttpUrl {
        if (!path.startsWith("/") || path.startsWith("//")) throw ProtocolException("Not a server-relative path: $path")
        val url = baseUrl.resolve(path) ?: throw ProtocolException("Invalid path: $path")
        if (url.scheme != baseUrl.scheme || url.host != baseUrl.host || url.port != baseUrl.port) {
            throw ProtocolException("Path leaves the server: $path")
        }
        return url
    }
}

object HttpClients {
    /**
     * Defaults for the device: generous timeouts for slow Wi-Fi but no overall call timeout, because
     * a video download legitimately takes minutes. The app may add its own trust anchors (Let's
     * Encrypt root for Android 7) with [OkHttpClient.newBuilder].
     */
    fun create(): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
}

/**
 * Runs a blocking OkHttp call on [Dispatchers.IO] and closes the response afterwards. OkHttp blocks
 * the thread in execute() and while the body is read; cancelling the call is the only way to
 * unblock it, so a sibling coroutine cancels it when the caller is cancelled.
 */
internal suspend fun <T> Call.executeCancellable(block: suspend (Response) -> T): T =
    coroutineScope {
        val call = this@executeCancellable
        val canceller =
            launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    awaitCancellation()
                } finally {
                    call.cancel()
                }
            }
        try {
            withContext(Dispatchers.IO) { call.execute().use { block(it) } }
        } finally {
            canceller.cancel()
        }
    }
