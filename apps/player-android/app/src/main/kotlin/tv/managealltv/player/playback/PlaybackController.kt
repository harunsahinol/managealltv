package tv.managealltv.player.playback

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import tv.managealltv.player.R
import tv.managealltv.player.core.playback.PlayItem
import tv.managealltv.player.core.playback.PlaybackPlan
import tv.managealltv.player.core.protocol.MediaType
import tv.managealltv.player.logic.PlanSwitch

/**
 * Plays a [PlaybackPlan] in a loop on the main thread: videos with Media3 in [playerView], images in
 * two stacked ImageViews above it that cross-fade. Feed it a new plan with [update]; it switches at
 * once when the playlist changes and otherwise continues with the next item of the new plan.
 *
 * An item that fails is reported and skipped; if every item of the list fails in a row the loop
 * waits a little instead of spinning through broken files.
 */
class PlaybackController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val playerView: PlayerView,
    imageA: ImageView,
    imageB: ImageView,
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        /** The plan is empty: show the "Yayın yok" screen. */
        fun onNothingToPlay()

        /** A non-empty plan starts: hide the "Yayın yok" screen. */
        fun onContentShown()

        fun onItemStarted(plan: PlaybackPlan, item: PlayItem)

        /** [reason] is Turkish; it ends up in the panel as the device's last error. */
        fun onItemFailed(plan: PlaybackPlan, item: PlayItem, reason: String)
    }

    private sealed interface VideoOutcome {
        data object Ended : VideoOutcome

        data class Error(val code: String) : VideoOutcome

        data object TimedOut : VideoOutcome
    }

    private val images = arrayOf(imageA, imageB)
    private var frontImage = 0
    private var shownImageFile: File? = null

    /** Bumped on every change of the image layer so late animation end actions can tell they are stale. */
    private var imageGeneration = 0

    private var player: ExoPlayer? = null
    private var videoFile: File? = null
    private var videoOutcome: CompletableDeferred<VideoOutcome>? = null

    private var plan: PlaybackPlan? = null
    private var loopJob: Job? = null

    private val playerListener =
        object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) videoOutcome?.complete(VideoOutcome.Ended)
            }

            override fun onPlayerError(error: PlaybackException) {
                videoOutcome?.complete(VideoOutcome.Error(error.errorCodeName))
            }

            override fun onRenderedFirstFrame() {
                // The new video is on screen; only now uncover it, so there is no black gap.
                hideImages()
            }
        }

    /** Creates the player. Call from onStart. */
    fun start() {
        if (player != null) return
        val exo = ExoPlayer.Builder(context).build()
        exo.addListener(playerListener)
        exo.repeatMode = Player.REPEAT_MODE_OFF
        playerView.useController = false
        playerView.player = exo
        player = exo
    }

    /** Stops and releases the decoder, which other apps may need while the player is hidden. Call from onStop. */
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        plan = null
        videoOutcome?.cancel()
        videoOutcome = null
        playerView.player = null
        player?.let {
            it.removeListener(playerListener)
            it.release()
        }
        player = null
        videoFile = null
        clearImages()
    }

    fun update(next: PlaybackPlan, forceRestart: Boolean) {
        when (PlanSwitch.decide(plan, next, loopJob?.isActive == true, forceRestart)) {
            PlanSwitch.Action.STOP -> {
                plan = next
                stopLoop()
                callbacks.onNothingToPlay()
            }
            PlanSwitch.Action.RESTART -> {
                plan = next
                startLoop()
            }
            // The running loop reads the new plan when the current item ends.
            PlanSwitch.Action.CONTINUE -> plan = next
        }
    }

    private fun startLoop() {
        loopJob?.cancel()
        videoOutcome?.cancel()
        videoOutcome = null
        callbacks.onContentShown()
        loopJob =
            scope.launch {
                var index = 0
                var failuresInARow = 0
                while (isActive) {
                    val current = plan ?: return@launch
                    if (current.isEmpty) return@launch
                    if (index !in current.items.indices) index = 0
                    val played = playItem(current, current.items[index])
                    failuresInARow = if (played) 0 else failuresInARow + 1
                    val latest = plan ?: return@launch
                    if (failuresInARow >= maxOf(1, latest.items.size)) {
                        delay(ALL_FAILED_RETRY_MS)
                        failuresInARow = 0
                    }
                    index = PlanSwitch.nextIndex(current, index, latest)
                }
            }
    }

    private fun stopLoop() {
        loopJob?.cancel()
        loopJob = null
        videoOutcome?.cancel()
        videoOutcome = null
        player?.stop()
        videoFile = null
        clearImages()
    }

    private suspend fun playItem(plan: PlaybackPlan, item: PlayItem): Boolean =
        when (item.type) {
            MediaType.IMAGE -> playImage(plan, item)
            MediaType.VIDEO -> playVideo(plan, item)
        }

    private suspend fun playImage(plan: PlaybackPlan, item: PlayItem): Boolean {
        // A one-image playlist shows the same file again: keep it instead of decoding it every loop.
        if (shownImageFile != item.file) {
            val size = targetSize()
            val bitmap = ImageDecoding.decode(item.file, size.first, size.second)
            if (bitmap == null) {
                callbacks.onItemFailed(plan, item, context.getString(R.string.playback_image_failed))
                return false
            }
            showImage(bitmap, item.file)
        }
        callbacks.onItemStarted(plan, item)
        delay(FADE_MS)
        // The image now covers the video below it; stop that to free the decoder.
        releaseVideo()
        val durationMs = item.imageDurationMs ?: DEFAULT_IMAGE_MS
        delay((durationMs - FADE_MS).coerceAtLeast(MIN_IMAGE_MS))
        return true
    }

    private suspend fun playVideo(plan: PlaybackPlan, item: PlayItem): Boolean {
        val exo = player ?: return false
        val outcome = CompletableDeferred<VideoOutcome>()
        videoOutcome?.cancel()
        videoOutcome = outcome
        if (item.file == videoFile && exo.playbackState == Player.STATE_ENDED) {
            // The same video again (e.g. a one-video playlist): rewinding avoids a black gap.
            exo.seekTo(0)
        } else {
            exo.setMediaItem(MediaItem.fromUri(Uri.fromFile(item.file)))
            exo.prepare()
        }
        exo.playWhenReady = true
        videoFile = item.file
        callbacks.onItemStarted(plan, item)

        // A stuck decoder on a weak TV must not freeze the loop forever.
        val limitMs = (item.videoDurationMs ?: UNKNOWN_VIDEO_LIMIT_MS) + VIDEO_GRACE_MS
        val result = withTimeoutOrNull(limitMs) { outcome.await() } ?: VideoOutcome.TimedOut
        if (videoOutcome === outcome) videoOutcome = null
        val reason =
            when (result) {
                VideoOutcome.Ended -> return true
                is VideoOutcome.Error -> context.getString(R.string.playback_video_failed, result.code)
                VideoOutcome.TimedOut -> context.getString(R.string.playback_video_timeout)
            }
        exo.stop()
        videoFile = null
        callbacks.onItemFailed(plan, item, reason)
        return false
    }

    private fun releaseVideo() {
        val exo = player ?: return
        if (exo.playbackState != Player.STATE_IDLE) exo.stop()
        videoFile = null
    }

    private fun showImage(bitmap: Bitmap, file: File) {
        imageGeneration++
        val generation = imageGeneration
        images.forEach { it.animate().cancel() }
        val outgoing = images[frontImage]
        val incoming = images[1 - frontImage]
        incoming.setImageBitmap(bitmap)
        incoming.alpha = 0f
        incoming.visibility = View.VISIBLE
        incoming.bringToFront()
        incoming.animate()
            .alpha(1f)
            .setDuration(FADE_MS)
            .withEndAction {
                if (generation == imageGeneration) {
                    outgoing.setImageDrawable(null)
                    outgoing.visibility = View.INVISIBLE
                }
            }
            .start()
        frontImage = 1 - frontImage
        shownImageFile = file
    }

    private fun hideImages() {
        if (images.none { it.visibility == View.VISIBLE }) return
        imageGeneration++
        val generation = imageGeneration
        images.forEach { it.animate().cancel() }
        val front = images[frontImage]
        val back = images[1 - frontImage]
        back.setImageDrawable(null)
        back.visibility = View.INVISIBLE
        front.animate()
            .alpha(0f)
            .setDuration(FADE_MS)
            .withEndAction {
                if (generation == imageGeneration) {
                    front.setImageDrawable(null)
                    front.visibility = View.INVISIBLE
                }
            }
            .start()
        shownImageFile = null
    }

    private fun clearImages() {
        imageGeneration++
        for (image in images) {
            image.animate().cancel()
            image.setImageDrawable(null)
            image.visibility = View.INVISIBLE
        }
        shownImageFile = null
    }

    /** Decode images for the area they are drawn in; the display size until the first layout pass. */
    private fun targetSize(): Pair<Int, Int> {
        val view = images[0]
        if (view.width > 0 && view.height > 0) return view.width to view.height
        val metrics = context.resources.displayMetrics
        return metrics.widthPixels to metrics.heightPixels
    }

    private companion object {
        const val FADE_MS = 500L
        const val DEFAULT_IMAGE_MS = 10_000L
        const val MIN_IMAGE_MS = 1_000L
        const val ALL_FAILED_RETRY_MS = 10_000L
        const val VIDEO_GRACE_MS = 30_000L
        const val UNKNOWN_VIDEO_LIMIT_MS = 3 * 60 * 60 * 1000L
    }
}
