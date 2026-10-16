package tv.managealltv.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import tv.managealltv.player.core.util.CoreLog

/**
 * Starts the player after boot, after an app update (MY_PACKAGE_REPLACED) and when [AppRestarter]'s
 * alarm fires. The service always starts (these broadcasts are exempt from Android 12's background
 * restrictions); the activity only where Android allows it: below Android 10, with the overlay
 * permission, or because the system opens the HOME app anyway.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED_ACTIONS) return
        CoreLog.i(TAG, "Starting after $action")
        PlayerService.start(context)
        try {
            context.startActivity(MainActivity.launchIntent(context))
        } catch (e: RuntimeException) {
            CoreLog.w(TAG, "Cannot open the player: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "BootReceiver"

        /** Sent only explicitly (by [AppRestarter]); needs no intent filter. */
        const val ACTION_RESTART = "tv.managealltv.player.action.RESTART"

        private val HANDLED_ACTIONS =
            setOf(
                Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED,
                "android.intent.action.QUICKBOOT_POWERON",
                "com.htc.intent.action.QUICKBOOT_POWERON",
                "android.intent.action.ACTION_BOOT_IPO",
                ACTION_RESTART,
            )
    }
}
