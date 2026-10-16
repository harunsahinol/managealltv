package tv.managealltv.player.device

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecList
import android.os.Build
import android.os.StatFs
import android.util.DisplayMetrics
import android.view.Display
import androidx.core.content.ContextCompat
import java.io.File
import java.util.Locale
import tv.managealltv.player.BuildConfig
import tv.managealltv.player.core.protocol.DeviceInfo

data class StorageStats(val freeBytes: Long, val totalBytes: Long)

/** Facts reported when pairing (ARCHITECTURE §7.4): model, Android version, screen, storage, decoders. */
object DeviceInfoCollector {
    fun collect(context: Context, hardwareId: String): DeviceInfo {
        val screen = screenSize(context)
        val storage = storageStats(context.filesDir)
        // Lengths are capped at the Zod limits of DeviceInfo so an odd vendor string cannot make the
        // server reject the pairing request.
        return DeviceInfo(
            hardwareId = hardwareId,
            manufacturer = Build.MANUFACTURER.orEmpty().take(100),
            model = Build.MODEL.orEmpty().take(100),
            androidVersion = Build.VERSION.RELEASE.orEmpty().take(20),
            sdkInt = Build.VERSION.SDK_INT,
            appVersionName = BuildConfig.VERSION_NAME.take(50),
            appVersionCode = BuildConfig.VERSION_CODE,
            screenWidth = screen.first,
            screenHeight = screen.second,
            freeStorageBytes = storage.freeBytes,
            totalStorageBytes = storage.totalBytes,
            videoDecoders = videoDecoders(),
        )
    }

    /** Free/total bytes of the volume holding [dir] (the media cache lives under filesDir). */
    fun storageStats(dir: File): StorageStats =
        try {
            val stat = StatFs(dir.path)
            StorageStats(stat.availableBytes.coerceAtLeast(0), stat.totalBytes.coerceAtLeast(0))
        } catch (e: IllegalArgumentException) {
            StorageStats(dir.usableSpace.coerceAtLeast(0), dir.totalSpace.coerceAtLeast(0))
        }

    /**
     * Real size of the default display in pixels (what the UI is laid out on). A Service has no window,
     * so this goes through DisplayManager instead of WindowManager.
     */
    @Suppress("DEPRECATION")
    fun screenSize(context: Context): Pair<Int, Int> {
        val display = ContextCompat.getSystemService(context, DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        if (display != null) {
            display.getRealMetrics(metrics)
        } else {
            metrics.setTo(context.resources.displayMetrics)
        }
        return metrics.widthPixels.coerceAtLeast(0) to metrics.heightPixels.coerceAtLeast(0)
    }

    /** Distinct video MIME types this TV can decode (hardware or software), e.g. "video/avc". */
    fun videoDecoders(): List<String> =
        try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
                .asSequence()
                .filter { !it.isEncoder }
                .flatMap { it.supportedTypes.asSequence() }
                .map { it.lowercase(Locale.ROOT) }
                .filter { it.startsWith("video/") }
                .map { it.take(100) }
                .distinct()
                .sorted()
                .take(200)
                .toList()
        } catch (e: RuntimeException) {
            // Some vendor media stacks throw while enumerating; pairing must not fail because of it.
            emptyList()
        }
}
