package tv.managealltv.player.core.sync

import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tv.managealltv.player.core.TestMedia
import tv.managealltv.player.core.net.HttpClients
import tv.managealltv.player.core.net.ProtocolException
import tv.managealltv.player.core.net.UnauthorizedException
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.util.ExponentialBackoff

class DownloaderTest {
    @TempDir
    lateinit var dir: File

    private val server = MockWebServer()
    private val media = TestMedia.random("med_video", 200_000, MediaType.VIDEO)
    private val sleeps = CopyOnWriteArrayList<Long>()
    private val progress = CopyOnWriteArrayList<Long>()
    private lateinit var downloader: Downloader
    private lateinit var part: File
    private lateinit var target: File

    @BeforeEach
    fun setUp() {
        server.start()
        downloader =
            Downloader(
                httpClient = HttpClients.create(),
                baseUrl = server.url("/"),
                tokenProvider = { "mtv_d_token" },
                retryPolicy = Downloader.RetryPolicy(maxAttempts = 3, backoff = ExponentialBackoff(100, 1_000, jitterRatio = 0.0)),
                sleep = { sleeps += it },
            )
        part = File(dir, "partial/${media.sha256}.part").also { it.parentFile.mkdirs() }
        target = File(dir, "media/${media.sha256}")
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    private fun task(path: String = "/api/device/v1/media/${media.id}") =
        DownloadTask(media.id, media.type, media.sha256, media.size, path, partialBytes = if (part.isFile) part.length() else 0)

    private fun download(): File = runBlocking { downloader.download(task(), part, target) { done, _ -> progress += done } }

    private fun full(bytes: ByteArray = media.bytes) = MockResponse().setResponseCode(200).setBody(Buffer().write(bytes))

    private fun ranged(from: Int, bytes: ByteArray = media.bytes) =
        MockResponse()
            .setResponseCode(206)
            .setHeader("Content-Range", "bytes $from-${bytes.size - 1}/${bytes.size}")
            .setBody(Buffer().write(bytes, from, bytes.size - from))

    private fun assertDownloaded() {
        assertContentEquals(media.bytes, target.readBytes())
        assertFalse(part.exists(), "part file is renamed away")
        assertEquals(media.size, progress.last())
    }

    @Test
    fun `downloads, verifies and renames into place`() {
        server.enqueue(full())
        assertEquals(target, download())
        assertDownloaded()
        val request = server.takeRequest()
        assertEquals("/api/device/v1/media/${media.id}", request.path)
        assertEquals("Bearer mtv_d_token", request.getHeader("Authorization"))
        assertEquals("identity", request.getHeader("Accept-Encoding"))
        assertNull(request.getHeader("Range"))
    }

    @Test
    fun `resumes a partial file with a Range request`() {
        part.writeBytes(media.bytes.copyOf(50_000))
        server.enqueue(ranged(50_000))
        download()
        assertDownloaded()
        assertEquals("bytes=50000-", server.takeRequest().getHeader("Range"))
        assertTrue(progress.first() >= 50_000, "progress includes the resumed bytes")
    }

    @Test
    fun `starts over when the server answers a Range request with 200`() {
        part.writeBytes(media.bytes.copyOf(50_000))
        server.enqueue(full())
        download()
        assertDownloaded()
        assertEquals("bytes=50000-", server.takeRequest().getHeader("Range"))
    }

    @Test
    fun `a corrupt partial file is deleted and the download restarts from zero`() {
        part.writeBytes(ByteArray(50_000)) // zeros, as left behind by a power cut
        server.enqueue(ranged(50_000))
        server.enqueue(full())
        download()
        assertDownloaded()
        assertEquals("bytes=50000-", server.takeRequest().getHeader("Range"))
        assertNull(server.takeRequest().getHeader("Range"))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a hash mismatch of a full download is retried once from scratch`() {
        val corrupt = media.bytes.copyOf().also { it[1234] = (it[1234] + 1).toByte() }
        server.enqueue(full(corrupt))
        server.enqueue(full())
        download()
        assertDownloaded()
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a second hash mismatch fails and deletes the part`() {
        val corrupt = media.bytes.copyOf().also { it[1234] = (it[1234] + 1).toByte() }
        server.enqueue(full(corrupt))
        server.enqueue(full(corrupt))
        val error = assertFailsWith<DownloadException.HashMismatch> { download() }
        assertEquals(media.sha256, error.expected)
        assertFalse(part.exists())
        assertFalse(target.exists())
        assertEquals(2, server.requestCount)
        assertTrue(sleeps.isEmpty(), "integrity failures are not network retries")
    }

    @Test
    fun `a corrupt partial file followed by bad server content fails after one restart`() {
        part.writeBytes(ByteArray(50_000))
        val corrupt = media.bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        server.enqueue(ranged(50_000))
        server.enqueue(full(corrupt))
        assertFailsWith<DownloadException.HashMismatch> { download() }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a body of the wrong size fails and deletes the part`() {
        server.enqueue(full(media.bytes + ByteArray(10)))
        val error = assertFailsWith<DownloadException.SizeMismatch> { download() }
        assertEquals(media.size + 10, error.actual)
        assertFalse(part.exists())
        assertFalse(target.exists())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `an over-long body without Content-Length is cut off`() {
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody(Buffer().write(media.bytes + ByteArray(10)), 8_192))
        assertFailsWith<DownloadException.SizeMismatch> { download() }
        assertFalse(part.exists())
        assertFalse(target.exists())
    }

    @Test
    fun `a Content-Range total that differs from the manifest is a size mismatch`() {
        part.writeBytes(media.bytes.copyOf(1_000))
        server.enqueue(ranged(1_000).setHeader("Content-Range", "bytes 1000-${media.size}/${media.size + 1}"))
        assertFailsWith<DownloadException.SizeMismatch> { download() }
        assertFalse(part.exists())
    }

    @Test
    fun `a dropped connection is retried with backoff and resumed`() {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val range = request.getHeader("Range") ?: return full().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                    return ranged(range.removePrefix("bytes=").removeSuffix("-").toInt())
                }
            }
        download()
        assertDownloaded()
        assertEquals(listOf(100L), sleeps)
        assertNull(server.takeRequest().getHeader("Range"))
        assertNotNull(server.takeRequest().getHeader("Range"))
    }

    @Test
    fun `server errors are retried with growing delays, then reported`() {
        repeat(3) { server.enqueue(MockResponse().setResponseCode(503)) }
        val error = assertFailsWith<IOException> { download() }
        assertFalse(error is DownloadException)
        assertEquals(listOf(100L, 200L), sleeps)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `401 means the token is gone`() {
        server.enqueue(MockResponse().setResponseCode(401))
        assertFailsWith<UnauthorizedException> { download() }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `404 is not retried and keeps the partial file`() {
        part.writeBytes(media.bytes.copyOf(1_000))
        server.enqueue(MockResponse().setResponseCode(404))
        val error = assertFailsWith<DownloadException.HttpError> { download() }
        assertEquals(404, error.httpStatus)
        assertTrue(part.exists())
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun `a complete part from an earlier run is verified without a request`() {
        part.writeBytes(media.bytes)
        download()
        assertDownloaded()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `paths that leave the server are refused`() {
        assertFailsWith<ProtocolException> {
            runBlocking { downloader.download(task(path = "//evil.example/steal"), part, target) }
        }
        assertEquals(0, server.requestCount)
    }
}
