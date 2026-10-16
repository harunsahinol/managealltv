package tv.managealltv.player

import android.app.ActivityOptions
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.core.content.ContextCompat
import tv.managealltv.player.core.util.CoreLog

/** `restart_app`: schedule our own start with AlarmManager, then end the process. */
object AppRestarter {
    private const val TAG = "AppRestarter"
    private const val ACTIVITY_DELAY_MS = 1_500L
    private const val SERVICE_DELAY_MS = 3_000L

    fun restart(context: Context) {
        val appContext = context.applicationContext
        val alarmManager = ContextCompat.getSystemService(appContext, AlarmManager::class.java)
        if (alarmManager != null) {
            val now = SystemClock.elapsedRealtime()
            val openActivity =
                PendingIntent.getActivity(
                    appContext,
                    REQUEST_ACTIVITY,
                    MainActivity.launchIntent(appContext),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
                    creatorOptions(),
                )
            alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, now + ACTIVITY_DELAY_MS, openActivity)
            // Second path for the service in case Android blocks the activity start from the background.
            val startService =
                PendingIntent.getBroadcast(
                    appContext,
                    REQUEST_BROADCAST,
                    Intent(appContext, BootReceiver::class.java).setAction(BootReceiver.ACTION_RESTART),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
                )
            alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, now + SERVICE_DELAY_MS, startService)
        } else {
            CoreLog.w(TAG, "No AlarmManager; relying on the sticky service restart")
        }
        CoreLog.i(TAG, "Restarting the app")
        // The foreground service is START_STICKY, so the system also restarts it after this.
        Process.killProcess(Process.myPid())
    }

    /**
     * Android 14+ only lets a PendingIntent start an activity from the background with the creator's
     * privileges (overlay permission / HOME role) when the creator opts in explicitly.
     */
    @Suppress("DEPRECATION") // MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS replaces it from API 36 only.
    private fun creatorOptions(): Bundle? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return null
        val options = ActivityOptions.makeBasic()
        options.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
        return options.toBundle()
    }

    private const val REQUEST_ACTIVITY = 1
    private const val REQUEST_BROADCAST = 2
}
