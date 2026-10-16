package tv.managealltv.player.logic

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerMathTest {
    @Test
    fun `sampling keeps the image at least as large as it is drawn`() {
        assertEquals(1, ImageSampling.inSampleSize(1920, 1080, 1920, 1080))
        assertEquals(1, ImageSampling.inSampleSize(1920, 1080, 1280, 720))
        assertEquals(2, ImageSampling.inSampleSize(4000, 3000, 1920, 1080))
        assertEquals(4, ImageSampling.inSampleSize(8000, 6000, 1920, 1080))
        assertEquals(1, ImageSampling.inSampleSize(800, 600, 1920, 1080))
        assertEquals(1, ImageSampling.inSampleSize(0, 0, 1920, 1080))
        assertEquals(1, ImageSampling.inSampleSize(4000, 3000, 0, 0))
    }

    @Test
    fun `volume converts both ways`() {
        assertEquals(0, VolumeMath.toStreamIndex(0, 15))
        assertEquals(15, VolumeMath.toStreamIndex(100, 15))
        assertEquals(11, VolumeMath.toStreamIndex(70, 15))
        assertEquals(15, VolumeMath.toStreamIndex(150, 15))
        assertEquals(0, VolumeMath.toStreamIndex(-5, 15))
        assertEquals(73, VolumeMath.toPercent(11, 15))
        assertEquals(100, VolumeMath.toPercent(15, 15))
        assertEquals(0, VolumeMath.toPercent(3, 0))
    }

    @Test
    fun `pairing code is grouped for display`() {
        assertEquals("482 913", PairingCodeFormat.forDisplay("482913"))
        assertEquals("48291", PairingCodeFormat.forDisplay("48291"))
        assertEquals("abcdef", PairingCodeFormat.forDisplay("abcdef"))
    }

    @Test
    fun `implausible clocks are not trusted`() {
        assertNull(ClockTrust.trustedOrNull(Instant.parse("1970-01-01T00:00:10Z")))
        assertNull(ClockTrust.trustedOrNull(Instant.parse("2000-01-01T00:00:00Z")))
        val now = Instant.parse("2026-10-16T09:00:00Z")
        assertEquals(now, ClockTrust.trustedOrNull(now))
    }

    @Test
    fun `sync error wins over playback error and is truncated`() {
        assertEquals("sync", StatusText.mergeLastError("sync", "play", 1000))
        assertEquals("play", StatusText.mergeLastError(null, "play", 1000))
        assertNull(StatusText.mergeLastError(null, null, 1000))
        assertEquals("ab", StatusText.mergeLastError("abc", null, 2))
    }
}
