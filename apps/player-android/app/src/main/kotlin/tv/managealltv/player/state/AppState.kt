package tv.managealltv.player.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import tv.managealltv.player.core.net.DeviceSocket
import tv.managealltv.player.core.sync.SyncSnapshot

enum class Phase {
    /** The service has not decided yet (process just started). */
    STARTING,

    /** No device token: show the pairing code. */
    PAIRING,

    /** Paired: sync runs and the player shows the applied manifest. */
    PAIRED,
}

data class PairingUi(
    /** The six digits to type into the panel; null while a code is being requested. */
    val code: String? = null,
    /** Turkish status line under the code (waiting, network error, …). */
    val status: String? = null,
)

/** `identify` command: show the device name full screen until [untilElapsedMs] (SystemClock.elapsedRealtime). */
data class IdentifyRequest(val deviceName: String, val untilElapsedMs: Long)

data class AppState(
    val phase: Phase = Phase.STARTING,
    val serverUrl: String = "",
    val hardwareId: String = "",
    val deviceId: String? = null,
    val deviceName: String? = null,
    val pairing: PairingUi = PairingUi(),
    /** Applied manifest, sync progress and last sync error; null while not paired. */
    val sync: SyncSnapshot? = null,
    val connection: DeviceSocket.ConnectionState = DeviceSocket.ConnectionState.STOPPED,
    val overlayPermission: Boolean = false,
    val deviceOwner: Boolean = false,
    val identify: IdentifyRequest? = null,
    /** Incremented by the `reload` command; the player restarts its loop when it changes. */
    val reloadSerial: Int = 0,
)

/** What the screen is doing, reported by the activity and sent to the panel in the status. */
data class PlaybackReport(
    val playlistId: String? = null,
    val mediaId: String? = null,
    /** Turkish description of the last item that failed to play; cleared once it plays. */
    val error: String? = null,
    val errorMediaId: String? = null,
)

/**
 * Process-wide state shared by [tv.managealltv.player.PlayerService] (which owns the long-lived
 * objects and writes [state]) and [tv.managealltv.player.MainActivity] (which only renders it and
 * writes [playback]). A singleton instead of a bound service keeps the activity trivially simple: it
 * can come and go (standby, other apps) while the service keeps syncing.
 */
object AppStateStore {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    private val _playback = MutableStateFlow(PlaybackReport())
    val playback: StateFlow<PlaybackReport> = _playback.asStateFlow()

    /** True between the activity's onStart and onStop; the service uses it to retry bringing it to front. */
    @Volatile
    var activityVisible: Boolean = false

    fun update(transform: (AppState) -> AppState) {
        _state.update(transform)
    }

    fun updatePlayback(transform: (PlaybackReport) -> PlaybackReport) {
        _playback.update(transform)
    }
}
