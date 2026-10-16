package tv.managealltv.player.core

import java.io.File
import kotlin.random.Random
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.ManifestMedia
import tv.managealltv.player.core.protocol.ManifestPlaylist
import tv.managealltv.player.core.protocol.ManifestPlaylistItem
import tv.managealltv.player.core.protocol.ManifestSettings
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.protocol.ScheduleRule
import tv.managealltv.player.core.util.Hashing

/** The contract fixtures of packages/protocol (path set by the Gradle test task). */
object Fixtures {
    val dir: File by lazy {
        val path =
            System.getProperty("managealltv.protocolFixturesDir")
                ?: error("System property managealltv.protocolFixturesDir is not set (run the tests through Gradle)")
        File(path).also { check(it.isDirectory) { "Fixtures directory not found: $it" } }
    }

    fun read(name: String): String = File(dir, name).readText(Charsets.UTF_8)
}

/** Media with real bytes, so hashes and sizes in test manifests are genuine. */
class TestMedia(
    val id: String,
    val type: MediaType,
    val bytes: ByteArray,
    val durationMs: Long? = if (type == MediaType.VIDEO) 5_000 else null,
) {
    val sha256: String = Hashing.sha256Hex(bytes)
    val size: Long get() = bytes.size.toLong()

    fun toManifestMedia(): ManifestMedia =
        ManifestMedia(id = id, type = type, sha256 = sha256, size = size, durationMs = durationMs, path = "/api/device/v1/media/$id")

    companion object {
        fun random(id: String, size: Int, type: MediaType = MediaType.IMAGE, seed: Int = id.hashCode()): TestMedia =
            TestMedia(id, type, Random(seed).nextBytes(size))
    }
}

object TestManifests {
    /** A valid manifest: one default playlist "pl_main" with every media item in order. */
    fun manifest(
        version: Int,
        media: List<TestMedia>,
        playlists: List<ManifestPlaylist> =
            listOf(ManifestPlaylist("pl_main", "Ana liste", media.map { ManifestPlaylistItem(it.id, null) })),
        defaultPlaylistId: String? = playlists.firstOrNull()?.id,
        schedule: List<ScheduleRule> = emptyList(),
        timezone: String = "Europe/Istanbul",
    ): Manifest =
        Manifest(
            protocolVersion = 1,
            version = version,
            generatedAt = "2026-10-15T09:00:00.000Z",
            deviceId = "dev_test",
            deviceName = "Test TV",
            timezone = timezone,
            defaultPlaylistId = defaultPlaylistId,
            playlists = playlists,
            media = media.map { it.toManifestMedia() },
            schedule = schedule,
            settings = ManifestSettings(volume = 50, defaultImageDurationSec = 10),
        )
}
