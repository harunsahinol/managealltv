package tv.managealltv.player.core.cache

import java.io.File
import java.io.IOException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.ManifestMedia
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.util.AtomicFiles
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.Hashing

/** One downloaded media item in the cache index. */
@Serializable
data class CachedMedia(
    val id: String,
    val sha256: String,
    val size: Long,
    /** Relative to the cache root, e.g. "media/<sha256>". */
    val path: String,
)

data class GarbageReport(val deletedFiles: Int, val freedBytes: Long)

/**
 * The device's local media store:
 *
 * ```
 * <root>/media/<sha256>         verified files (content-addressed)
 * <root>/partial/<sha256>.part  downloads in progress (resumable)
 * <root>/index.json             media id → file, rewritten atomically
 * <root>/manifest.json          the applied manifest, rewritten atomically
 * ```
 *
 * Files are named by their SHA-256 and only ever reach `media/` by an atomic rename after the hash
 * was verified, so a file there with the expected size is trusted without re-hashing gigabytes on
 * every boot. Content addressing also means media shared by several ids, or re-uploaded under a new
 * id, is stored and downloaded once. Thread-safe.
 */
class MediaCache(
    rootDir: File,
    private val json: Json = ProtocolJson.default,
) {
    val rootDir: File = rootDir.absoluteFile
    val mediaDir: File = File(this.rootDir, "media")
    val partialDir: File = File(this.rootDir, "partial")
    private val indexFile = File(this.rootDir, "index.json")
    private val manifestFile = File(this.rootDir, "manifest.json")

    private val lock = Any()
    private val index = LinkedHashMap<String, CachedMedia>()

    init {
        for (dir in listOf(this.rootDir, mediaDir, partialDir)) {
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create $dir")
        }
        for (entry in readIndex()) index[entry.id] = entry
    }

    fun entries(): List<CachedMedia> = synchronized(lock) { index.values.toList() }

    fun entry(mediaId: String): CachedMedia? = synchronized(lock) { index[mediaId] }

    /** Final location of the content with [sha256]. */
    fun contentFile(sha256: String): File = File(mediaDir, checkedSha(sha256))

    /** Where the download of [sha256] accumulates until it is verified. */
    fun partialFile(sha256: String): File = File(partialDir, checkedSha(sha256) + PART_SUFFIX)

    /** The verified file for this content, or null when it is missing or has the wrong size. */
    fun verifiedFile(sha256: String, size: Long): File? {
        if (!Hashing.isSha256Hex(sha256)) return null
        val file = File(mediaDir, sha256)
        return if (file.isFile && file.length() == size) file else null
    }

    fun fileFor(media: ManifestMedia): File? = verifiedFile(media.sha256, media.size)

    /** Bytes already downloaded for [sha256] (0 when there is no partial file). */
    fun partialBytes(sha256: String): Long {
        val file = partialFile(sha256)
        return if (file.isFile) file.length() else 0L
    }

    /** Adds or replaces index entries for [media] and persists the index. */
    fun record(media: Collection<ManifestMedia>) {
        if (media.isEmpty()) return
        synchronized(lock) {
            for (item in media) {
                index[item.id] = CachedMedia(item.id, item.sha256, item.size, "media/${checkedSha(item.sha256)}")
            }
            persistIndex()
        }
    }

    /**
     * Deletes every file in `media/` whose content is not in [keepSha256], every partial download not
     * in [keepPartials] and the index entries pointing to deleted content. When [keepMediaIds] is
     * given, index entries for other ids are dropped too (their content may live on under another id).
     */
    fun collectGarbage(
        keepSha256: Set<String>,
        keepPartials: Set<String> = emptySet(),
        keepMediaIds: Set<String>? = null,
    ): GarbageReport {
        synchronized(lock) {
            var deleted = 0
            var freed = 0L
            fun remove(file: File) {
                val length = file.length()
                if (file.deleteRecursively()) {
                    deleted++
                    freed += length
                } else {
                    CoreLog.w(TAG, "Cannot delete $file")
                }
            }
            mediaDir.listFiles()?.forEach { if (it.name !in keepSha256) remove(it) }
            partialDir.listFiles()?.forEach {
                val sha = it.name.removeSuffix(PART_SUFFIX)
                if (!it.name.endsWith(PART_SUFFIX) || sha !in keepPartials) remove(it)
            }
            val sizeBefore = index.size
            index.values.removeAll { it.sha256 !in keepSha256 || (keepMediaIds != null && it.id !in keepMediaIds) }
            if (index.size != sizeBefore) persistIndex()
            if (deleted > 0) CoreLog.i(TAG, "Deleted $deleted unused files ($freed bytes)")
            return GarbageReport(deleted, freed)
        }
    }

    /** The last applied manifest, or null before the first sync or when the file is unreadable. */
    fun loadAppliedManifest(): Manifest? {
        if (!manifestFile.isFile) return null
        return try {
            json.decodeFromString(Manifest.serializer(), manifestFile.readText(Charsets.UTF_8))
        } catch (e: IllegalArgumentException) {
            CoreLog.e(TAG, "Applied manifest is unreadable; starting without one", e)
            null
        } catch (e: IOException) {
            CoreLog.e(TAG, "Applied manifest is unreadable; starting without one", e)
            null
        }
    }

    /** Makes [manifest] the applied one. Atomic: after a crash the old or the new one is on disk. */
    fun saveAppliedManifest(manifest: Manifest) {
        synchronized(lock) {
            AtomicFiles.writeText(manifestFile, json.encodeToString(Manifest.serializer(), manifest))
        }
    }

    private fun readIndex(): List<CachedMedia> {
        if (!indexFile.isFile) return emptyList()
        return try {
            json.decodeFromString(IndexFile.serializer(), indexFile.readText(Charsets.UTF_8))
                .entries
                .filter { Hashing.isSha256Hex(it.sha256) }
        } catch (e: IllegalArgumentException) {
            // The index is only bookkeeping; the files themselves are content-addressed and verified.
            CoreLog.w(TAG, "Cache index is unreadable; starting with an empty one", e)
            emptyList()
        } catch (e: IOException) {
            CoreLog.w(TAG, "Cache index is unreadable; starting with an empty one", e)
            emptyList()
        }
    }

    private fun persistIndex() {
        val text = json.encodeToString(IndexFile.serializer(), IndexFile(FORMAT_VERSION, index.values.toList()))
        AtomicFiles.writeText(indexFile, text)
    }

    @Serializable
    private data class IndexFile(val formatVersion: Int, val entries: List<CachedMedia>)

    private companion object {
        const val TAG = "MediaCache"
        const val PART_SUFFIX = ".part"
        const val FORMAT_VERSION = 1

        /** File names are built from server data; only a SHA-256 hex string is a safe name. */
        fun checkedSha(sha256: String): String {
            require(Hashing.isSha256Hex(sha256)) { "Not a lowercase SHA-256 hex string: $sha256" }
            return sha256
        }
    }
}
