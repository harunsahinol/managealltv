package tv.managealltv.player

import android.app.Application
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationManagerCompat
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.LogLevel
import tv.managealltv.player.core.util.LogSink

class PlayerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // player-core logs through CoreLog; send it to Logcat ("adb logcat -s MTV" style filtering).
        CoreLog.sink =
            LogSink { level, tag, message, error ->
                // Tags longer than 23 characters are rejected by Log.isLoggable before Android 8.
                val logTag = "MTV-$tag".take(23)
                when (level) {
                    LogLevel.DEBUG -> Log.d(logTag, message, error)
                    LogLevel.INFO -> Log.i(logTag, message, error)
                    LogLevel.WARN -> Log.w(logTag, message, error)
                    LogLevel.ERROR -> Log.e(logTag, message, error)
                }
            }
        val channel =
            NotificationChannelCompat.Builder(NOTIFICATION_CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(getString(R.string.notification_channel_name))
                .build()
        NotificationManagerCompat.from(this).createNotificationChannel(channel)
    }

    companion object {
        const val NOTIFICATION_CHANNEL_ID = "player"
    }
}
