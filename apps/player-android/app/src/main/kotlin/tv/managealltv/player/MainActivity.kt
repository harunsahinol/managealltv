package tv.managealltv.player

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.ui.PlayerView
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tv.managealltv.player.core.net.DeviceSocket
import tv.managealltv.player.core.playback.PlayItem
import tv.managealltv.player.core.playback.PlaybackPlan
import tv.managealltv.player.core.playback.PlaybackPlanner
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.SyncState
import tv.managealltv.player.core.sync.SyncSnapshot
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.data.PlayerPrefs
import tv.managealltv.player.data.PlayerRuntime
import tv.managealltv.player.device.DeviceControl
import tv.managealltv.player.diagnostics.ConnectionTester
import tv.managealltv.player.diagnostics.ErrorText
import tv.managealltv.player.logic.ClockTrust
import tv.managealltv.player.logic.ServerAddress
import tv.managealltv.player.playback.PlaybackController
import tv.managealltv.player.state.AppState
import tv.managealltv.player.state.AppStateStore
import tv.managealltv.player.state.IdentifyRequest
import tv.managealltv.player.state.Phase

/**
 * The only screen. It renders [AppStateStore.state] (published by [PlayerService]) and plays the
 * applied manifest; it owns no network or sync logic, so it can be stopped and recreated freely.
 *
 * Remote control: MENU / INFO or a long press on OK toggles the info panel; BACK closes panels but
 * never leaves the player (kiosk).
 */
class MainActivity : ComponentActivity() {
    private lateinit var prefs: PlayerPrefs
    private lateinit var control: DeviceControl
    private lateinit var playback: PlaybackController

    private lateinit var playerLayer: View
    private lateinit var noContentScreen: View
    private lateinit var noContentDetail: TextView
    private lateinit var startingScreen: View
    private lateinit var pairingScreen: ViewGroup
    private lateinit var pairingCode: TextView
    private lateinit var pairingStatus: TextView
    private lateinit var pairingServer: TextView
    private lateinit var pairingHardwareId: TextView
    private lateinit var pairingTestButton: Button
    private lateinit var identifyOverlay: View
    private lateinit var identifyName: TextView
    private lateinit var infoOverlay: ViewGroup
    private lateinit var infoText: TextView
    private lateinit var infoTestButton: Button
    private lateinit var infoCloseButton: Button
    private lateinit var connectionPanel: View
    private lateinit var connectionServer: TextView
    private lateinit var connectionResult: TextView
    private lateinit var connectionVerdict: TextView
    private lateinit var connectionRetryButton: Button
    private lateinit var serverPanel: View
    private lateinit var serverInput: EditText
    private lateinit var serverError: TextView

    private val planner: PlaybackPlanner by lazy {
        val appContext = applicationContext
        PlaybackPlanner { media -> PlayerRuntime.mediaCache(appContext).fileFor(media) }
    }

    /** Re-plan requests from the 15 s ticker, manifest changes and onStart; handled one at a time. */
    private val replanSignals = Channel<Unit>(Channel.CONFLATED)
    private var forceRestartPending = false
    private var lastReloadSerial: Int? = null
    private var lastManifestVersion: Int? = null

    private var showingNothing = false
    private var renderedPhase: Phase? = null
    private var shownIdentify: IdentifyRequest? = null
    private var identifyHideJob: Job? = null
    private var connectionTestJob: Job? = null

    private val playbackCallbacks =
        object : PlaybackController.Callbacks {
            override fun onNothingToPlay() {
                showingNothing = true
                AppStateStore.updatePlayback { it.copy(playlistId = null, mediaId = null) }
                render(AppStateStore.state.value)
            }

            override fun onContentShown() {
                showingNothing = false
                render(AppStateStore.state.value)
            }

            override fun onItemStarted(plan: PlaybackPlan, item: PlayItem) {
                AppStateStore.updatePlayback { it.copy(playlistId = plan.playlistId, mediaId = item.mediaId) }
            }

            override fun onItemFinished(plan: PlaybackPlan, item: PlayItem) {
                // It played after all: its earlier failure is no longer the device's last error.
                AppStateStore.updatePlayback {
                    if (it.errorMediaId == item.mediaId) it.copy(error = null, errorMediaId = null) else it
                }
            }

            override fun onItemFailed(plan: PlaybackPlan, item: PlayItem, reason: String) {
                CoreLog.w(TAG, "Cannot play ${item.mediaId}: $reason")
                val message = getString(R.string.playback_item_failed, item.mediaId, reason)
                AppStateStore.updatePlayback { it.copy(playlistId = plan.playlistId, error = message, errorMediaId = item.mediaId) }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        prefs = PlayerPrefs.get(this)
        control = DeviceControl(this)
        bindViews()
        enterImmersiveMode()
        playback =
            PlaybackController(
                context = this,
                scope = lifecycleScope,
                playerView = findViewById<PlayerView>(R.id.player_view),
                imageA = findViewById(R.id.image_a),
                imageB = findViewById(R.id.image_b),
                callbacks = playbackCallbacks,
            )
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    closeTopPanel()
                }
            },
        )

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { AppStateStore.state.collect { render(it) } }
                launch {
                    // The info panel also shows the last playback error, which lives in the playback report.
                    AppStateStore.playback.collect {
                        if (infoOverlay.isVisible) infoText.setTextIfChanged(buildInfoText(AppStateStore.state.value))
                    }
                }
                launch {
                    AppStateStore.state
                        .map { PlaybackInputs(it.phase, it.sync?.appliedManifest, it.reloadSerial) }
                        .distinctUntilChanged()
                        .collect { onPlaybackInputs(it) }
                }
                launch {
                    while (isActive) {
                        replanSignals.receive()
                        replan()
                    }
                }
                launch {
                    while (isActive) {
                        delay(REPLAN_INTERVAL_MS)
                        requestReplan(forceRestart = false)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        AppStateStore.activityVisible = true
        // Also revives the service if the system killed it while the player was hidden.
        PlayerService.start(this)
        refreshDeviceFlags()
        enterImmersiveMode()
        playback.start()
        requestReplan(forceRestart = true)
    }

    override fun onStop() {
        AppStateStore.activityVisible = false
        playback.stop()
        // Nothing is on screen any more; the panel should not show a playlist as playing.
        AppStateStore.updatePlayback { it.copy(playlistId = null, mediaId = null) }
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // System bars can come back after the keyboard or a system dialog.
        if (hasFocus) enterImmersiveMode()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO -> {
                if (!isModalPanelVisible()) toggleInfo()
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                // Many TV remotes have no MENU/INFO key: a long press on OK opens the info panel. A
                // focused button consumes OK itself, so this only sees it on the bare player screens.
                if (event.repeatCount == 0 && !isAnyPanelVisible()) {
                    event.startTracking()
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            toggleInfo()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if ((keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) && event.isTracking) return true
        return super.onKeyUp(keyCode, event)
    }

    // ---------------------------------------------------------------- setup

    private fun bindViews() {
        playerLayer = findViewById(R.id.player_layer)
        noContentScreen = findViewById(R.id.no_content_screen)
        noContentDetail = findViewById(R.id.no_content_detail)
        startingScreen = findViewById(R.id.starting_screen)
        pairingScreen = findViewById(R.id.pairing_screen)
        pairingCode = findViewById(R.id.pairing_code)
        pairingStatus = findViewById(R.id.pairing_status)
        pairingServer = findViewById(R.id.pairing_server)
        pairingHardwareId = findViewById(R.id.pairing_hardware_id)
        pairingTestButton = findViewById(R.id.pairing_test_button)
        identifyOverlay = findViewById(R.id.identify_overlay)
        identifyName = findViewById(R.id.identify_name)
        infoOverlay = findViewById(R.id.info_overlay)
        infoText = findViewById(R.id.info_text)
        infoTestButton = findViewById(R.id.info_test_button)
        infoCloseButton = findViewById(R.id.info_close_button)
        connectionPanel = findViewById(R.id.connection_panel)
        connectionServer = findViewById(R.id.connection_server)
        connectionResult = findViewById(R.id.connection_result)
        connectionVerdict = findViewById(R.id.connection_verdict)
        connectionRetryButton = findViewById(R.id.connection_retry_button)
        serverPanel = findViewById(R.id.server_panel)
        serverInput = findViewById(R.id.server_input)
        serverError = findViewById(R.id.server_error)

        pairingTestButton.setOnClickListener { showConnectionTest() }
        findViewById<Button>(R.id.pairing_server_button).setOnClickListener { showServerSettings() }
        infoTestButton.setOnClickListener { showConnectionTest() }
        infoCloseButton.setOnClickListener { hideInfo() }
        connectionRetryButton.setOnClickListener { runConnectionTest() }
        findViewById<Button>(R.id.connection_close_button).setOnClickListener { hideConnectionTest() }
        findViewById<Button>(R.id.server_save_button).setOnClickListener { saveServerAddress() }
        findViewById<Button>(R.id.server_default_button).setOnClickListener {
            serverInput.setText(BuildConfig.DEFAULT_SERVER_URL)
            serverInput.setSelection(serverInput.text.length)
        }
        findViewById<Button>(R.id.server_cancel_button).setOnClickListener { hideServerSettings() }
        serverInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                hideKeyboard()
                findViewById<Button>(R.id.server_save_button).requestFocus()
                true
            } else {
                false
            }
        }
    }

    private fun enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun refreshDeviceFlags() {
        // The overlay permission may have been granted with adb while the app was running.
        AppStateStore.update { it.copy(overlayPermission = control.hasOverlayPermission(), deviceOwner = control.isDeviceOwner()) }
    }

    // ---------------------------------------------------------------- playback

    private data class PlaybackInputs(val phase: Phase, val manifest: Manifest?, val reloadSerial: Int)

    private fun onPlaybackInputs(inputs: PlaybackInputs) {
        val reloaded = lastReloadSerial != null && lastReloadSerial != inputs.reloadSerial
        lastReloadSerial = inputs.reloadSerial
        val version = inputs.manifest?.version
        if (version != lastManifestVersion) {
            lastManifestVersion = version
            // New content: a failure of the old content is no longer relevant.
            AppStateStore.updatePlayback { it.copy(error = null, errorMediaId = null) }
        }
        requestReplan(forceRestart = reloaded)
    }

    private fun requestReplan(forceRestart: Boolean) {
        if (forceRestart) forceRestartPending = true
        replanSignals.trySend(Unit)
    }

    private suspend fun replan() {
        val force = forceRestartPending
        forceRestartPending = false
        val state = AppStateStore.state.value
        if (state.phase != Phase.PAIRED) {
            playback.update(PlaybackPlan.NOTHING, forceRestart = false)
            return
        }
        val manifest = state.sync?.appliedManifest
        val now = ClockTrust.trustedOrNull(Instant.now())
        val plan =
            withContext(Dispatchers.IO) {
                try {
                    planner.plan(manifest, now)
                } catch (e: IOException) {
                    CoreLog.e(TAG, "Media cache unavailable", e)
                    PlaybackPlan.NOTHING
                }
            }
        playback.update(plan, force)
    }

    // ---------------------------------------------------------------- rendering

    private fun render(state: AppState) {
        val paired = state.phase == Phase.PAIRED
        startingScreen.isVisible = state.phase == Phase.STARTING
        pairingScreen.isVisible = state.phase == Phase.PAIRING
        playerLayer.isVisible = paired
        noContentScreen.isVisible = paired && showingNothing
        if (noContentScreen.isVisible) noContentDetail.setTextIfChanged(noContentText(state))
        if (state.phase == Phase.PAIRING) renderPairing(state)
        if (infoOverlay.isVisible) infoText.setTextIfChanged(buildInfoText(state))
        renderIdentify(state.identify)

        if (state.phase != renderedPhase) {
            renderedPhase = state.phase
            if (!isAnyPanelVisible()) restoreFocus()
        }
    }

    private fun renderPairing(state: AppState) {
        pairingCode.setTextIfChanged(state.pairing.code ?: getString(R.string.pairing_code_placeholder))
        pairingStatus.setTextIfChanged(state.pairing.status.orEmpty())
        pairingServer.setTextIfChanged(getString(R.string.pairing_server, state.serverUrl))
        pairingHardwareId.setTextIfChanged(getString(R.string.pairing_hardware_id, state.hardwareId))
    }

    private fun noContentText(state: AppState): String {
        val sync = state.sync ?: return getString(R.string.no_content_waiting)
        if (sync.appliedManifest != null) return getString(R.string.no_content_nothing_scheduled)
        val error = sync.lastError
        return when {
            sync.syncState == SyncState.DOWNLOADING -> getString(R.string.no_content_downloading, progressText(sync))
            error != null -> getString(R.string.no_content_error, error.message)
            else -> getString(R.string.no_content_waiting)
        }
    }

    private fun renderIdentify(request: IdentifyRequest?) {
        if (request == shownIdentify) return
        shownIdentify = request
        identifyHideJob?.cancel()
        val remainingMs = request?.let { it.untilElapsedMs - SystemClock.elapsedRealtime() } ?: 0L
        if (request == null || remainingMs <= 0) {
            identifyOverlay.isVisible = false
            return
        }
        identifyName.text = request.deviceName
        identifyOverlay.isVisible = true
        identifyHideJob =
            lifecycleScope.launch {
                delay(remainingMs)
                identifyOverlay.isVisible = false
            }
    }

    // ---------------------------------------------------------------- info panel

    private fun toggleInfo() {
        if (infoOverlay.isVisible) hideInfo() else showInfo()
    }

    private fun showInfo() {
        refreshDeviceFlags()
        infoText.text = buildInfoText(AppStateStore.state.value)
        infoOverlay.isVisible = true
        infoCloseButton.requestFocus()
    }

    private fun hideInfo() {
        infoOverlay.isVisible = false
        restoreFocus()
    }

    private fun buildInfoText(state: AppState): String {
        val sync = state.sync
        val manifest = sync?.appliedManifest
        val lastError = sync?.lastError?.message ?: AppStateStore.playback.value.error
        val lines =
            listOf(
                R.string.info_app_version to getString(R.string.info_version_value, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
                R.string.info_server to state.serverUrl,
                R.string.info_device_id to (state.deviceId ?: getString(R.string.info_not_paired)),
                R.string.info_device_name to (manifest?.deviceName ?: state.deviceName ?: DASH),
                R.string.info_hardware_id to state.hardwareId.ifEmpty { DASH },
                R.string.info_manifest_version to (manifest?.version?.toString() ?: DASH),
                R.string.info_sync_state to syncText(sync),
                R.string.info_last_sync to (sync?.lastSuccessAt?.let(::formatTime) ?: DASH),
                R.string.info_connection to connectionText(state.connection),
                R.string.info_last_error to (lastError?.take(MAX_ERROR_CHARS) ?: DASH),
                R.string.info_overlay_permission to getString(if (state.overlayPermission) R.string.value_granted else R.string.value_missing),
                R.string.info_device_owner to getString(if (state.deviceOwner) R.string.value_yes else R.string.value_no),
            )
        return lines.joinToString("\n") { (label, value) -> getString(R.string.info_line, getString(label), value) }
    }

    private fun syncText(sync: SyncSnapshot?): String {
        if (sync == null) return getString(R.string.sync_not_started)
        return when (sync.syncState) {
            SyncState.DOWNLOADING -> getString(R.string.sync_downloading, progressText(sync))
            SyncState.ERROR -> getString(R.string.sync_error)
            SyncState.IDLE -> getString(if (sync.appliedManifest == null) R.string.sync_waiting else R.string.sync_up_to_date)
        }
    }

    private fun progressText(sync: SyncSnapshot): String {
        val progress = sync.progress
        val percent = if (progress.bytesTotal > 0) (progress.bytesDone * 100 / progress.bytesTotal).toInt() else 0
        return getString(R.string.sync_progress, progress.filesDone, progress.filesTotal, percent)
    }

    private fun connectionText(state: DeviceSocket.ConnectionState): String =
        getString(
            when (state) {
                DeviceSocket.ConnectionState.CONNECTED -> R.string.connection_connected
                DeviceSocket.ConnectionState.CONNECTING -> R.string.connection_connecting
                DeviceSocket.ConnectionState.DISCONNECTED -> R.string.connection_disconnected
                DeviceSocket.ConnectionState.UNAUTHORIZED -> R.string.connection_unauthorized
                DeviceSocket.ConnectionState.STOPPED -> R.string.connection_stopped
            },
        )

    private fun formatTime(instant: Instant): String =
        DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss", TURKISH).format(instant.atZone(ZoneId.systemDefault()))

    // ---------------------------------------------------------------- connection test

    private fun showConnectionTest() {
        serverPanel.isVisible = false
        connectionPanel.isVisible = true
        updateFocusBlocking()
        connectionRetryButton.requestFocus()
        runConnectionTest()
    }

    private fun hideConnectionTest() {
        connectionTestJob?.cancel()
        connectionPanel.isVisible = false
        updateFocusBlocking()
        restoreFocus()
    }

    private fun runConnectionTest() {
        connectionTestJob?.cancel()
        val serverUrl = prefs.serverUrl
        connectionServer.text = getString(R.string.conn_server, serverUrl)
        connectionResult.text = ""
        connectionVerdict.text = getString(R.string.conn_running)
        connectionVerdict.setTextColor(ContextCompat.getColor(this, R.color.text_secondary))
        connectionTestJob =
            lifecycleScope.launch {
                try {
                    ConnectionTester(this@MainActivity, PlayerRuntime.http).run(serverUrl).collect { report ->
                        connectionResult.text = report.steps.joinToString("\n") { stepLine(it) }
                        if (report.finished) showVerdict(report.success, null)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Any unexpected failure is a test result, not a crash of the player.
                    showVerdict(false, ErrorText.describe(this@MainActivity, e))
                }
            }
    }

    private fun showVerdict(success: Boolean, detail: String?) {
        val text = getString(if (success) R.string.conn_result_ok else R.string.conn_result_failed)
        connectionVerdict.text = if (detail == null) text else getString(R.string.conn_result_with_detail, text, detail)
        connectionVerdict.setTextColor(ContextCompat.getColor(this, if (success) R.color.success else R.color.error))
    }

    private fun stepLine(step: ConnectionTester.Step): String {
        val outcome =
            getString(
                when (step.outcome) {
                    ConnectionTester.Outcome.OK -> R.string.conn_outcome_ok
                    ConnectionTester.Outcome.FAILED -> R.string.conn_outcome_failed
                    ConnectionTester.Outcome.SKIPPED -> R.string.conn_outcome_skipped
                    ConnectionTester.Outcome.INFO -> R.string.conn_outcome_info
                },
            )
        return getString(R.string.conn_step_line, outcome, step.title, step.detail)
    }

    // ---------------------------------------------------------------- server address

    private fun showServerSettings() {
        connectionTestJob?.cancel()
        connectionPanel.isVisible = false
        serverInput.setText(prefs.serverUrl)
        serverInput.setSelection(serverInput.text.length)
        serverError.isVisible = false
        serverPanel.isVisible = true
        updateFocusBlocking()
        serverInput.requestFocus()
    }

    private fun hideServerSettings() {
        hideKeyboard()
        serverPanel.isVisible = false
        updateFocusBlocking()
        restoreFocus()
    }

    private fun saveServerAddress() {
        when (val result = ServerAddress.normalize(serverInput.text.toString(), allowCleartext = BuildConfig.DEBUG)) {
            is ServerAddress.Result.Valid -> {
                val isDefault = result.url == BuildConfig.DEFAULT_SERVER_URL.trim().removeSuffix("/")
                lifecycleScope.launch {
                    withContext(Dispatchers.IO) { prefs.setServerUrl(if (isDefault) null else result.url) }
                    hideServerSettings()
                    PlayerService.notifySettingsChanged(this@MainActivity)
                }
            }
            is ServerAddress.Result.Invalid -> {
                serverError.text =
                    getString(
                        when (result.reason) {
                            ServerAddress.Reason.EMPTY -> R.string.server_error_empty
                            ServerAddress.Reason.NOT_A_URL -> R.string.server_error_invalid
                            ServerAddress.Reason.CLEARTEXT_NOT_ALLOWED -> R.string.server_error_cleartext
                        },
                    )
                serverError.isVisible = true
                serverInput.requestFocus()
            }
        }
    }

    private fun hideKeyboard() {
        ContextCompat.getSystemService(this, InputMethodManager::class.java)?.hideSoftInputFromWindow(serverInput.windowToken, 0)
    }

    // ---------------------------------------------------------------- panels and focus

    private fun isModalPanelVisible(): Boolean = connectionPanel.isVisible || serverPanel.isVisible

    private fun isAnyPanelVisible(): Boolean = isModalPanelVisible() || infoOverlay.isVisible

    private fun closeTopPanel() {
        when {
            serverPanel.isVisible -> hideServerSettings()
            connectionPanel.isVisible -> hideConnectionTest()
            infoOverlay.isVisible -> hideInfo()
            identifyOverlay.isVisible -> identifyOverlay.isVisible = false
            // Kiosk: BACK never leaves the player.
            else -> Unit
        }
    }

    /** While a dialog-like panel is open, D-pad focus must not wander to the buttons underneath. */
    private fun updateFocusBlocking() {
        val blocking = if (isModalPanelVisible()) ViewGroup.FOCUS_BLOCK_DESCENDANTS else ViewGroup.FOCUS_AFTER_DESCENDANTS
        pairingScreen.descendantFocusability = blocking
        infoOverlay.descendantFocusability = blocking
    }

    private fun restoreFocus() {
        when {
            serverPanel.isVisible -> serverInput.requestFocus()
            connectionPanel.isVisible -> connectionRetryButton.requestFocus()
            infoOverlay.isVisible -> infoTestButton.requestFocus()
            pairingScreen.isVisible -> pairingTestButton.requestFocus()
            else -> currentFocus?.clearFocus()
        }
    }

    private fun TextView.setTextIfChanged(value: CharSequence) {
        if (text.toString() != value.toString()) text = value
    }

    companion object {
        private const val TAG = "MainActivity"
        private const val REPLAN_INTERVAL_MS = 15_000L
        private const val MAX_ERROR_CHARS = 300
        private const val DASH = "—"
        private val TURKISH: Locale = Locale.forLanguageTag("tr-TR")

        /** Opens (or brings to the front) the player from a non-activity context. */
        fun launchIntent(context: Context): Intent =
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
