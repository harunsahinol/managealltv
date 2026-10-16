package tv.managealltv.player.core.sync

import java.util.Locale

/** Why the last sync failed. [message] is Turkish: it is reported as `DeviceStatus.lastError`. */
sealed interface SyncError {
    val message: String

    /** The token is missing or was rejected: the app must pair again. */
    data object Unauthorized : SyncError {
        override val message: String get() = "Cihaz yetkisi geçersiz; yeniden eşleştirme gerekiyor"
    }

    data class Network(val detail: String?) : SyncError {
        override val message: String get() = "Sunucuya ulaşılamadı" + (detail?.let { ": $it" } ?: "")
    }

    data class Server(val httpStatus: Int, val code: String?) : SyncError {
        override val message: String get() = "Sunucu hatası (HTTP $httpStatus" + (code?.let { ", $it" } ?: "") + ")"
    }

    data class InvalidManifest(val issues: List<String>) : SyncError {
        override val message: String get() = "Sunucudan gelen manifest geçersiz: " + issues.take(3).joinToString("; ")
    }

    data class InsufficientStorage(val requiredBytes: Long, val availableBytes: Long, val reserveBytes: Long) : SyncError {
        override val message: String
            get() = "Yetersiz depolama alanı: indirme için ${formatBytes(requiredBytes)} ve " +
                "${formatBytes(reserveBytes)} yedek alan gerekli, ${formatBytes(availableBytes)} boş"
    }

    data class DownloadFailed(val mediaId: String, val reason: Reason, val detail: String?) : SyncError {
        enum class Reason { HASH_MISMATCH, SIZE_MISMATCH, HTTP_ERROR, NETWORK }

        override val message: String
            get() {
                val what =
                    when (reason) {
                        Reason.HASH_MISMATCH -> "dosya doğrulanamadı (SHA-256 uyuşmuyor)"
                        Reason.SIZE_MISMATCH -> "dosya boyutu manifestle uyuşmuyor"
                        Reason.HTTP_ERROR -> "sunucu dosyayı vermedi"
                        Reason.NETWORK -> "bağlantı hatası"
                    }
                return "$mediaId indirilemedi: $what" + (detail?.let { " ($it)" } ?: "")
            }
    }

    /** Files of the new manifest vanished between download and apply (e.g. storage removed). */
    data class FilesMissing(val mediaIds: List<String>) : SyncError {
        override val message: String get() = "İndirilen dosyalar bulunamadı: " + mediaIds.take(5).joinToString(", ")
    }

    data class Unexpected(val detail: String?) : SyncError {
        override val message: String get() = "Beklenmeyen hata" + (detail?.let { ": $it" } ?: "")
    }

    companion object {
        /** "1,5 GB" style sizes for Turkish messages. */
        fun formatBytes(bytes: Long): String {
            val units = arrayOf("B", "KB", "MB", "GB", "TB")
            var value = bytes.toDouble()
            var unit = 0
            while (value >= 1024 && unit < units.lastIndex) {
                value /= 1024
                unit++
            }
            return if (unit == 0) "$bytes B" else String.format(TURKISH, "%.1f %s", value, units[unit])
        }

        private val TURKISH: Locale = Locale.forLanguageTag("tr-TR")
    }
}
