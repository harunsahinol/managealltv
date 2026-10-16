package tv.managealltv.player.core.sync

import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import tv.managealltv.player.core.cache.MediaCache
import tv.managealltv.player.core.net.ApiClient
import tv.managealltv.player.core.net.ApiException
import tv.managealltv.player.core.net.ManifestResult
import tv.managealltv.player.core.net.ProtocolException
import tv.managealltv.player.core.net.UnauthorizedException
import tv.managealltv.player.core.protocol.DeviceStatus
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.SyncState
import tv.managealltv.player.core.time.TimeSource
import tv.managealltv.player.core.util.CoreLog
import tv.managealltv.player.core.util.ExponentialBackoff

/**
 * Progress towards the target manifest, counted over its distinct files: files already on the
 * device count as done, so an idle device reports done == total (see fixtures/device-status.json).
 */
data class SyncProgress(
    val filesDone: Int,
    val filesTotal: Int,
    val bytesDone: Long,
    val bytesTotal: Long,
) {
    companion object {
        val EMPTY = SyncProgress(0, 0, 0, 0)
    }
}

data class SyncSnapshot(
    /** The manifest the player must use. Replaced only after every file of the new one is verified. */
    val appliedManifest: Manifest?,
    val syncState: SyncState,
    /** Manifest version being downloaded; null unless [syncState] is DOWNLOADING. */
    val targetVersion: Int?,
    val progress: SyncProgress,
    /** Why the last sync failed; cleared by the next successful one. */
    val lastError: SyncError?,
    /** When the server last confirmed the applied manifest is current. */
    val lastSuccessAt: Instant?,
) {
    /** Builds the status report; the fields the sync engine cannot know come from the app. */
    fun toDeviceStatus(
        activePlaylistId: String?,
        currentMediaId: String?,
        freeStorageBytes: Long,
        uptimeSec: Long,
        appVersionName: String,
        appVersionCode: Int,
        volume: Int?,
        overlayPermission: Boolean,
        deviceOwner: Boolean,
    ): DeviceStatus =
        DeviceStatus(
            manifestVersion = appliedManifest?.version,
            activePlaylistId = activePlaylistId,
            currentMediaId = currentMediaId,
            syncState = syncState,
            syncFilesDone = progress.filesDone,
            syncFilesTotal = progress.filesTotal,
            syncBytesDone = progress.bytesDone,
            syncBytesTotal = progress.bytesTotal,
            lastError = lastError?.message?.take(DeviceStatus.MAX_MESSAGE_LENGTH),
            freeStorageBytes = freeStorageBytes.coerceAtLeast(0),
            uptimeSec = uptimeSec.coerceAtLeast(0),
            appVersionName = appVersionName,
            appVersionCode = appVersionCode,
            volume = volume,
            overlayPermission = overlayPermission,
            deviceOwner = deviceOwner,
        )
}

sealed interface SyncOutcome {
    /** The applied manifest is current and all its files are present. */
    data class UpToDate(val version: Int) : SyncOutcome

    /** A new manifest (or a repaired one) was downloaded, verified and applied. */
    data class Applied(val version: Int, val downloadedFiles: Int, val deletedFiles: Int) : SyncOutcome

    data class Failed(val error: SyncError) : SyncOutcome
}

/**
 * Keeps the cache in line with the server's manifest (ARCHITECTURE §11.3):
 * 1. fetch the manifest (with the applied version as ETag),
 * 2. download and verify every missing file (resumable),
 * 3. apply: persist the manifest atomically — only now does [SyncSnapshot.appliedManifest] change,
 * 4. delete the files the new manifest no longer references.
 *
 * A failure at any step leaves the previous manifest and all its files in place, so the player
 * never sees a half-synced state. Syncs run on [start], every [Config.periodicIntervalMs], after a
 * failure with backoff, and whenever [requestSync] / [onManifestUpdated] asks for one.
 */
class SyncEngine(
    private val api: ApiClient,
    private val downloader: Downloader,
    private val cache: MediaCache,
    private val scope: CoroutineScope,
    private val config: Config = Config(),
    /** Free bytes on the cache's volume; the app may pass a StatFs based measurement. */
    private val availableBytes: () -> Long = { cache.rootDir.usableSpace },
    private val timeSource: TimeSource = TimeSource.SYSTEM,
    /**
     * Called (on a background thread) when the server rejects the token; the loop then stops. The
     * app drops the token, pairs again and calls [start] once it has a new one.
     */
    private val onUnauthorized: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    data class Config(
        val periodicIntervalMs: Long = 5 * 60_000L,
        val reserveBytes: Long = SyncPlanner.DEFAULT_RESERVE_BYTES,
        /** Wait after a failed sync, growing up to the periodic interval. */
        val errorBackoff: ExponentialBackoff = ExponentialBackoff(initialDelayMs = 10_000, maxDelayMs = 5 * 60_000L),
    )

    private val _state: MutableStateFlow<SyncSnapshot>
    val state: StateFlow<SyncSnapshot>

    private val mutex = Mutex()
    private val lock = Any()
    private val wakeUps = Channel<Unit>(Channel.CONFLATED)
    private var loopJob: Job? = null

    init {
        // Loaded synchronously so the player can start from the cache before any network activity.
        val applied = cache.loadAppliedManifest()
        _state =
            MutableStateFlow(
                SyncSnapshot(
                    appliedManifest = applied,
                    syncState = SyncState.IDLE,
                    targetVersion = null,
                    progress = applied?.let { progressOf(SyncPlanner.plan(it, cache)) } ?: SyncProgress.EMPTY,
                    lastError = null,
                    lastSuccessAt = null,
                ),
            )
        state = _state.asStateFlow()
    }

    /** Starts the sync loop (first sync immediately); no-op while running. */
    fun start() {
        synchronized(lock) {
            if (loopJob?.isActive == true) return
            loopJob = scope.launch { runLoop() }
        }
    }

    /** Stops the loop; a running download is cancelled and resumes from its part file next time. */
    fun stop() {
        synchronized(lock) {
            loopJob?.cancel()
            loopJob = null
        }
    }

    /** Asks the loop for a sync now (e.g. `reload` command). Coalesces with a pending request. */
    fun requestSync() {
        wakeUps.trySend(Unit)
    }

    /** Handles a `manifest_updated` WebSocket message or a `StatusAck` version. */
    fun onManifestUpdated(version: Int) {
        val current = _state.value
        if (version == current.appliedManifest?.version || version == current.targetVersion) return
        requestSync()
    }

    /** Runs one sync now, serialized with the loop. */
    suspend fun syncNow(): SyncOutcome =
        mutex.withLock {
            withContext(ioDispatcher) {
                try {
                    performSync()
                } catch (e: CancellationException) {
                    _state.update {
                        if (it.syncState == SyncState.DOWNLOADING) it.copy(syncState = SyncState.IDLE, targetVersion = null) else it
                    }
                    throw e
                } catch (e: Exception) {
                    // Never let a bug kill the loop; the player keeps playing the applied manifest.
                    CoreLog.e(TAG, "Sync failed unexpectedly", e)
                    fail(SyncError.Unexpected(e.message ?: e.javaClass.simpleName))
                }
            }
        }

    private suspend fun runLoop() {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            val outcome = syncNow()
            if (outcome is SyncOutcome.Failed && outcome.error == SyncError.Unauthorized) return
            val waitMs =
                if (outcome is SyncOutcome.Failed) {
                    config.errorBackoff.delayMs(failures++)
                } else {
                    failures = 0
                    config.periodicIntervalMs
                }
            withTimeoutOrNull(waitMs) { wakeUps.receive() }
        }
    }

    private suspend fun performSync(): SyncOutcome {
        val applied = _state.value.appliedManifest
        val result =
            try {
                api.fetchManifest(applied?.let { ApiClient.etagOf(it.version) })
            } catch (e: ApiException) {
                return fail(SyncError.Server(e.httpStatus, e.code))
            } catch (e: ProtocolException) {
                return fail(SyncError.InvalidManifest(listOf(e.message ?: "unreadable manifest")))
            } catch (e: IOException) {
                // A cancelled call surfaces as IOException("Canceled"); that is a stop, not an error.
                currentCoroutineContext().ensureActive()
                return fail(SyncError.Network(e.message))
            }
        val target =
            when (result) {
                ManifestResult.Unauthorized -> return unauthorized()
                ManifestResult.NotModified -> applied ?: return fail(SyncError.Unexpected("304 without an applied manifest"))
                is ManifestResult.Updated -> result.manifest
            }
        val issues = SyncPlanner.validate(target)
        if (issues.isNotEmpty()) return fail(SyncError.InvalidManifest(issues))

        val plan = SyncPlanner.plan(target, cache, applied)
        if (plan.isComplete && applied != null && applied.version == target.version) {
            _state.update {
                it.copy(syncState = SyncState.IDLE, targetVersion = null, progress = progressOf(plan), lastError = null, lastSuccessAt = timeSource.now())
            }
            return SyncOutcome.UpToDate(target.version)
        }

        // Leftovers of interrupted syncs that neither manifest needs would only eat into the budget.
        cache.collectGarbage(keepSha256 = plan.keepBeforeApply, keepPartials = plan.downloads.mapTo(HashSet()) { it.sha256 })
        val budget = SyncPlanner.checkBudget(plan, availableBytes(), config.reserveBytes)
        if (budget is StorageBudget.Insufficient) {
            return fail(SyncError.InsufficientStorage(budget.requiredBytes, budget.availableBytes, budget.reserveBytes))
        }

        val downloadError = downloadAll(plan)
        if (downloadError != null) return downloadError

        val missing = target.media.filter { cache.fileFor(it) == null }.map { it.id }
        if (missing.isNotEmpty()) return fail(SyncError.FilesMissing(missing))

        cache.record(target.media)
        cache.saveAppliedManifest(target)
        _state.update {
            it.copy(
                appliedManifest = target,
                syncState = SyncState.IDLE,
                targetVersion = null,
                progress = progressOf(plan, allPresent = true),
                lastError = null,
                lastSuccessAt = timeSource.now(),
            )
        }
        CoreLog.i(TAG, "Applied manifest ${target.version} (${plan.downloads.size} files downloaded)")
        // Only now may the old files go; the player has switched to the new manifest.
        val garbage =
            cache.collectGarbage(
                keepSha256 = plan.requiredContent.keys,
                keepMediaIds = target.media.mapTo(HashSet()) { it.id },
            )
        return SyncOutcome.Applied(target.version, plan.downloads.size, garbage.deletedFiles)
    }

    /** Downloads every file of [plan]; returns the failure, or null when all are verified. */
    private suspend fun downloadAll(plan: SyncPlan): SyncOutcome.Failed? {
        val target = plan.manifest
        var filesDone = plan.presentFiles
        var bytesDone = plan.presentBytes
        _state.update {
            it.copy(
                syncState = SyncState.DOWNLOADING,
                targetVersion = target.version,
                progress = SyncProgress(filesDone, plan.totalFiles, bytesDone, plan.totalBytes),
            )
        }
        for (task in plan.downloads) {
            val completedBytes = bytesDone
            try {
                downloader.download(task, cache.partialFile(task.sha256), cache.contentFile(task.sha256)) { fileBytes, _ ->
                    _state.update { it.copy(progress = it.progress.copy(bytesDone = completedBytes + fileBytes)) }
                }
            } catch (e: UnauthorizedException) {
                return unauthorized()
            } catch (e: DownloadException.HashMismatch) {
                return fail(SyncError.DownloadFailed(task.mediaId, SyncError.DownloadFailed.Reason.HASH_MISMATCH, null))
            } catch (e: DownloadException.SizeMismatch) {
                return fail(SyncError.DownloadFailed(task.mediaId, SyncError.DownloadFailed.Reason.SIZE_MISMATCH, e.message))
            } catch (e: DownloadException.HttpError) {
                return fail(SyncError.DownloadFailed(task.mediaId, SyncError.DownloadFailed.Reason.HTTP_ERROR, "HTTP ${e.httpStatus}"))
            } catch (e: IOException) {
                currentCoroutineContext().ensureActive()
                return fail(SyncError.DownloadFailed(task.mediaId, SyncError.DownloadFailed.Reason.NETWORK, e.message))
            }
            cache.record(target.media.filter { it.sha256 == task.sha256 })
            filesDone++
            bytesDone += task.size
            _state.update { it.copy(progress = SyncProgress(filesDone, plan.totalFiles, bytesDone, plan.totalBytes)) }
        }
        return null
    }

    private fun unauthorized(): SyncOutcome.Failed {
        val outcome = fail(SyncError.Unauthorized)
        onUnauthorized()
        return outcome
    }

    private fun fail(error: SyncError): SyncOutcome.Failed {
        CoreLog.w(TAG, "Sync failed: ${error.message}")
        _state.update { it.copy(syncState = SyncState.ERROR, targetVersion = null, lastError = error) }
        return SyncOutcome.Failed(error)
    }

    private fun progressOf(plan: SyncPlan, allPresent: Boolean = false): SyncProgress =
        if (allPresent) {
            SyncProgress(plan.totalFiles, plan.totalFiles, plan.totalBytes, plan.totalBytes)
        } else {
            SyncProgress(plan.presentFiles, plan.totalFiles, plan.presentBytes, plan.totalBytes)
        }

    private companion object {
        const val TAG = "SyncEngine"
    }
}
