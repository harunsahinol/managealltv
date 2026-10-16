package tv.managealltv.player

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import tv.managealltv.player.device.DeviceControl

/**
 * Device admin component, needed to provision the app as Device Owner:
 * `adb shell dpm set-device-owner tv.managealltv.player/.AdminReceiver` (see README).
 */
class AdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        // Lock the player in as HOME right away; the service repeats this on every start.
        DeviceControl(context).ensurePersistentHome()
        PlayerService.start(context)
    }
}
