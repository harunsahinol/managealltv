package tv.managealltv.player.core.sync

import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.protocol.ProtocolConstants
import tv.managealltv.player.core.util.Hashing

/** One file to fetch. Several media ids with identical content share one task. */
data class DownloadTask(
    /** The first manifest media with this content; its path is used for the request. */
    val mediaId: String,
    val type: MediaType,
    val sha256: String,
    val size: Long,
    /** Server-relative path, e.g. /api/device/v1/media/<id>. */
    val path: String,
    /** Bytes already in the partial file when the plan was made; the download resumes there. */
    val partialBytes: Long,
)

/** What it takes to get from the cache to [manifest]. */
data class SyncPlan(
    val manifest: Manifest,
    val downloads: List<DownloadTask>,
    /** Every distinct content (SHA-256 → size) the manifest needs. */
    val requiredContent: Map<String, Long>,
    /** Content of the applied manifest the new one no longer needs; deleted only after applying. */
    val deleteAfterApply: Set<String>,
    /** Content of the applied manifest; together with [requiredContent] it must survive until applying. */
    val appliedContent: Set<String>,
) {
    /** Distinct files of the manifest. */
    val totalFiles: Int get() = requiredContent.size

    /** Size of all distinct files of the manifest. */
    val totalBytes: Long get() = requiredContent.values.sum()

    val presentFiles: Int get() = totalFiles - downloads.size

    val presentBytes: Long get() = totalBytes - downloadBytes

    /** Sum of the sizes of the files to download. */
    val downloadBytes: Long get() = downloads.sumOf { it.size }

    /** Disk space the downloads still need; resumed bytes already sit on the disk. */
    val requiredFreeBytes: Long get() = downloads.sumOf { it.size - it.partialBytes }

    val isComplete: Boolean get() = downloads.isEmpty()

    /** Content that may not be deleted before the new manifest is applied. */
    val keepBeforeApply: Set<String> get() = requiredContent.keys + appliedContent
}

sealed interface StorageBudget {
    data class Sufficient(val requiredBytes: Long, val availableBytes: Long, val reserveBytes: Long) : StorageBudget

    data class Insufficient(val requiredBytes: Long, val availableBytes: Long, val reserveBytes: Long) : StorageBudget {
        /** How much more space would make the sync possible. */
        val shortfallBytes: Long get() = requiredBytes + reserveBytes - availableBytes
    }
}

object SyncPlanner {
    /** Free space left untouched by downloads, so the TV's own system keeps working. */
    const val DEFAULT_RESERVE_BYTES: Long = 300L * 1024 * 1024

    /**
     * Compares [manifest] with the cache. A media item is present when its verified file exists
     * with the expected size; everything else is downloaded once per distinct content (deduplicated
     * by media id and by SHA-256). [applied] is the manifest currently playing, whose files must
     * survive until the new one is applied.
     */
    fun plan(manifest: Manifest, cache: MediaCache, applied: Manifest? = null): SyncPlan {
        val required = LinkedHashMap<String, Long>()
        val downloads = ArrayList<DownloadTask>()
        val seenIds = HashSet<String>()
        for (media in manifest.media) {
            if (!seenIds.add(media.id)) continue
            if (required.containsKey(media.sha256)) continue
            required[media.sha256] = media.size
            if (cache.verifiedFile(media.sha256, media.size) != null) continue
            val partial = cache.partialBytes(media.sha256)
            downloads +=
                DownloadTask(
                    mediaId = media.id,
                    type = media.type,
                    sha256 = media.sha256,
                    size = media.size,
                    path = media.path,
                    // A partial file larger than the target is discarded by the downloader.
                    partialBytes = if (partial <= media.size) partial else 0L,
                )
        }
        val appliedContent = applied?.media?.mapTo(LinkedHashSet()) { it.sha256 }.orEmpty()
        return SyncPlan(
            manifest = manifest,
            downloads = downloads,
            requiredContent = required,
            deleteAfterApply = appliedContent - required.keys,
            appliedContent = appliedContent,
        )
    }

    /** Whether [plan]'s downloads fit into [availableBytes] while keeping [reserveBytes] free. */
    fun checkBudget(
        plan: SyncPlan,
        availableBytes: Long,
        reserveBytes: Long = DEFAULT_RESERVE_BYTES,
    ): StorageBudget {
        val required = plan.requiredFreeBytes
        if (required == 0L) return StorageBudget.Sufficient(0, availableBytes, reserveBytes)
        return if (required + reserveBytes <= availableBytes) {
            StorageBudget.Sufficient(required, availableBytes, reserveBytes)
        } else {
            StorageBudget.Insufficient(required, availableBytes, reserveBytes)
        }
    }

    /**
     * Device-side checks before a manifest is used: the referential checks of `manifestIssues()` plus
     * the format rules the device relies on (SHA-256 names files, paths are requested with the token).
     */
    fun validate(manifest: Manifest): List<String> {
        val issues = ArrayList<String>()
        if (manifest.protocolVersion != ProtocolConstants.PROTOCOL_VERSION) {
            issues += "unsupported protocol version ${manifest.protocolVersion}"
        }
        for (media in manifest.media) {
            if (!Hashing.isSha256Hex(media.sha256)) issues += "media ${media.id} has an invalid sha256"
            if (media.size <= 0) issues += "media ${media.id} has an invalid size ${media.size}"
            if (!media.path.startsWith("/") || media.path.startsWith("//")) issues += "media ${media.id} has an invalid path"
        }
        issues += manifest.issues()
        return issues
    }
}
