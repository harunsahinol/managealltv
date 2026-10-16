package tv.managealltv.player.core.sync

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tv.managealltv.player.core.TestManifests
import tv.managealltv.player.core.TestMedia
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.net.ApiClient
import tv.managealltv.player.core.net.HttpClients
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.ManifestPlaylist
import tv.managealltv.player.core.protocol.ManifestPlaylistItem
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.SyncState
import tv.managealltv.player.core.util.ExponentialBackoff

/** End to end against MockWebServer: real ApiClient, Downloader and MediaCache in a temp dir. */
class SyncEngineTest {
    @TempDir
    lateinit var dir: File

    private val token = "mtv_d_token"
    private val server = MockWebServer()
    private val fake = FakeServer(token)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val unauthorizedCalls = AtomicInteger()
    private var available = Long.MAX_VALUE
    private lateinit var cache: MediaCache

    private val video = TestMedia.random("med_video", 120_000, MediaType.VIDEO)
    private val image1 = TestMedia.random("med_image1", 8_000)
    private val image2 = TestMedia.random("med_image2", 6_000)
    private val image3 = TestMedia.random("med_image3", 7_000)

    /** Serves the manifest (with ETag/304) and media (with Range) like apps/server should. */
    private class FakeServer(private val token: String) : Dispatcher() {
        @Volatile
        var manifest: Manifest? = null
        val content = ConcurrentHashMap<String, ByteArray>()
        val paths = CopyOnWriteArrayList<String>()
        val ranges = CopyOnWriteArrayList<String>()

        /** Slows media bodies down so a test can stop the engine mid-download. */
        @Volatile
        var throttle = false

        fun publish(manifest: Manifest, media: List<TestMedia>) {
            media.forEach { content[it.id] = it.bytes }
            this.manifest = manifest
        }

        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path ?: return MockResponse().setResponseCode(400)
            paths += path
            if (request.getHeader("Authorization") != "Bearer $token") return error(401, "unauthorized")
            val current = manifest ?: return error(404, "not_found")
            if (path == "/api/device/v1/manifest") {
                val etag = "\"${current.version}\""
                if (request.getHeader("If-None-Match") == etag) return MockResponse().setResponseCode(304)
                return MockResponse()
                    .setHeader("ETag", etag)
                    .setHeader("Content-Type", "application/json")
                    .setBody(ProtocolJson.default.encodeToString(Manifest.serializer(), current))
            }
            val id = path.removePrefix("/api/device/v1/media/")
            if (current.media.none { it.id == id }) return error(404, "not_found")
            val bytes = content[id] ?: return error(404, "not_found")
            request.getHeader("Range")?.let { ranges += it }
            val from = request.getHeader("Range")?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
            return MockResponse()
                .apply { if (throttle) throttleBody(4_096, 20, TimeUnit.MILLISECONDS) }
                .setResponseCode(if (from > 0) 206 else 200)
                .apply { if (from > 0) setHeader("Content-Range", "bytes $from-${bytes.size - 1}/${bytes.size}") }
                .setHeader("ETag", "\"${current.media.first { it.id == id }.sha256}\"")
                .setBody(Buffer().write(bytes, from, bytes.size - from))
        }

        private fun error(code: Int, errorCode: String) =
            MockResponse().setResponseCode(code).setBody("""{"error":{"code":"$errorCode","message":"Hata"}}""")
    }

    @BeforeEach
    fun setUp() {
        server.dispatcher = fake
        server.start()
        cache = MediaCache(dir)
    }

    @AfterEach
    fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private fun engine(
        config: SyncEngine.Config = SyncEngine.Config(),
        token: String? = this.token,
    ): SyncEngine {
        val base = server.url("/")
        val http = HttpClients.create()
        val downloader =
            Downloader(
                http,
                base,
                { token },
                Downloader.RetryPolicy(maxAttempts = 2, backoff = ExponentialBackoff(10, 10, jitterRatio = 0.0)),
            )
        return SyncEngine(
            api = ApiClient(base, http, { token }),
            downloader = downloader,
            cache = cache,
            scope = scope,
            config = config,
            availableBytes = { available },
            onUnauthorized = { unauthorizedCalls.incrementAndGet() },
        )
    }

    private fun manifestV1() = TestManifests.manifest(1, listOf(video, image1, image2))

    /** v2 keeps image1, drops video and image2, adds image3. */
    private fun manifestV2() =
        TestManifests.manifest(
            2,
            listOf(image1, image3),
            playlists =
                listOf(
                    ManifestPlaylist("pl_main", "Ana liste", listOf(ManifestPlaylistItem(image3.id, 5), ManifestPlaylistItem(image1.id, null))),
                ),
        )

    private fun assertOnDisk(vararg media: TestMedia) {
        for (item in media) assertContentEquals(item.bytes, cache.contentFile(item.sha256).readBytes(), item.id)
    }

    private fun assertGone(vararg media: TestMedia) {
        for (item in media) assertFalse(cache.contentFile(item.sha256).exists(), "${item.id} should be deleted")
    }

    @Test
    fun `first sync downloads everything, verifies and applies`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine()

        val outcome = runBlocking { engine.syncNow() }

        assertEquals(SyncOutcome.Applied(version = 1, downloadedFiles = 3, deletedFiles = 0), outcome)
        assertOnDisk(video, image1, image2)
        val state = engine.state.value
        assertEquals(manifestV1(), state.appliedManifest)
        assertEquals(SyncState.IDLE, state.syncState)
        assertNull(state.lastError)
        val total = video.size + image1.size + image2.size
        assertEquals(SyncProgress(3, 3, total, total), state.progress)
        // Persisted: a restarted app plays the same manifest before any network access.
        assertEquals(manifestV1(), MediaCache(dir).loadAppliedManifest())
        assertEquals(manifestV1(), engine().state.value.appliedManifest)
        assertEquals(setOf(video.id, image1.id, image2.id), MediaCache(dir).entries().map { it.id }.toSet())
    }

    @Test
    fun `an unchanged manifest is answered with 304`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine()
        runBlocking { engine.syncNow() }
        fake.paths.clear()

        assertEquals(SyncOutcome.UpToDate(1), runBlocking { engine.syncNow() })
        assertEquals(listOf("/api/device/v1/manifest"), fake.paths)
        assertTrue(server.takeRequestsUntilManifest().getHeader("If-None-Match") == "\"1\"")
    }

    @Test
    fun `a new manifest is applied only after all files are verified, then old files are collected`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine()
        runBlocking { engine.syncNow() }

        // v2 arrives but image3 is served corrupted: nothing may change for the player.
        fake.publish(manifestV2(), listOf(image1, image3))
        fake.content[image3.id] = image3.bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val failed = assertIs<SyncOutcome.Failed>(runBlocking { engine.syncNow() })
        val error = assertIs<SyncError.DownloadFailed>(failed.error)
        assertEquals(SyncError.DownloadFailed.Reason.HASH_MISMATCH, error.reason)
        assertEquals(manifestV1(), engine.state.value.appliedManifest)
        assertEquals(SyncState.ERROR, engine.state.value.syncState)
        assertEquals(manifestV1(), MediaCache(dir).loadAppliedManifest())
        assertOnDisk(video, image1, image2)
        assertGone(image3)

        // The server is fixed: v2 is applied and only files v2 no longer references are deleted.
        fake.content[image3.id] = image3.bytes
        assertEquals(SyncOutcome.Applied(version = 2, downloadedFiles = 1, deletedFiles = 2), runBlocking { engine.syncNow() })
        assertEquals(manifestV2(), engine.state.value.appliedManifest)
        assertEquals(manifestV2(), MediaCache(dir).loadAppliedManifest())
        assertOnDisk(image1, image3)
        assertGone(video, image2)
        assertEquals(setOf(image1.id, image3.id), MediaCache(dir).entries().map { it.id }.toSet())
        assertTrue(cache.partialDir.listFiles()!!.isEmpty())
        assertNull(engine.state.value.lastError)
    }

    @Test
    fun `a missing file of the applied manifest is downloaded again`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine()
        runBlocking { engine.syncNow() }
        cache.contentFile(image2.sha256).delete()

        assertEquals(SyncOutcome.Applied(version = 1, downloadedFiles = 1, deletedFiles = 0), runBlocking { engine.syncNow() })
        assertOnDisk(video, image1, image2)
    }

    @Test
    fun `not enough space is a typed error and nothing is downloaded`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        available = SyncPlanner.DEFAULT_RESERVE_BYTES + 1_000
        val engine = engine()

        val failed = assertIs<SyncOutcome.Failed>(runBlocking { engine.syncNow() })

        val error = assertIs<SyncError.InsufficientStorage>(failed.error)
        assertEquals(video.size + image1.size + image2.size, error.requiredBytes)
        assertTrue(error.message.startsWith("Yetersiz depolama alanı"), error.message)
        assertNull(engine.state.value.appliedManifest)
        assertEquals(listOf("/api/device/v1/manifest"), fake.paths)
    }

    @Test
    fun `401 reports Unauthorized and calls back`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine(token = "mtv_d_revoked")

        assertEquals(SyncOutcome.Failed(SyncError.Unauthorized), runBlocking { engine.syncNow() })
        assertEquals(1, unauthorizedCalls.get())
        assertEquals(SyncError.Unauthorized, engine.state.value.lastError)
    }

    @Test
    fun `an invalid manifest is not applied`() {
        val broken = manifestV1().let { it.copy(playlists = it.playlists.map { p -> p.copy(items = p.items.drop(1)) }) }
        fake.publish(broken, listOf(video, image1, image2))
        val engine = engine()

        val failed = assertIs<SyncOutcome.Failed>(runBlocking { engine.syncNow() })
        assertIs<SyncError.InvalidManifest>(failed.error)
        assertNull(engine.state.value.appliedManifest)
    }

    @Test
    fun `the loop syncs on start and again when the server announces a new version`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine(SyncEngine.Config(periodicIntervalMs = 60_000))
        engine.start()
        runBlocking { withTimeout(10_000) { engine.state.first { it.appliedManifest?.version == 1 } } }

        fake.publish(manifestV2(), listOf(image1, image3))
        engine.onManifestUpdated(2)
        runBlocking { withTimeout(10_000) { engine.state.first { it.appliedManifest?.version == 2 } } }
        engine.stop()
        assertOnDisk(image1, image3)
    }

    @Test
    fun `stopping mid-download keeps the applied state and the next sync resumes`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        fake.throttle = true
        val engine = engine()
        engine.start()
        runBlocking {
            withTimeout(10_000) { engine.state.first { it.syncState == SyncState.DOWNLOADING && it.progress.bytesDone > 0 } }
        }
        engine.stop()
        runBlocking { withTimeout(5_000) { engine.state.first { it.syncState != SyncState.DOWNLOADING } } }

        assertEquals(SyncState.IDLE, engine.state.value.syncState, "a stop is not an error")
        assertNull(engine.state.value.appliedManifest)
        assertNull(MediaCache(dir).loadAppliedManifest())
        assertTrue(cache.partialBytes(video.sha256) > 0, "the partial download is kept")

        fake.throttle = false
        assertIs<SyncOutcome.Applied>(runBlocking { engine.syncNow() })
        assertTrue(fake.ranges.isNotEmpty(), "the download resumed with a Range request")
        assertOnDisk(video, image1, image2)
    }

    @Test
    fun `status report carries the sync state and fits the protocol`() {
        fake.publish(manifestV1(), listOf(video, image1, image2))
        val engine = engine()
        runBlocking { engine.syncNow() }

        val status =
            engine.state.value.toDeviceStatus(
                activePlaylistId = "pl_main",
                currentMediaId = video.id,
                freeStorageBytes = 1_000,
                uptimeSec = 60,
                appVersionName = "0.1.0",
                appVersionCode = 1,
                volume = null,
                overlayPermission = true,
                deviceOwner = false,
            )
        assertEquals(1, status.manifestVersion)
        assertEquals(SyncState.IDLE, status.syncState)
        assertEquals(3, status.syncFilesDone)
        assertEquals(status.syncBytesTotal, status.syncBytesDone)
        // Round trip through the strict contract configuration: every key present, nulls explicit.
        val json = ProtocolJson.default.encodeToString(DeviceStatus.serializer(), status)
        assertEquals(status, ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), json))
        assertTrue(Json.parseToJsonElement(json).toString().contains("\"lastError\":null"))
    }

    /** Returns the most recent manifest request. */
    private fun MockWebServer.takeRequestsUntilManifest(): RecordedRequest {
        var last: RecordedRequest? = null
        while (true) {
            val request = takeRequest(100, TimeUnit.MILLISECONDS) ?: break
            if (request.path == "/api/device/v1/manifest") last = request
        }
        return last ?: error("no manifest request")
    }
}
