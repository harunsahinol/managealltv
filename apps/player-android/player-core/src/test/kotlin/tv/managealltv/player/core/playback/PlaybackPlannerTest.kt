package tv.managealltv.player.core.playback

import java.io.File
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tv.managealltv.player.core.Fixtures
import tv.managealltv.player.core.TestManifests
import tv.managealltv.player.core.TestMedia
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.core.protocol.ProtocolJson

class PlaybackPlannerTest {
    private val manifest = ProtocolJson.strict.decodeFromString(Manifest.serializer(), Fixtures.read("manifest.json"))
    private val everything = PlaybackPlanner { File("/cache/${it.id}") }

    @Test
    fun `weekday lunch plays the lunch playlist with its own image duration`() {
        val plan = everything.plan(manifest, Instant.parse("2026-10-14T09:00:00Z")) // Wed 12:00 Istanbul
        assertEquals("pl_lunch", plan.playlistId)
        assertEquals("sch_lunch", plan.ruleId)
        assertEquals(listOf(PlayItem("med_image2", MediaType.IMAGE, File("/cache/med_image2"), 20_000, null)), plan.items)
    }

    @Test
    fun `default playlist keeps order, plays videos to the end and uses the default image duration`() {
        val plan = everything.plan(manifest, Instant.parse("2026-10-17T09:00:00Z")) // Saturday
        assertEquals("pl_default", plan.playlistId)
        assertEquals(null, plan.ruleId)
        assertEquals(listOf("med_video1", "med_image1", "med_image2"), plan.items.map { it.mediaId })
        assertEquals(listOf(null, 15_000L, 10_000L), plan.items.map { it.imageDurationMs })
        assertEquals(31_500L, plan.items.first().videoDurationMs)
    }

    @Test
    fun `items without a local file are skipped`() {
        val planner = PlaybackPlanner { if (it.id == "med_video1") null else File("/cache/${it.id}") }
        val plan = planner.plan(manifest, Instant.parse("2026-10-17T09:00:00Z"))
        assertEquals(listOf("med_image1", "med_image2"), plan.items.map { it.mediaId })
        assertEquals(listOf("med_video1"), plan.missingMediaIds)
    }

    @Test
    fun `no manifest, no clock and no default playlist`() {
        assertEquals(PlaybackPlan.NOTHING, everything.plan(null, Instant.now()))
        assertEquals("pl_default", everything.plan(manifest, null).playlistId)
        val blank = everything.plan(manifest.copy(defaultPlaylistId = null), Instant.parse("2026-10-17T09:00:00Z"))
        assertEquals(null, blank.playlistId)
        assertTrue(blank.isEmpty)
    }

    @Test
    fun `uses verified files from the cache`(@TempDir dir: File) {
        val image = TestMedia.random("med_image", 1_000)
        val video = TestMedia.random("med_video", 3_000, MediaType.VIDEO)
        val cache = MediaCache(dir)
        cache.contentFile(image.sha256).writeBytes(image.bytes)
        cache.contentFile(video.sha256).writeBytes(video.bytes.copyOf(100)) // incomplete: not verified

        val plan = PlaybackPlanner(cache).plan(TestManifests.manifest(1, listOf(video, image)), Instant.now())

        assertEquals(listOf(cache.contentFile(image.sha256)), plan.items.map { it.file })
        assertEquals(listOf(video.id), plan.missingMediaIds)
    }
}
