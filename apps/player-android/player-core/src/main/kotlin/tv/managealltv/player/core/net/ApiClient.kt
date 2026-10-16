package tv.managealltv.player.core.net

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import tv.managealltv.player.core.protocol.ApiError
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.PairPollRequest
import tv.managealltv.player.core.protocol.PairPollResponse
import tv.managealltv.player.core.protocol.PairRequest
import tv.managealltv.player.core.protocol.PairResponse
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.StatusAck

/** Result of an authenticated call: 401 is a value, not an exception, so callers cannot miss it. */
sealed interface ApiResult<out T> {
    data class Ok<out T>(val value: T) : ApiResult<T>

    /** Token missing or rejected: delete it and pair again. */
    data object Unauthorized : ApiResult<Nothing>
}

sealed interface ManifestResult {
    data class Updated(
        val manifest: Manifest,
        /** The ETag header as sent (`"<version>"`), null if the server sent none. */
        val etag: String?,
    ) : ManifestResult

    /** 304: the manifest matching the sent ETag is still current. */
    data object NotModified : ManifestResult

    /** Token missing or rejected: delete it and pair again. */
    data object Unauthorized : ManifestResult
}

/**
 * HTTP client for the device API (`/api/device/v1`, docs/API.md). Network failures surface as
 * [java.io.IOException]; other non-2xx answers as [ApiException]; a body that does not match the
 * protocol as [ProtocolException]. All functions are main-safe.
 */
class ApiClient(
    /** Server origin, see [ServerUrls.parseBaseUrl]. */
    val baseUrl: HttpUrl,
    private val httpClient: OkHttpClient,
    private val tokenProvider: TokenProvider,
    private val json: Json = ProtocolJson.default,
) {
    /** POST /pair: starts pairing; show [PairResponse.pairingCode] on screen and poll. */
    suspend fun pair(request: PairRequest): PairResponse {
        val call = httpClient.newCall(post(ServerUrls.deviceApi(baseUrl, "pair"), PairRequest.serializer(), request, token = null))
        return call.executeCancellable { decodeSuccess(it, PairResponse.serializer()) }
    }

    /** POST /pair/poll: `pending` until an admin claims the code; `paired` carries the token exactly once. */
    suspend fun pollPairing(pairingSecret: String): PairPollResponse {
        val body = PairPollRequest(pairingSecret)
        val call = httpClient.newCall(post(ServerUrls.deviceApi(baseUrl, "pair", "poll"), PairPollRequest.serializer(), body, token = null))
        return call.executeCancellable { decodeSuccess(it, PairPollResponse.serializer()) }
    }

    /**
     * GET /manifest. Pass the ETag of the applied manifest (see [etagOf]) to get
     * [ManifestResult.NotModified] when nothing changed.
     */
    suspend fun fetchManifest(etag: String?): ManifestResult {
        val token = tokenProvider.token() ?: return ManifestResult.Unauthorized
        val request =
            Request.Builder()
                .url(ServerUrls.deviceApi(baseUrl, "manifest"))
                .header("Authorization", "Bearer $token")
                .apply { if (etag != null) header("If-None-Match", etag) }
                .get()
                .build()
        return httpClient.newCall(request).executeCancellable { response ->
            when (response.code) {
                304 -> ManifestResult.NotModified
                401 -> ManifestResult.Unauthorized
                else -> ManifestResult.Updated(decodeSuccess(response, Manifest.serializer()), response.header("ETag"))
            }
        }
    }

    /** POST /status: HTTP fallback heartbeat while the WebSocket is down. */
    suspend fun postStatus(status: DeviceStatus): ApiResult<StatusAck> {
        val token = tokenProvider.token() ?: return ApiResult.Unauthorized
        val call = httpClient.newCall(post(ServerUrls.deviceApi(baseUrl, "status"), DeviceStatus.serializer(), status, token))
        return call.executeCancellable { response ->
            if (response.code == 401) ApiResult.Unauthorized else ApiResult.Ok(decodeSuccess(response, StatusAck.serializer()))
        }
    }

    /** POST /commands/:id/result (204): HTTP fallback for command results. */
    suspend fun postCommandResult(commandId: String, result: CommandResult): ApiResult<Unit> {
        val token = tokenProvider.token() ?: return ApiResult.Unauthorized
        val url = ServerUrls.deviceApi(baseUrl, "commands", commandId, "result")
        val call = httpClient.newCall(post(url, CommandResult.serializer(), result, token))
        return call.executeCancellable { response ->
            when {
                response.code == 401 -> ApiResult.Unauthorized
                response.isSuccessful -> ApiResult.Ok(Unit)
                else -> throw errorOf(response)
            }
        }
    }

    private fun <T> post(url: HttpUrl, serializer: SerializationStrategy<T>, body: T, token: String?): Request =
        Request.Builder()
            .url(url)
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .post(json.encodeToString(serializer, body).toRequestBody(JSON))
            .build()

    private fun <T> decodeSuccess(response: Response, deserializer: DeserializationStrategy<T>): T {
        if (!response.isSuccessful) throw errorOf(response)
        val text = response.body?.string() ?: throw ProtocolException("Empty body from ${response.request.url.encodedPath}")
        return try {
            json.decodeFromString(deserializer, text)
        } catch (e: IllegalArgumentException) {
            // SerializationException is an IllegalArgumentException.
            throw ProtocolException("Unexpected body from ${response.request.url.encodedPath}: ${e.message}", e)
        }
    }

    private fun errorOf(response: Response): ApiException {
        val error =
            try {
                response.body?.string()?.let { json.decodeFromString(ApiError.serializer(), it).error }
            } catch (_: IllegalArgumentException) {
                null
            }
        return ApiException(response.code, error?.code, error?.message)
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /** The manifest ETag the server sends for [version]: the version number in quotes. */
        fun etagOf(version: Int): String = "\"$version\""
    }
}
