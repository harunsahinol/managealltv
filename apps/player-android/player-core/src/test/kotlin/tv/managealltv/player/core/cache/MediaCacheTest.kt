package tv.managealltv.player.core.cache

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tv.managealltv.player.core.TestManifests
import tv.managealltv.player.core.TestMedia

class MediaCacheTest {
    @TempDir
    lateinit var dir: File

    private val a = TestMedia.random("med_a", 1_000)
    private val b = TestMedia.random("med_b", 2_000)

    private fun store(cache: MediaCache, media: TestMedia) {
        cache.contentFile(media.sha256).writeBytes(media.bytes)
    }

    @Test
    fun `index survives a restart and holds id, hash, size and path`() {
        val cache = MediaCache(dir)
        store(cache, a)
        cache.record(listOf(a.toManifestMedia()))

        val reopened = MediaCache(dir)
        assertEquals(listOf(CachedMedia(a.id, a.sha256, a.size, "media/${a.sha256}")), reopened.entries())
        assertEquals(cache.contentFile(a.sha256), reopened.fileFor(a.toManifestMedia()))
        assertFalse(File(dir, "index.json.tmp").exists(), "atomic write leaves no temp file")
    }

    @Test
    fun `a corrupt index starts empty instead of failing`() {
        File(dir, "index.json").writeText("{ not json")
        assertEquals(emptyList(), MediaCache(dir).entries())
    }

    @Test
    fun `verified file requires the exact size`() {
        val cache = MediaCache(dir)
        cache.contentFile(a.sha256).writeBytes(a.bytes.copyOf(10))
        assertNull(cache.fileFor(a.toManifestMedia()))
        store(cache, a)
        assertEquals(cache.contentFile(a.sha256), cache.fileFor(a.toManifestMedia()))
    }

    @Test
    fun `file names must be SHA-256 hex`() {
        val cache = MediaCache(dir)
        assertFailsWith<IllegalArgumentException> { cache.contentFile("../../etc/passwd") }
        assertNull(cache.verifiedFile("../index.json", 10))
    }

    @Test
    fun `garbage collection keeps referenced content and wanted partials`() {
        val cache = MediaCache(dir)
        store(cache, a)
        store(cache, b)
        cache.record(listOf(a.toManifestMedia(), b.toManifestMedia()))
        cache.partialFile(a.sha256).writeBytes(ByteArray(5))
        cache.partialFile(b.sha256).writeBytes(ByteArray(7))
        File(cache.mediaDir, "junk.tmp").writeText("x")

        val report = cache.collectGarbage(keepSha256 = setOf(a.sha256), keepPartials = setOf(b.sha256))

        assertEquals(3, report.deletedFiles)
        assertEquals(b.size + 5 + 1, report.freedBytes)
        assertTrue(cache.contentFile(a.sha256).exists())
        assertFalse(cache.contentFile(b.sha256).exists())
        assertTrue(cache.partialFile(b.sha256).exists())
        assertEquals(listOf(a.id), cache.entries().map { it.id })
        assertEquals(listOf(a.id), MediaCache(dir).entries().map { it.id })
    }

    @Test
    fun `index entries can be limited to the applied ids`() {
        val cache = MediaCache(dir)
        store(cache, a)
        val alias = a.toManifestMedia().copy(id = "med_alias")
        cache.record(listOf(a.toManifestMedia(), alias))
        cache.collectGarbage(keepSha256 = setOf(a.sha256), keepMediaIds = setOf("med_alias"))
        assertEquals(listOf("med_alias"), cache.entries().map { it.id })
        assertTrue(cache.contentFile(a.sha256).exists())
    }

    @Test
    fun `applied manifest is persisted`() {
        val cache = MediaCache(dir)
        assertNull(cache.loadAppliedManifest())
        val manifest = TestManifests.manifest(3, listOf(a, b))
        cache.saveAppliedManifest(manifest)
        assertEquals(manifest, MediaCache(dir).loadAppliedManifest())

        File(dir, "manifest.json").writeText("""{"protocolVersion":1}""")
        assertNull(MediaCache(dir).loadAppliedManifest())
    }
}
