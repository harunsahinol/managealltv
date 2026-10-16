package tv.managealltv.player.core.sync

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tv.managealltv.player.core.TestManifests
import tv.managealltv.player.core.TestMedia
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.protocol.ManifestPlaylist
import tv.managealltv.player.core.protocol.ManifestPlaylistItem
import tv.managealltv.player.core.protocol.MediaType

class SyncPlannerTest {
    @TempDir
    lateinit var dir: File

    private val video = TestMedia.random("med_video", 5_000, MediaType.VIDEO)
    private val image = TestMedia.random("med_image", 1_000)
    private val other = TestMedia.random("med_other", 3_000)

    @Test
    fun `missing files are downloaded, present ones are not`() {
        val cache = MediaCache(dir)
        cache.contentFile(image.sha256).writeBytes(image.bytes)
        val plan = SyncPlanner.plan(TestManifests.manifest(1, listOf(video, image)), cache)

        assertEquals(listOf(video.id), plan.downloads.map { it.mediaId })
        assertEquals(2, plan.totalFiles)
        assertEquals(video.size + image.size, plan.totalBytes)
        assertEquals(1, plan.presentFiles)
        assertEquals(image.size, plan.presentBytes)
        assertEquals(video.size, plan.downloadBytes)
    }

    @Test
    fun `downloads are deduplicated by media id and by content`() {
        val alias = TestMedia("med_alias", MediaType.IMAGE, image.bytes)
        val manifest =
            TestManifests.manifest(1, listOf(image, alias)).let {
                // A duplicate id cannot come from a valid server, but must not cause two downloads.
                it.copy(media = it.media + it.media.first())
            }
        val plan = SyncPlanner.plan(manifest, MediaCache(dir))
        assertEquals(1, plan.downloads.size)
        assertEquals(1, plan.totalFiles)
        assertEquals(image.size, plan.totalBytes)
    }

    @Test
    fun `resumed bytes reduce the space needed`() {
        val cache = MediaCache(dir)
        cache.partialFile(video.sha256).writeBytes(video.bytes.copyOf(2_000))
        val plan = SyncPlanner.plan(TestManifests.manifest(1, listOf(video)), cache)
        assertEquals(2_000, plan.downloads.single().partialBytes)
        assertEquals(video.size - 2_000, plan.requiredFreeBytes)
    }

    @Test
    fun `old content is deleted only after apply and kept until then`() {
        val cache = MediaCache(dir)
        val applied = TestManifests.manifest(1, listOf(video, image))
        val next =
            TestManifests.manifest(
                2,
                listOf(image, other),
                playlists = listOf(ManifestPlaylist("pl_main", "Ana", listOf(ManifestPlaylistItem(image.id, 5), ManifestPlaylistItem(other.id, null)))),
            )
        val plan = SyncPlanner.plan(next, cache, applied)
        assertEquals(setOf(video.sha256), plan.deleteAfterApply)
        assertEquals(setOf(video.sha256, image.sha256, other.sha256), plan.keepBeforeApply)
    }

    @Test
    fun `storage budget keeps a reserve`() {
        val plan = SyncPlanner.plan(TestManifests.manifest(1, listOf(video)), MediaCache(dir))
        val reserve = 1_000L
        assertIs<StorageBudget.Sufficient>(SyncPlanner.checkBudget(plan, availableBytes = video.size + reserve, reserveBytes = reserve))
        val insufficient = assertIs<StorageBudget.Insufficient>(SyncPlanner.checkBudget(plan, availableBytes = video.size + reserve - 1, reserveBytes = reserve))
        assertEquals(1, insufficient.shortfallBytes)
        assertEquals(300L * 1024 * 1024, SyncPlanner.DEFAULT_RESERVE_BYTES)
    }

    @Test
    fun `nothing to download always fits`() {
        val cache = MediaCache(dir)
        cache.contentFile(image.sha256).writeBytes(image.bytes)
        val plan = SyncPlanner.plan(TestManifests.manifest(1, listOf(image)), cache)
        assertTrue(plan.isComplete)
        assertIs<StorageBudget.Sufficient>(SyncPlanner.checkBudget(plan, availableBytes = 0))
    }

    @Test
    fun `validation rejects what the device cannot use safely`() {
        val manifest = TestManifests.manifest(1, listOf(image))
        val bad =
            manifest.copy(
                protocolVersion = 2,
                media = listOf(manifest.media.single().copy(sha256 = "../x", path = "//evil.example/x")),
                defaultPlaylistId = "pl_missing",
            )
        val issues = SyncPlanner.validate(bad)
        assertTrue(issues.any { it.contains("protocol version") }, issues.toString())
        assertTrue(issues.any { it.contains("invalid sha256") }, issues.toString())
        assertTrue(issues.any { it.contains("invalid path") }, issues.toString())
        assertTrue(issues.any { it.contains("unknown default playlist") }, issues.toString())
        assertEquals(emptyList(), SyncPlanner.validate(manifest))
    }
}
