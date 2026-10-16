package tv.managealltv.player.device

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import tv.managealltv.player.AdminReceiver
import tv.managealltv.player.MainActivity
import tv.managealltv.player.R
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.logic.VolumeMath

/** Device-level actions: Device Owner features, volume, overlay permission, screen state. */
class DeviceControl(context: Context) {
    private val appContext: Context = context.applicationContext
    private val policyManager: DevicePolicyManager? = ContextCompat.getSystemService(appContext, DevicePolicyManager::class.java)
    private val audioManager: AudioManager? = ContextCompat.getSystemService(appContext, AudioManager::class.java)
    private val powerManager: PowerManager? = ContextCompat.getSystemService(appContext, PowerManager::class.java)
    private val adminComponent = ComponentName(appContext, AdminReceiver::class.java)

    /** Provisioned with `dpm set-device-owner` (README). */
    fun isDeviceOwner(): Boolean = policyManager?.isDeviceOwnerApp(appContext.packageName) == true

    /** "Display over other apps"; without it Android 10+ ignores our attempts to come to the front. */
    fun hasOverlayPermission(): Boolean = Settings.canDrawOverlays(appContext)

    /** False while the TV is in standby (screen off). */
    fun isScreenOn(): Boolean = powerManager?.isInteractive != false

    /**
     * As Device Owner, makes the player the permanent HOME activity: the TV then opens it on boot and
     * on every wake-up, and the HOME key leads back to it (ARCHITECTURE §7.2). Idempotent.
     */
    fun ensurePersistentHome(): Boolean {
        val dpm = policyManager ?: return false
        if (!isDeviceOwner()) return false
        return try {
            val filter =
                IntentFilter(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addCategory(Intent.CATEGORY_DEFAULT)
                }
            dpm.addPersistentPreferredActivity(adminComponent, filter, ComponentName(appContext, MainActivity::class.java))
            true
        } catch (e: SecurityException) {
            CoreLog.w(TAG, "Cannot set the persistent HOME activity", e)
            false
        }
    }

    /** Reboots the TV; only a Device Owner may. Throws IllegalStateException e.g. during a call. */
    fun reboot() {
        val dpm = policyManager ?: throw IllegalStateException("DevicePolicyManager unavailable")
        dpm.reboot(adminComponent)
    }

    /** Current STREAM_MUSIC volume as 0-100, null when the TV does not report one. */
    fun volumePercent(): Int? {
        val audio = audioManager ?: return null
        return try {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (max <= 0) null else VolumeMath.toPercent(audio.getStreamVolume(AudioManager.STREAM_MUSIC), max)
        } catch (e: RuntimeException) {
            null
        }
    }

    /** Sets STREAM_MUSIC to [percent] of its maximum; the result message is Turkish (shown in the panel). */
    fun setVolumePercent(percent: Int): CommandResult {
        val audio = audioManager ?: return CommandResult(false, appContext.getString(R.string.volume_unavailable))
        if (audio.isVolumeFixed) return CommandResult(false, appContext.getString(R.string.volume_fixed))
        return try {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (max <= 0) return CommandResult(false, appContext.getString(R.string.volume_unavailable))
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, VolumeMath.toStreamIndex(percent, max), 0)
            val actual = VolumeMath.toPercent(audio.getStreamVolume(AudioManager.STREAM_MUSIC), max)
            CommandResult(true, appContext.getString(R.string.volume_set, actual))
        } catch (e: SecurityException) {
            CommandResult(false, appContext.getString(R.string.volume_denied, e.message.orEmpty()))
        }
    }

    private companion object {
        const val TAG = "DeviceControl"
    }
}
