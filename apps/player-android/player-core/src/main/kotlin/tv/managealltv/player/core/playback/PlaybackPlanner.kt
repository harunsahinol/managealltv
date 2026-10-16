package tv.managealltv.player.core.playback

import java.io.File
import java.time.Instant
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.ManifestMedia
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.schedule.ScheduleEvaluator

/** One entry of the play loop. */
data class PlayItem(
    val mediaId: String,
    val type: MediaType,
    /** The verified local file; never a network URL (offline-first, ARCHITECTURE §3). */
    val file: File,
    /** How long an image stays on screen; null for videos, which play to the end. */
    val imageDurationMs: Long?,
    /** Video length from the manifest; null for images or when unknown. */
    val videoDurationMs: Long?,
)

data class PlaybackPlan(
    /** Null: no rule is active and there is no default playlist — show a blank screen. */
    val playlistId: String?,
    /** The schedule rule that selected the playlist; null when the default applies. */
    val ruleId: String?,
    /** Items in playlist order, without those whose file is missing. */
    val items: List<PlayItem>,
    /** Media ids skipped because their file is not on the device. */
    val missingMediaIds: List<String>,
) {
    val isEmpty: Boolean get() = items.isEmpty()

    companion object {
        val NOTHING = PlaybackPlan(playlistId = null, ruleId = null, items = emptyList(), missingMediaIds = emptyList())
    }
}

/**
 * Turns the applied manifest and the current time into what to play. Pure apart from the file
 * lookup; call it again at every minute boundary
 * ([ScheduleEvaluator.millisUntilNextMinute]) and whenever the applied manifest changes.
 */
class PlaybackPlanner(private val resolveFile: (ManifestMedia) -> File?) {
    constructor(cache: MediaCache) : this(cache::fileFor)

    /** [now] null means the clock is not trustworthy: the default playlist plays (ARCHITECTURE §16). */
    fun plan(manifest: Manifest?, now: Instant?): PlaybackPlan {
        if (manifest == null) return PlaybackPlan.NOTHING
        val active = ScheduleEvaluator.resolveActivePlaylist(manifest, now)
        val playlist = active.playlistId?.let(manifest::playlist)
        if (playlist == null) {
            return PlaybackPlan(active.playlistId, active.ruleId, emptyList(), emptyList())
        }
        val mediaById = manifest.media.associateBy { it.id }
        val items = ArrayList<PlayItem>(playlist.items.size)
        val missing = ArrayList<String>()
        for (item in playlist.items) {
            val media = mediaById[item.mediaId]
            val file = media?.let(resolveFile)
            if (media == null || file == null) {
                missing += item.mediaId
                continue
            }
            val imageDurationMs =
                when (media.type) {
                    MediaType.IMAGE -> (item.durationSec ?: manifest.settings.defaultImageDurationSec) * 1000L
                    MediaType.VIDEO -> null
                }
            items +=
                PlayItem(
                    mediaId = media.id,
                    type = media.type,
                    file = file,
                    imageDurationMs = imageDurationMs,
                    videoDurationMs = if (media.type == MediaType.VIDEO) media.durationMs else null,
                )
        }
        return PlaybackPlan(playlist.id, active.ruleId, items, missing)
    }
}
