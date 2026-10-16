package tv.managealltv.player.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import java.io.File
import java.util.UUID
import okhttp3.OkHttpClient
import tv.managealltv.player.BuildConfig
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.net.HttpClients

/**
 * Persistent settings: server address, device token and the random hardware id. Writes use commit()
 * (synchronous) because a token that is only queued for writing is lost if the TV loses power right
 * after pairing; call the writers off the main thread.
 */
class PlayerPrefs private constructor(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    /** The configured server origin, or the one baked into the APK. */
    val serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, null) ?: BuildConfig.DEFAULT_SERVER_URL

    /** Saves [url] as the server; null goes back to the APK default. */
    fun setServerUrl(url: String?) {
        prefs.edit(commit = true) {
            if (url == null) remove(KEY_SERVER_URL) else putString(KEY_SERVER_URL, url)
        }
    }

    /** Random UUID created on first use and kept for the app's lifetime (`DeviceInfo.hardwareId`). */
    val hardwareId: String
        get() =
            synchronized(lock) {
                prefs.getString(KEY_HARDWARE_ID, null)
                    ?: UUID.randomUUID().toString().also { id -> prefs.edit(commit = true) { putString(KEY_HARDWARE_ID, id) } }
            }

    val deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)

    val deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)

    val deviceName: String?
        get() = prefs.getString(KEY_DEVICE_NAME, null)

    fun savePairing(deviceId: String, deviceToken: String, deviceName: String) {
        prefs.edit(commit = true) {
            putString(KEY_DEVICE_ID, deviceId)
            putString(KEY_DEVICE_TOKEN, deviceToken)
            putString(KEY_DEVICE_NAME, deviceName)
        }
    }

    fun clearPairing() {
        prefs.edit(commit = true) {
            remove(KEY_DEVICE_ID)
            remove(KEY_DEVICE_TOKEN)
            remove(KEY_DEVICE_NAME)
        }
    }

    companion object {
        private const val FILE_NAME = "player"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_HARDWARE_ID = "hardware_id"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"

        @Volatile
        private var instance: PlayerPrefs? = null

        fun get(context: Context): PlayerPrefs =
            instance ?: synchronized(this) { instance ?: PlayerPrefs(context).also { instance = it } }
    }
}

/** Objects shared by the service and the activity; one instance per process. */
object PlayerRuntime {
    /** One client for everything: shares the connection pool and threads (weak TVs). */
    val http: OkHttpClient by lazy { HttpClients.create() }

    @Volatile
    private var cache: MediaCache? = null

    /**
     * The media cache under filesDir (not cacheDir, which the system may clear when storage runs low).
     * Reads its index from disk on first use, so call it off the main thread.
     */
    fun mediaCache(context: Context): MediaCache =
        cache ?: synchronized(this) {
            cache ?: MediaCache(File(context.applicationContext.filesDir, CACHE_DIR)).also { cache = it }
        }

    /**
     * Drops the applied manifest so the next sync starts from scratch (files stay and are reused by
     * hash). Needed after pairing again: the new device's manifest may have the same version number,
     * and the ETag of the old one would get a 304 and keep the old device's content on screen.
     * player-core has no API for this yet; the file name is MediaCache's documented layout.
     */
    fun forgetAppliedManifest(cache: MediaCache) {
        val file = File(cache.rootDir, "manifest.json")
        if (file.exists()) file.delete()
    }

    private const val CACHE_DIR = "media-cache"
}
