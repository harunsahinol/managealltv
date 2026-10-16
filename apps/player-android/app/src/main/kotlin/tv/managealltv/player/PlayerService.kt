package tv.managealltv.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.net.ApiClient
import tv.managealltv.player.core.net.ApiException
import tv.managealltv.player.core.net.ApiResult
import tv.managealltv.player.core.net.DeviceSocket
import tv.managealltv.player.core.net.ServerUrls
import tv.managealltv.player.core.net.StatusFallback
import tv.managealltv.player.core.net.StatusProvider
import tv.managealltv.player.core.net.TokenProvider
import tv.managealltv.player.core.protocol.Command
import tv.managealltv.player.core.protocol.CommandResult
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.PairPollResponse
import tv.managealltv.player.core.protocol.PairRequest
import tv.managealltv.player.core.protocol.PairResponse
import tv.managealltv.player.core.protocol.ServerToDevice
import tv.managealltv.player.core.protocol.SyncState
import tv.managealltv.player.core.sync.Downloader
import tv.managealltv.player.core.sync.SyncEngine
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.ExponentialBackoff
import tv.managealltv.player.data.PlayerPrefs
import tv.managealltv.player.data.PlayerRuntime
import tv.managealltv.player.device.DeviceControl
import tv.managealltv.player.device.DeviceInfoCollector
import tv.managealltv.player.diagnostics.ErrorText
import tv.managealltv.player.logic.PairingCodeFormat
import tv.managealltv.player.logic.StatusText
import tv.managealltv.player.state.AppStateStore
import tv.managealltv.player.state.IdentifyRequest
import tv.managealltv.player.state.PairingUi
import tv.managealltv.player.state.Phase

/**
 * Foreground service that owns everything long-lived: pairing, the [SyncEngine], the [DeviceSocket]
 * with its heartbeat, remote commands, and the wake-up handling that brings the player back to the
 * front (pilot finding: TVs do not reopen apps after standby, ARCHITECTURE §7.2).
 *
 * The activity is only a view: it renders [AppStateStore.state] and reports what it plays. Main-thread
 * code here only orchestrates; network and disk work runs in the session scope on background threads.
 */
class PlayerService : LifecycleService() {
    private lateinit var prefs: PlayerPrefs
    private lateinit var control: DeviceControl
    private val http: OkHttpClient get() = PlayerRuntime.http

    /** Everything belonging to the current server/token; cancelled when pairing state changes. */
    private var sessionJob: Job? = null
    private var paired: PairedSession? = null

    private var screenReceiverRegistered = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /** Ids of recently executed commands; the server may deliver a pending command again on reconnect. */
    private val recentCommandIds = ArrayDeque<String>()

    private val screenReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT, Intent.ACTION_DREAMING_STOPPED -> onWakeUp()
                }
            }
        }

    override fun onCreate() {
        super.onCreate()
        prefs = PlayerPrefs.get(this)
        control = DeviceControl(this)
        startInForeground()
        registerScreenReceiver()
        registerNetworkCallback()
        refreshDeviceFlags()
        startSession()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        // Every startForegroundService() must be answered with startForeground(), also when running.
        startInForeground()
        refreshDeviceFlags()
        if (intent?.action == ACTION_SETTINGS_CHANGED) onSettingsChanged()
        // Restarted by the system after the process was killed (also used by restart_app).
        return START_STICKY
    }

    override fun onDestroy() {
        stopSession()
        if (screenReceiverRegistered) {
            unregisterReceiver(screenReceiver)
            screenReceiverRegistered = false
        }
        networkCallback?.let { callback ->
            try {
                ContextCompat.getSystemService(this, ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
            } catch (e: IllegalArgumentException) {
                // Not registered.
            }
        }
        networkCallback = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- session lifecycle (main thread)

    private fun startSession() {
        stopSession()
        val serverUrl = prefs.serverUrl
        val token = prefs.deviceToken
        AppStateStore.update {
            it.copy(
                serverUrl = serverUrl,
                deviceId = prefs.deviceId,
                deviceName = prefs.deviceName,
                sync = null,
                connection = DeviceSocket.ConnectionState.STOPPED,
            )
        }
        val job = SupervisorJob(lifecycleScope.coroutineContext[Job])
        sessionJob = job
        val scope = CoroutineScope(job + Dispatchers.Default)
        // hardwareId may write prefs on first use: not on the main thread.
        scope.launch(Dispatchers.IO) {
            val hardwareId = prefs.hardwareId
            AppStateStore.update { it.copy(hardwareId = hardwareId) }
        }

        val baseUrl = ServerUrls.parseBaseUrl(serverUrl)
        if (baseUrl == null) {
            AppStateStore.update { it.copy(phase = Phase.PAIRING, pairing = PairingUi(null, getString(R.string.pairing_invalid_server))) }
            return
        }
        if (token == null) {
            AppStateStore.update { it.copy(phase = Phase.PAIRING, pairing = PairingUi(null, getString(R.string.pairing_requesting))) }
            scope.launch { runPairing(baseUrl) }
            return
        }
        scope.launch(Dispatchers.IO) {
            val cache =
                try {
                    PlayerRuntime.mediaCache(this@PlayerService)
                } catch (e: IOException) {
                    CoreLog.e(TAG, "Media cache unavailable", e)
                    delay(CACHE_RETRY_MS)
                    // A new coroutine: startSession() cancels the session this one runs in.
                    lifecycleScope.launch { startSession() }
                    return@launch
                }
            // Content of another device (e.g. data left from before a re-pairing) must never play.
            val deviceId = prefs.deviceId
            val applied = cache.loadAppliedManifest()
            if (applied != null && deviceId != null && applied.deviceId != deviceId) PlayerRuntime.forgetAppliedManifest(cache)

            val session = PairedSession(baseUrl, token, scope, cache)
            withContext(Dispatchers.Main) {
                paired = session
                session.start()
                AppStateStore.update { it.copy(phase = Phase.PAIRED) }
            }
        }
    }

    private fun stopSession() {
        paired?.stop()
        paired = null
        sessionJob?.cancel()
        sessionJob = null
    }

    private fun onSettingsChanged() {
        val current = paired
        // A token belongs to the server that issued it.
        if (current != null && current.baseUrl != ServerUrls.parseBaseUrl(prefs.serverUrl)) {
            lifecycleScope.launch {
                withContext(Dispatchers.IO) { prefs.clearPairing() }
                startSession()
            }
        } else {
            startSession()
        }
    }

    /** Called from any thread when the server rejects [token] (401 or `unpaired`). */
    private fun onTokenRejected(token: String) {
        lifecycleScope.launch {
            // Several parts notice the same rejection; only the first one acts.
            if (prefs.deviceToken != token) return@launch
            CoreLog.w(TAG, "Device token rejected; pairing again")
            withContext(Dispatchers.IO) { prefs.clearPairing() }
            startSession()
        }
    }

    // ---------------------------------------------------------------- pairing (session scope)

    private suspend fun runPairing(baseUrl: HttpUrl) {
        val api = ApiClient(baseUrl, http, TokenProvider { null })
        val backoff = ExponentialBackoff(initialDelayMs = 5_000, maxDelayMs = 60_000)
        var failures = 0
        while (currentCoroutineContext().isActive) {
            setPairing(code = null, status = getString(R.string.pairing_requesting))
            val response: PairResponse =
                try {
                    val info = DeviceInfoCollector.collect(this, prefs.hardwareId)
                    api.pair(PairRequest(info))
                } catch (e: ApiException) {
                    // 429: the server allows 10 pairing requests per minute and IP.
                    val waitMs = if (e.httpStatus == 429) RATE_LIMIT_WAIT_MS else backoff.delayMs(failures++)
                    setPairing(null, getString(R.string.pairing_failed_retry, ErrorText.describe(this, e), waitMs / 1000))
                    delay(waitMs)
                    continue
                } catch (e: IOException) {
                    currentCoroutineContext().ensureActive()
                    val waitMs = backoff.delayMs(failures++)
                    setPairing(null, getString(R.string.pairing_failed_retry, ErrorText.describe(this, e), waitMs / 1000))
                    delay(waitMs)
                    continue
                }
            failures = 0
            val code = PairingCodeFormat.forDisplay(response.pairingCode)
            setPairing(code, getString(R.string.pairing_waiting))
            val result = pollPairing(api, response, code)
            if (result is PairPollResponse.Paired) {
                onPaired(result)
                return
            }
            // Expired: loop and show a fresh code.
        }
    }

    private suspend fun pollPairing(api: ApiClient, response: PairResponse, code: String): PairPollResponse {
        val intervalMs = response.pollIntervalSec.coerceIn(1, 60) * 1000L
        // The TV clock may be wrong, so expiresAt is not compared with it; the server answers
        // "expired" itself. The local limit only guards against a server that never does.
        val deadline = SystemClock.elapsedRealtime() + MAX_PAIRING_WAIT_MS
        while (SystemClock.elapsedRealtime() < deadline) {
            delay(intervalMs)
            val result =
                try {
                    api.pollPairing(response.pairingSecret)
                } catch (e: IOException) {
                    currentCoroutineContext().ensureActive()
                    setPairing(code, getString(R.string.pairing_poll_failed, ErrorText.describe(this, e)))
                    continue
                }
            when (result) {
                PairPollResponse.Pending -> setPairing(code, getString(R.string.pairing_waiting))
                is PairPollResponse.Paired -> return result
                PairPollResponse.Expired -> return result
            }
        }
        return PairPollResponse.Expired
    }

    private suspend fun onPaired(result: PairPollResponse.Paired) {
        CoreLog.i(TAG, "Paired as ${result.deviceId}")
        withContext(Dispatchers.IO) {
            // Forget the previous applied manifest before the token is stored (see forgetAppliedManifest).
            try {
                PlayerRuntime.forgetAppliedManifest(PlayerRuntime.mediaCache(this@PlayerService))
            } catch (e: IOException) {
                CoreLog.w(TAG, "Cannot open the media cache", e)
            }
            prefs.savePairing(result.deviceId, result.deviceToken, result.deviceName)
        }
        // A new coroutine: startSession() cancels the session this one runs in.
        lifecycleScope.launch { startSession() }
    }

    private fun setPairing(code: String?, status: String) {
        AppStateStore.update { it.copy(phase = Phase.PAIRING, pairing = PairingUi(code, status)) }
    }

    // ---------------------------------------------------------------- paired session

    /** Sync engine + WebSocket for one token. Created on a background thread, started on main. */
    private inner class PairedSession(
        val baseUrl: HttpUrl,
        private val token: String,
        private val scope: CoroutineScope,
        private val cache: MediaCache,
    ) {
        private val tokenProvider = TokenProvider { prefs.deviceToken }
        val api = ApiClient(baseUrl, http, tokenProvider)

        val sync =
            SyncEngine(
                api = api,
                downloader = Downloader(http, baseUrl, tokenProvider),
                cache = cache,
                scope = scope,
                availableBytes = { DeviceInfoCollector.storageStats(cache.rootDir).freeBytes },
                onUnauthorized = { onTokenRejected(token) },
            )

        val socket =
            DeviceSocket(
                httpClient = http,
                baseUrl = baseUrl,
                tokenProvider = tokenProvider,
                statusProvider = StatusProvider { currentStatus() },
                listener =
                    object : DeviceSocket.Listener {
                        override fun onMessage(message: ServerToDevice) {
                            handleMessage(message)
                        }
                    },
                scope = scope,
                statusFallback = StatusFallback { status -> postStatusOverHttp(status) },
            )

        fun start() {
            scope.launch {
                var reported: Pair<SyncState, Int?>? = null
                sync.state.collect { snapshot ->
                    AppStateStore.update {
                        it.copy(sync = snapshot, deviceName = snapshot.appliedManifest?.deviceName ?: it.deviceName)
                    }
                    // Tell the panel right away when a sync finished or failed instead of at the next heartbeat.
                    val key = snapshot.syncState to snapshot.appliedManifest?.version
                    if (reported != null && key != reported && snapshot.syncState != SyncState.DOWNLOADING) socket.sendStatusNow()
                    reported = key
                }
            }
            scope.launch {
                socket.state.collect { connection ->
                    AppStateStore.update { it.copy(connection = connection) }
                    if (connection == DeviceSocket.ConnectionState.UNAUTHORIZED) onTokenRejected(token)
                }
            }
            scope.launch {
                // The panel's volume is applied at start and with every new manifest version.
                sync.state
                    .map { it.appliedManifest?.let { manifest -> manifest.version to manifest.settings.volume } }
                    .distinctUntilChanged()
                    .collect { versionAndVolume ->
                        val volume = versionAndVolume?.second
                        if (volume != null) control.setVolumePercent(volume)
                    }
            }
            scope.launch {
                AppStateStore.playback.map { it.playlistId }.distinctUntilChanged().collect { socket.sendStatusNow() }
            }
            sync.start()
            socket.start()
        }

        fun stop() {
            socket.stop()
            sync.stop()
        }

        fun onNetworkAvailable() {
            socket.reconnectNow()
            sync.requestSync()
        }

        private fun currentStatus(): DeviceStatus {
            val playback = AppStateStore.playback.value
            val status =
                sync.state.value.toDeviceStatus(
                    activePlaylistId = playback.playlistId,
                    currentMediaId = playback.mediaId,
                    freeStorageBytes = DeviceInfoCollector.storageStats(cache.rootDir).freeBytes,
                    uptimeSec = SystemClock.elapsedRealtime() / 1000,
                    appVersionName = BuildConfig.VERSION_NAME,
                    appVersionCode = BuildConfig.VERSION_CODE,
                    volume = control.volumePercent(),
                    overlayPermission = control.hasOverlayPermission(),
                    deviceOwner = control.isDeviceOwner(),
                )
            val lastError = StatusText.mergeLastError(status.lastError, playback.error, DeviceStatus.MAX_MESSAGE_LENGTH)
            return if (lastError == status.lastError) status else status.copy(lastError = lastError)
        }

        private suspend fun postStatusOverHttp(status: DeviceStatus) {
            when (val result = api.postStatus(status)) {
                is ApiResult.Ok -> sync.onManifestUpdated(result.value.manifestVersion)
                ApiResult.Unauthorized -> onTokenRejected(token)
            }
        }

        /** OkHttp thread. */
        private fun handleMessage(message: ServerToDevice) {
            when (message) {
                is ServerToDevice.ManifestUpdated -> sync.onManifestUpdated(message.version)
                is ServerToDevice.CommandMessage -> scope.launch(Dispatchers.Main) { execute(message.id, message.command) }
                ServerToDevice.Unpaired -> onTokenRejected(token)
            }
        }

        /** Main thread. Every command gets a result; messages are Turkish (shown in the panel). */
        private suspend fun execute(id: String, command: Command) {
            if (id in recentCommandIds) return
            recentCommandIds.addLast(id)
            while (recentCommandIds.size > MAX_REMEMBERED_COMMANDS) recentCommandIds.removeFirst()
            CoreLog.i(TAG, "Command $id: $command")

            val result: CommandResult =
                when (command) {
                    Command.Reload -> {
                        sync.requestSync()
                        AppStateStore.update { it.copy(reloadSerial = it.reloadSerial + 1) }
                        CommandResult(true, getString(R.string.cmd_reload_ok))
                    }
                    Command.RestartApp -> {
                        report(id, CommandResult(true, getString(R.string.cmd_restart_ok)))
                        // Give the WebSocket a moment to flush the result before the process goes away.
                        delay(RESULT_FLUSH_MS)
                        AppRestarter.restart(this@PlayerService)
                        return
                    }
                    is Command.Identify -> identify(command.durationSec)
                    is Command.SetVolume -> control.setVolumePercent(command.volume)
                    Command.Reboot -> {
                        if (!control.isDeviceOwner()) {
                            CommandResult(false, getString(R.string.cmd_reboot_not_owner))
                        } else {
                            report(id, CommandResult(true, getString(R.string.cmd_reboot_ok)))
                            delay(RESULT_FLUSH_MS)
                            try {
                                control.reboot()
                            } catch (e: IllegalStateException) {
                                CoreLog.e(TAG, "Reboot refused", e)
                            } catch (e: SecurityException) {
                                CoreLog.e(TAG, "Reboot refused", e)
                            }
                            return
                        }
                    }
                }
            report(id, result)
        }

        private suspend fun identify(durationSec: Int): CommandResult {
            val name = sync.state.value.appliedManifest?.deviceName ?: prefs.deviceName ?: getString(R.string.identify_unnamed)
            val durationMs = durationSec.coerceIn(1, 600) * 1000L
            AppStateStore.update { it.copy(identify = IdentifyRequest(name, SystemClock.elapsedRealtime() + durationMs)) }
            bringActivityToFront()
            // Report honestly whether anyone can see it.
            delay(IDENTIFY_CHECK_MS)
            return when {
                !control.isScreenOn() -> CommandResult(false, getString(R.string.cmd_identify_screen_off))
                !AppStateStore.activityVisible -> CommandResult(false, getString(R.string.cmd_identify_not_visible))
                else -> CommandResult(true, getString(R.string.cmd_identify_ok, durationSec))
            }
        }

        private suspend fun report(id: String, result: CommandResult) {
            val bounded = result.copy(message = result.message?.take(DeviceStatus.MAX_MESSAGE_LENGTH))
            if (socket.sendCommandResult(id, bounded)) return
            try {
                when (api.postCommandResult(id, bounded)) {
                    is ApiResult.Ok -> Unit
                    ApiResult.Unauthorized -> onTokenRejected(token)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                CoreLog.w(TAG, "Result of command $id not delivered: ${e.message}")
            }
        }
    }

    // ---------------------------------------------------------------- wake-up, network, foreground

    private fun onWakeUp() {
        refreshDeviceFlags()
        // Wi-Fi usually reconnects while the TV wakes up; do not wait for the backoff.
        paired?.onNetworkAvailable()
        bringActivityToFront()
        // Some TVs start their own launcher after SCREEN_ON and cover us; try once more.
        lifecycleScope.launch {
            delay(WAKE_RETRY_MS)
            if (!AppStateStore.activityVisible) bringActivityToFront()
        }
    }

    /**
     * Starting an activity from the background is blocked on Android 10+ unless the app may draw
     * overlays (or is the HOME app); then this call is silently ignored and the HOME role has to cover it.
     */
    private fun bringActivityToFront() {
        try {
            startActivity(MainActivity.launchIntent(this))
        } catch (e: RuntimeException) {
            CoreLog.w(TAG, "Cannot bring the player to the front: ${e.message}")
        }
    }

    private fun registerScreenReceiver() {
        val filter =
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_USER_PRESENT)
                addAction(Intent.ACTION_DREAMING_STOPPED)
            }
        // These are protected system broadcasts (only the system can send them); SCREEN_ON is not
        // delivered to manifest receivers at all, hence the dynamic registration.
        ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
        screenReceiverRegistered = true
    }

    private fun registerNetworkCallback() {
        val manager = ContextCompat.getSystemService(this, ConnectivityManager::class.java) ?: return
        val callback =
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    lifecycleScope.launch { paired?.onNetworkAvailable() }
                }
            }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: RuntimeException) {
            // SecurityException on a few vendor builds; the socket's own backoff still reconnects.
            CoreLog.w(TAG, "Network callback unavailable: ${e.message}")
        }
    }

    private fun refreshDeviceFlags() {
        val deviceOwner = control.isDeviceOwner()
        if (deviceOwner) control.ensurePersistentHome()
        AppStateStore.update { it.copy(deviceOwner = deviceOwner, overlayPermission = control.hasOverlayPermission()) }
    }

    private fun startInForeground() {
        val openPlayer =
            PendingIntent.getActivity(
                this,
                0,
                MainActivity.launchIntent(this),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            NotificationCompat.Builder(this, PlayerApp.NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_text))
                .setContentIntent(openPlayer)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: IllegalStateException) {
            // Android 12+ refuses foreground starts from the background without an exemption (e.g. a
            // sticky restart); the service still runs, the next start from the activity promotes it.
            CoreLog.w(TAG, "Cannot enter the foreground: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "PlayerService"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_START = "tv.managealltv.player.action.START"
        private const val ACTION_SETTINGS_CHANGED = "tv.managealltv.player.action.SETTINGS_CHANGED"

        private const val RATE_LIMIT_WAIT_MS = 60_000L
        private const val MAX_PAIRING_WAIT_MS = 16 * 60_000L
        private const val CACHE_RETRY_MS = 30_000L
        private const val RESULT_FLUSH_MS = 1_000L
        private const val IDENTIFY_CHECK_MS = 1_500L
        private const val WAKE_RETRY_MS = 3_000L
        private const val MAX_REMEMBERED_COMMANDS = 50

        /** Starts (or pokes) the service; safe to call repeatedly. */
        fun start(context: Context): Boolean = send(context, ACTION_START)

        /** The server address was changed on the settings screen. */
        fun notifySettingsChanged(context: Context): Boolean = send(context, ACTION_SETTINGS_CHANGED)

        private fun send(context: Context, action: String): Boolean {
            val intent = Intent(context, PlayerService::class.java).setAction(action)
            return try {
                ContextCompat.startForegroundService(context, intent)
                true
            } catch (e: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException (Android 12+) when started from the background.
                CoreLog.w(TAG, "Cannot start the service: ${e.message}")
                false
            } catch (e: SecurityException) {
                CoreLog.w(TAG, "Cannot start the service: ${e.message}")
                false
            }
        }
    }
}
