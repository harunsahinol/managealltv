package tv.managealltv.player.core.sync

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import tv.managealltv.player.core.net.ServerUrls
import tv.managealltv.player.core.net.TokenProvider
import tv.managealltv.player.core.net.UnauthorizedException
import tv.managealltv.player.core.net.executeCancellable
import tv.managealltv.player.core.util.AtomicFiles
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.ExponentialBackoff
import tv.managealltv.player.core.util.Hashing

fun interface DownloadProgress {
    /** Bytes of this file on disk so far (including resumed bytes); may go back on a restart. */
    fun onProgress(bytesDone: Long, totalBytes: Long)

    companion object {
        val NONE: DownloadProgress = DownloadProgress { _, _ -> }
    }
}

/** Failures that retrying the same request would not fix. */
sealed class DownloadException(message: String) : IOException(message) {
    /** The bytes do not hash to the manifest's SHA-256. */
    class HashMismatch(val expected: String, val actual: String) :
        DownloadException("SHA-256 mismatch: expected $expected, got $actual")

    /** The server's file has a different size than the manifest says. */
    class SizeMismatch(val expected: Long, val actual: Long) :
        DownloadException("Size mismatch: expected $expected bytes, server has ${if (actual < 0) "unknown" else actual}")

    /** A status that will not change on retry, e.g. 404 when the media left this device's manifest. */
    class HttpError(val httpStatus: Int) : DownloadException("HTTP $httpStatus")
}

/**
 * Downloads one media file with OkHttp into a ".part" file, resuming it with a Range request,
 * verifying size and SHA-256 and only then renaming it atomically to its final place.
 *
 * - Network errors, 5xx, 408/429 and truncated bodies are retried with backoff (the part is kept).
 * - A 200 answer to a Range request restarts the file from the first byte.
 * - A hash mismatch deletes the part and restarts once from the first byte (after a power loss a
 *   part file can end in bytes that never reached the disk); a second mismatch means the server's
 *   file is not the one in the manifest and fails, like a size mismatch does at once.
 * - 401 throws [UnauthorizedException]; other 4xx throw [DownloadException.HttpError].
 */
class Downloader(
    private val httpClient: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val tokenProvider: TokenProvider,
    private val retryPolicy: RetryPolicy = RetryPolicy(),
    /** Waits between retries; replaced in tests. */
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    data class RetryPolicy(
        /** Attempts per file for transient failures. */
        val maxAttempts: Int = 5,
        val backoff: ExponentialBackoff = ExponentialBackoff(initialDelayMs = 2_000, maxDelayMs = 60_000),
    ) {
        init {
            require(maxAttempts >= 1) { "maxAttempts must be >= 1" }
        }
    }

    /** Downloads [task] to [targetFile] via [partFile]; returns [targetFile] once it is verified. */
    suspend fun download(
        task: DownloadTask,
        partFile: File,
        targetFile: File,
        progress: DownloadProgress = DownloadProgress.NONE,
    ): File {
        val url = ServerUrls.resolveServerPath(baseUrl, task.path)
        var failures = 0
        var restartedFromZero = false
        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                attempt(task, url, partFile, targetFile, progress)
                return targetFile
            } catch (e: DownloadException.HashMismatch) {
                partFile.delete()
                if (restartedFromZero) throw e
                restartedFromZero = true
                CoreLog.w(TAG, "${task.mediaId}: ${e.message}; starting over from the first byte")
            } catch (e: DownloadException) {
                if (e !is DownloadException.HttpError) partFile.delete()
                throw e
            } catch (e: UnauthorizedException) {
                throw e
            } catch (e: IOException) {
                // A cancelled call surfaces as IOException("Canceled"); report the cancellation instead.
                currentCoroutineContext().ensureActive()
                failures++
                if (failures >= retryPolicy.maxAttempts) throw e
                val waitMs = retryPolicy.backoff.delayMs(failures - 1)
                CoreLog.i(TAG, "${task.mediaId}: ${e.message}; retry $failures in $waitMs ms")
                sleep(waitMs)
            }
        }
    }

    private suspend fun attempt(
        task: DownloadTask,
        url: HttpUrl,
        part: File,
        target: File,
        progress: DownloadProgress,
    ) {
        var offset = if (part.isFile) part.length() else 0L
        if (offset > task.size) {
            part.delete()
            offset = 0
        }
        if (offset == task.size) {
            // An earlier run received everything but stopped before the rename.
            verifyAndMove(task, part, target, Hashing.sha256Hex(part))
            progress.onProgress(task.size, task.size)
            return
        }
        val token = tokenProvider.token() ?: throw UnauthorizedException()
        val request =
            Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                // Byte ranges refer to the stored file; transparent gzip would make them meaningless.
                .header("Accept-Encoding", "identity")
                .apply { if (offset > 0) header("Range", "bytes=$offset-") }
                .get()
                .build()
        httpClient.newCall(request).executeCancellable { response ->
            val start = startOffset(response, offset, task, part)
            receive(response, task, part, target, start, progress)
        }
    }

    /** Where the response body starts in the file; validates the status and declared size. */
    private fun startOffset(response: Response, offset: Long, task: DownloadTask, part: File): Long =
        when (response.code) {
            206 -> {
                val range = ContentRange.parse(response.header("Content-Range"))
                if (range == null || range.start != offset) {
                    // Cannot append a range we did not ask for; begin again.
                    part.delete()
                    throw IOException("Unexpected Content-Range ${response.header("Content-Range")} for offset $offset")
                }
                if (range.total != null && range.total != task.size) throw DownloadException.SizeMismatch(task.size, range.total)
                offset
            }
            200 -> {
                val length = response.body?.contentLength() ?: -1L
                if (length >= 0 && length != task.size) throw DownloadException.SizeMismatch(task.size, length)
                if (offset > 0) CoreLog.i(TAG, "${task.mediaId}: server ignored Range, starting over")
                0L
            }
            401 -> throw UnauthorizedException()
            416 -> {
                part.delete()
                throw IOException("Range not satisfiable for offset $offset")
            }
            408, 429 -> throw IOException("HTTP ${response.code}")
            in 500..599 -> throw IOException("HTTP ${response.code}")
            else -> throw DownloadException.HttpError(response.code)
        }

    private suspend fun receive(
        response: Response,
        task: DownloadTask,
        part: File,
        target: File,
        start: Long,
        progress: DownloadProgress,
    ) {
        val body = response.body ?: throw IOException("Empty response body")
        val digest = Hashing.sha256()
        if (start > 0) Hashing.update(digest, part)
        var written = start
        progress.onProgress(written, task.size)
        FileOutputStream(part, start > 0).use { out ->
            body.byteStream().use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (written + read > task.size) throw DownloadException.SizeMismatch(task.size, written + read)
                    out.write(buffer, 0, read)
                    digest.update(buffer, 0, read)
                    written += read
                    progress.onProgress(written, task.size)
                }
            }
            out.flush()
            // The rename must not reach the disk before the data does (power cuts are common).
            out.fd.sync()
        }
        if (written < task.size) throw IOException("Connection closed after $written of ${task.size} bytes")
        verifyAndMove(task, part, target, Hashing.toHex(digest.digest()))
    }

    private fun verifyAndMove(task: DownloadTask, part: File, target: File, actual: String) {
        if (actual != task.sha256) throw DownloadException.HashMismatch(task.sha256, actual)
        val parent = target.absoluteFile.parentFile
        if (parent != null && !parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create $parent")
        AtomicFiles.replace(part, target)
    }

    /** `Content-Range: bytes <start>-<end>/<total|*>` */
    private data class ContentRange(val start: Long, val end: Long, val total: Long?) {
        companion object {
            private val PATTERN = Regex("""^bytes (\d+)-(\d+)/(\d+|\*)$""")

            fun parse(value: String?): ContentRange? {
                val match = PATTERN.matchEntire(value?.trim() ?: return null) ?: return null
                val (start, end, total) = match.destructured
                return ContentRange(start.toLong(), end.toLong(), total.toLongOrNull())
            }
        }
    }

    private companion object {
        const val TAG = "Downloader"
        const val BUFFER_SIZE = 64 * 1024
    }
}
