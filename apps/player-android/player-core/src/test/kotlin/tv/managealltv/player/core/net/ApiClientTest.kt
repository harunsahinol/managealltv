package tv.managealltv.player.core.net

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import tv.managealltv.player.core.Fixtures
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.PairPollResponse
import tv.managealltv.player.core.protocol.PairRequest
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.StatusAck

class ApiClientTest {
    private val server = MockWebServer()
    private var token: String? = "mtv_d_token"
    private lateinit var api: ApiClient

    @BeforeEach
    fun setUp() {
        server.start()
        api = ApiClient(server.url("/"), HttpClients.create(), { token })
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun `pair posts the device info without a token`() {
        server.enqueue(json(Fixtures.read("pair-response.json")))
        val request = ProtocolJson.strict.decodeFromString(PairRequest.serializer(), Fixtures.read("pair-request.json"))

        val response = runBlocking { api.pair(request) }

        assertEquals("482913", response.pairingCode)
        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/api/device/v1/pair", recorded.path)
        assertNull(recorded.getHeader("Authorization"))
        assertEquals(Json.parseToJsonElement(Fixtures.read("pair-request.json")), Json.parseToJsonElement(recorded.body.readUtf8()))
    }

    @Test
    fun `poll pairing decodes every state`() {
        val bodies = Json.parseToJsonElement(Fixtures.read("pair-poll-responses.json")) as kotlinx.serialization.json.JsonArray
        bodies.forEach { server.enqueue(json(it.toString())) }

        val results = runBlocking { List(3) { api.pollPairing("q2lY8u0Zt1nC6vW3xR9pK4mJ7hF5dS2aL0eT8yU1iO") } }

        assertIs<PairPollResponse.Pending>(results[0])
        assertEquals("mtv_d_Zk3n8Qw2Lr5Tx9Vb1Nm4Pc7Hs0Jg6Fd3Ka8Ue2Yi5Oq", assertIs<PairPollResponse.Paired>(results[1]).deviceToken)
        assertIs<PairPollResponse.Expired>(results[2])
        val recorded = server.takeRequest()
        assertEquals("/api/device/v1/pair/poll", recorded.path)
        assertEquals("""{"pairingSecret":"q2lY8u0Zt1nC6vW3xR9pK4mJ7hF5dS2aL0eT8yU1iO"}""", recorded.body.readUtf8())
    }

    @Test
    fun `fetch manifest returns the manifest and its ETag`() {
        server.enqueue(json(Fixtures.read("manifest.json")).setHeader("ETag", "\"7\""))

        val result = assertIs<ManifestResult.Updated>(runBlocking { api.fetchManifest(etag = null) })

        assertEquals(7, result.manifest.version)
        assertEquals("\"7\"", result.etag)
        val recorded = server.takeRequest()
        assertEquals("/api/device/v1/manifest", recorded.path)
        assertEquals("Bearer mtv_d_token", recorded.getHeader("Authorization"))
        assertNull(recorded.getHeader("If-None-Match"))
    }

    @Test
    fun `304 means the applied manifest is current`() {
        server.enqueue(MockResponse().setResponseCode(304))
        assertEquals(ManifestResult.NotModified, runBlocking { api.fetchManifest(ApiClient.etagOf(7)) })
        assertEquals("\"7\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun `401 is Unauthorized on every authenticated call`() {
        repeat(3) { server.enqueue(json("""{"error":{"code":"unauthorized","message":"Yetkisiz"}}""", 401)) }
        val status = ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), Fixtures.read("device-status.json"))
        runBlocking {
            assertEquals(ManifestResult.Unauthorized, api.fetchManifest(null))
            assertEquals(ApiResult.Unauthorized, api.postStatus(status))
            assertEquals(ApiResult.Unauthorized, api.postCommandResult("cmd_1", CommandResult(true, null)))
        }
    }

    @Test
    fun `without a token nothing is sent`() {
        token = null
        runBlocking {
            assertEquals(ManifestResult.Unauthorized, api.fetchManifest(null))
            assertEquals(ApiResult.Unauthorized, api.postStatus(ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), Fixtures.read("device-status.json"))))
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `post status sends the status with explicit nulls and returns the ack`() {
        server.enqueue(json("""{"manifestVersion":8}"""))
        val status = ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), Fixtures.read("device-status.json"))

        assertEquals(ApiResult.Ok(StatusAck(8)), runBlocking { api.postStatus(status) })

        val recorded = server.takeRequest()
        assertEquals("/api/device/v1/status", recorded.path)
        assertEquals(Json.parseToJsonElement(Fixtures.read("device-status.json")), Json.parseToJsonElement(recorded.body.readUtf8()))
    }

    @Test
    fun `post command result escapes the id and accepts 204`() {
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(ApiResult.Ok(Unit), runBlocking { api.postCommandResult("cmd/1", CommandResult(false, "Device Owner değil")) })
        val recorded = server.takeRequest()
        assertEquals("/api/device/v1/commands/cmd%2F1/result", recorded.path)
        assertEquals("""{"ok":false,"message":"Device Owner değil"}""", recorded.body.readUtf8())
    }

    @Test
    fun `error bodies become ApiException`() {
        server.enqueue(json("""{"error":{"code":"rate_limited","message":"Çok fazla istek"}}""", 429))
        val error = assertFailsWith<ApiException> { runBlocking { api.pollPairing("x".repeat(40)) } }
        assertEquals(429, error.httpStatus)
        assertEquals("rate_limited", error.code)
        assertEquals("Çok fazla istek", error.serverMessage)
    }

    @Test
    fun `a body that does not match the protocol is a ProtocolException`() {
        server.enqueue(json("""{"status":"teleported"}"""))
        assertFailsWith<ProtocolException> { runBlocking { api.pollPairing("x".repeat(40)) } }
    }

    @Test
    fun `base URL keeps only the origin`() {
        assertEquals("https://tv.example.com/", ServerUrls.parseBaseUrl(" https://tv.example.com/panel/?a=1#x ").toString())
        assertEquals("http://10.0.0.5:8080/", ServerUrls.parseBaseUrl("http://10.0.0.5:8080").toString())
        assertNull(ServerUrls.parseBaseUrl("tv.example.com"))
        assertNull(ServerUrls.parseBaseUrl("ftp://tv.example.com"))
        val base = ServerUrls.parseBaseUrl("https://tv.example.com")!!
        assertEquals("https://tv.example.com/api/device/v1/ws", ServerUrls.deviceApi(base, "ws").toString())
        assertFailsWith<ProtocolException> { ServerUrls.resolveServerPath(base, "https://evil.example/x") }
    }
}
