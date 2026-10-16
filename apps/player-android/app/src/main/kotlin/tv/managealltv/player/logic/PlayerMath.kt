package tv.managealltv.player.logic

import java.time.Instant
import kotlin.math.roundToInt

/** BitmapFactory sampling: decode large images close to the screen size instead of at full size. */
object ImageSampling {
    /**
     * Largest power of two that still leaves the decoded image at least as large as it is drawn when
     * fitted (fitCenter) into [maxWidth] × [maxHeight]. Weak TVs have little RAM; a 4000×3000 photo
     * decoded in full would take 48 MB.
     */
    fun inSampleSize(width: Int, height: Int, maxWidth: Int, maxHeight: Int): Int {
        if (width <= 0 || height <= 0 || maxWidth <= 0 || maxHeight <= 0) return 1
        val ratio = maxOf(width.toDouble() / maxWidth, height.toDouble() / maxHeight)
        var sample = 1
        while (sample * 2 <= ratio) sample *= 2
        return sample
    }
}

/** Converts between the protocol's 0-100 volume and the device's STREAM_MUSIC steps. */
object VolumeMath {
    fun toStreamIndex(percent: Int, maxIndex: Int): Int {
        if (maxIndex <= 0) return 0
        return (percent.coerceIn(0, 100) * maxIndex / 100.0).roundToInt().coerceIn(0, maxIndex)
    }

    fun toPercent(index: Int, maxIndex: Int): Int {
        if (maxIndex <= 0) return 0
        return (index.coerceIn(0, maxIndex) * 100.0 / maxIndex).roundToInt().coerceIn(0, 100)
    }
}

object PairingCodeFormat {
    /** "482913" → "482 913": two groups are easier to read from across the room and to type. */
    fun forDisplay(code: String): String =
        if (code.length == 6 && code.all { it in '0'..'9' }) code.substring(0, 3) + " " + code.substring(3) else code
}

object ClockTrust {
    /**
     * A TV that lost power may boot with a clock in 1970 or 2000 until NTP answers. The schedule must
     * not be evaluated against such a time; null makes the planner fall back to the default playlist
     * (ARCHITECTURE §16).
     */
    private val EARLIEST_PLAUSIBLE: Instant = Instant.parse("2025-01-01T00:00:00Z")

    fun trustedOrNull(now: Instant): Instant? = now.takeIf { !it.isBefore(EARLIEST_PLAUSIBLE) }
}

object StatusText {
    /**
     * `DeviceStatus.lastError` carries one message; a sync failure matters more than one media item
     * that would not play, so it wins. Both are cut to the protocol limit.
     */
    fun mergeLastError(syncError: String?, playbackError: String?, maxLength: Int): String? =
        (syncError ?: playbackError)?.take(maxLength)
}
