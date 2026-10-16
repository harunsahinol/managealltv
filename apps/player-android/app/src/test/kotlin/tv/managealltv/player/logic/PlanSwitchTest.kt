package tv.managealltv.player.logic

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import tv.managealltv.player.core.playback.PlayItem
import tv.managealltv.player.core.playback.PlaybackPlan
import tv.managealltv.player.core.protocol.MediaType

class PlanSwitchTest {
    private fun item(id: String) = PlayItem(id, MediaType.IMAGE, File("/cache/$id"), 10_000, null)

    private fun plan(playlistId: String?, vararg ids: String) = PlaybackPlan(playlistId, null, ids.map(::item), emptyList())

    @Test
    fun `empty plan stops`() {
        assertEquals(PlanSwitch.Action.STOP, PlanSwitch.decide(plan("p1", "a"), plan("p1"), isPlaying = true, forceRestart = false))
        assertEquals(PlanSwitch.Action.STOP, PlanSwitch.decide(null, PlaybackPlan.NOTHING, isPlaying = false, forceRestart = true))
    }

    @Test
    fun `first plan or idle loop restarts`() {
        assertEquals(PlanSwitch.Action.RESTART, PlanSwitch.decide(null, plan("p1", "a"), isPlaying = false, forceRestart = false))
        assertEquals(PlanSwitch.Action.RESTART, PlanSwitch.decide(plan("p1", "a"), plan("p1", "a"), isPlaying = false, forceRestart = false))
        assertEquals(PlanSwitch.Action.RESTART, PlanSwitch.decide(plan("p1"), plan("p1", "a"), isPlaying = true, forceRestart = false))
    }

    @Test
    fun `a different playlist switches immediately`() {
        assertEquals(PlanSwitch.Action.RESTART, PlanSwitch.decide(plan("p1", "a"), plan("p2", "a"), isPlaying = true, forceRestart = false))
    }

    @Test
    fun `same playlist continues unless forced`() {
        assertEquals(PlanSwitch.Action.CONTINUE, PlanSwitch.decide(plan("p1", "a"), plan("p1", "a", "b"), isPlaying = true, forceRestart = false))
        assertEquals(PlanSwitch.Action.RESTART, PlanSwitch.decide(plan("p1", "a"), plan("p1", "a"), isPlaying = true, forceRestart = true))
    }

    @Test
    fun `unchanged list advances and wraps`() {
        val p = plan("p1", "a", "b", "c")
        assertEquals(1, PlanSwitch.nextIndex(p, 0, plan("p1", "a", "b", "c")))
        assertEquals(0, PlanSwitch.nextIndex(p, 2, p))
    }

    @Test
    fun `edited list continues after the same media`() {
        val old = plan("p1", "a", "b", "c")
        // "x" inserted before b: after b comes c, now at index 3.
        assertEquals(3, PlanSwitch.nextIndex(old, 1, plan("p1", "a", "x", "b", "c")))
        // b moved to the end: wrap to the start.
        assertEquals(0, PlanSwitch.nextIndex(old, 1, plan("p1", "a", "c", "b")))
    }

    @Test
    fun `removed media continues with the item that took its slot`() {
        val old = plan("p1", "a", "b", "c")
        assertEquals(1, PlanSwitch.nextIndex(old, 1, plan("p1", "a", "c")))
        assertEquals(0, PlanSwitch.nextIndex(old, 2, plan("p1", "a", "b")))
    }

    @Test
    fun `repeated media prefers the same slot`() {
        val old = plan("p1", "a", "b", "a", "c")
        assertEquals(3, PlanSwitch.nextIndex(old, 2, plan("p1", "a", "b", "a", "c", "d")))
    }
}
