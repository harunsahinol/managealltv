package tv.managealltv.player.playback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.logic.ImageSampling

object ImageDecoding {
    /**
     * Decodes [file] (cache files have no extension; BitmapFactory sniffs the format) downsampled to
     * roughly [maxWidth] × [maxHeight]. Returns null when the file is not a decodable image or the TV
     * runs out of memory.
     */
    suspend fun decode(file: File, maxWidth: Int, maxHeight: Int): Bitmap? =
        withContext(Dispatchers.IO) {
            try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    null
                } else {
                    val options =
                        BitmapFactory.Options().apply {
                            inSampleSize = ImageSampling.inSampleSize(bounds.outWidth, bounds.outHeight, maxWidth, maxHeight)
                        }
                    BitmapFactory.decodeFile(file.path, options)
                }
            } catch (e: OutOfMemoryError) {
                CoreLog.w(TAG, "Out of memory decoding ${file.name}")
                null
            }
        }

    private const val TAG = "ImageDecoding"
}
