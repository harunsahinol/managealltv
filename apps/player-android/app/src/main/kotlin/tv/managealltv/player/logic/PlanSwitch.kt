package tv.managealltv.player.logic

import tv.managealltv.player.core.playback.PlaybackPlan

/**
 * How the play loop reacts to a fresh [PlaybackPlan] (computed every 15 s and whenever a new manifest
 * is applied). Kept free of Android types so it runs as a plain JVM unit test.
 */
object PlanSwitch {
    enum class Action {
        /** Nothing to show: stop and display the "Yayın yok" screen. */
        STOP,

        /** Start the new plan from its first item right now (e.g. a schedule rule just began). */
        RESTART,

        /** Same playlist: let the current item finish, then continue in the new plan. */
        CONTINUE,
    }

    fun decide(current: PlaybackPlan?, next: PlaybackPlan, isPlaying: Boolean, forceRestart: Boolean): Action =
        when {
            next.isEmpty -> Action.STOP
            forceRestart || current == null || !isPlaying || current.isEmpty -> Action.RESTART
            current.playlistId != next.playlistId -> Action.RESTART
            else -> Action.CONTINUE
        }

    /**
     * Index in [next] to play after the item at [index] of [previous] (the plan that item came from).
     * When the playlist was edited while the item played, the loop continues after the same media in
     * the new list; if that media was removed, the item that took over its slot comes next.
     */
    fun nextIndex(previous: PlaybackPlan, index: Int, next: PlaybackPlan): Int {
        val size = next.items.size
        if (size == 0) return 0
        if (previous.items == next.items) return (index + 1) % size
        val playedId = previous.items.getOrNull(index)?.mediaId ?: return 0
        val position =
            if (next.items.getOrNull(index)?.mediaId == playedId) {
                index
            } else {
                next.items.indexOfFirst { it.mediaId == playedId }
            }
        return when {
            position >= 0 -> (position + 1) % size
            index < size -> index
            else -> 0
        }
    }
}
