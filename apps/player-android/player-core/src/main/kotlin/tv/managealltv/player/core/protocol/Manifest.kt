package tv.managealltv.player.core.protocol

import kotlinx.serialization.Serializable

/** packages/protocol/src/manifest.ts `ManifestMedia`. */
@Serializable
data class ManifestMedia(
    val id: String,
    val type: MediaType,
    /** Lowercase hex SHA-256 of the file. */
    val sha256: String,
    val size: Long,
    /** Video length; null for images. */
    val durationMs: Long?,
    /** Server-relative download path (supports HTTP Range), e.g. /api/device/v1/media/<id>. */
    val path: String,
)

/** packages/protocol/src/manifest.ts `ManifestPlaylistItem`. */
@Serializable
data class ManifestPlaylistItem(
    val mediaId: String,
    /** How long an image stays on screen; null for videos or to use the default. */
    val durationSec: Int?,
)

/** packages/protocol/src/manifest.ts `ManifestPlaylist`. */
@Serializable
data class ManifestPlaylist(
    val id: String,
    val name: String,
    val items: List<ManifestPlaylistItem>,
)

/**
 * packages/protocol/src/manifest.ts `ScheduleRule`. Times are "HH:MM" and dates "YYYY-MM-DD" in the
 * manifest's time zone; see [tv.managealltv.player.core.schedule.ScheduleEvaluator] for the semantics.
 */
@Serializable
data class ScheduleRule(
    val id: String,
    val playlistId: String,
    /** Empty means every day. */
    val days: List<Weekday>,
    val startTime: String,
    val endTime: String,
    val startDate: String?,
    val endDate: String?,
    val priority: Int,
)

/** The `settings` object of [Manifest]. */
@Serializable
data class ManifestSettings(
    /** Volume the device should apply (0-100); null leaves the TV's own volume alone. */
    val volume: Int?,
    /** Image duration when a playlist item has none. */
    val defaultImageDurationSec: Int,
)

/** packages/protocol/src/manifest.ts `Manifest` — the full desired state of one device. */
@Serializable
data class Manifest(
    val protocolVersion: Int,
    /** Increases every time the content changes; also sent as the ETag (`"<version>"`). */
    val version: Int,
    /** ISO-8601 timestamp. */
    val generatedAt: String,
    val deviceId: String,
    val deviceName: String,
    /** IANA time zone used to evaluate the schedule, e.g. Europe/Istanbul. */
    val timezone: String,
    /** Plays when no schedule rule is active; null means a blank screen. */
    val defaultPlaylistId: String?,
    val playlists: List<ManifestPlaylist>,
    /** Every media item referenced by any playlist, exactly once. */
    val media: List<ManifestMedia>,
    val schedule: List<ScheduleRule>,
    val settings: ManifestSettings,
) {
    fun playlist(id: String): ManifestPlaylist? = playlists.firstOrNull { it.id == id }

    fun media(id: String): ManifestMedia? = media.firstOrNull { it.id == id }

    /**
     * Port of `manifestIssues()`: referential checks the schema cannot express, with the same
     * messages. Empty means valid; the device refuses to apply a manifest with issues.
     */
    fun issues(): List<String> {
        val issues = mutableListOf<String>()
        val mediaIds = linkedSetOf<String>()
        for (item in media) {
            if (!mediaIds.add(item.id)) issues += "duplicate media ${item.id}"
        }
        val playlistIds = mutableSetOf<String>()
        val referenced = mutableSetOf<String>()
        for (playlist in playlists) {
            if (!playlistIds.add(playlist.id)) issues += "duplicate playlist ${playlist.id}"
            for (item in playlist.items) {
                referenced += item.mediaId
                if (item.mediaId !in mediaIds) {
                    issues += "playlist ${playlist.id} references unknown media ${item.mediaId}"
                }
            }
        }
        for (id in mediaIds) {
            if (id !in referenced) issues += "media $id is not used by any playlist"
        }
        if (defaultPlaylistId != null && defaultPlaylistId !in playlistIds) {
            issues += "unknown default playlist $defaultPlaylistId"
        }
        for (rule in schedule) {
            if (rule.playlistId !in playlistIds) {
                issues += "rule ${rule.id} references unknown playlist ${rule.playlistId}"
            }
        }
        return issues
    }
}
