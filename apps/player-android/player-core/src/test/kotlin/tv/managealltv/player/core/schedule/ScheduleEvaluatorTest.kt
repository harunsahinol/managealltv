package tv.managealltv.player.core.schedule

import java.time.Instant
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import tv.managealltv.player.core.TestManifests
import tv.managealltv.player.core.protocol.ScheduleRule
import tv.managealltv.player.core.protocol.Weekday

class ScheduleEvaluatorTest {
    private fun rule(
        start: String,
        end: String,
        days: List<Weekday> = emptyList(),
        startDate: String? = null,
        endDate: String? = null,
        priority: Int = 0,
        id: String = "r",
    ) = ScheduleRule(id, "pl_$id", days, start, end, startDate, endDate, priority)

    private fun at(date: String, minutes: Int): LocalMoment {
        val day = LocalDate.parse(date)
        return LocalMoment(day, Weekday.of(day.dayOfWeek), minutes)
    }

    @Test
    fun `malformed times never match, like NaN on the TypeScript side`() {
        assertFalse(ScheduleEvaluator.isRuleActive(rule("7:00", "09:00"), at("2026-10-14", 8 * 60)))
        assertFalse(ScheduleEvaluator.isRuleActive(rule("07:00", "24:00"), at("2026-10-14", 8 * 60)))
    }

    @Test
    fun `dates compare as strings, so a non-calendar date behaves as on the server`() {
        // "2026-02-30" passes the LocalDate regex of the protocol; as a string it sorts after Feb 28.
        val r = rule("00:00", "00:00", endDate = "2026-02-30")
        assertTrue(ScheduleEvaluator.isRuleActive(r, at("2026-02-28", 600)))
        assertFalse(ScheduleEvaluator.isRuleActive(r, at("2026-03-01", 600)))
    }

    @Test
    fun `overnight window checks the weekday of its start day`() {
        val friday = rule("23:00", "02:00", days = listOf(Weekday.FRI))
        assertTrue(ScheduleEvaluator.isRuleActive(friday, at("2026-10-17", 60))) // Saturday 01:00
        assertFalse(ScheduleEvaluator.isRuleActive(friday, at("2026-10-16", 60))) // Friday 01:00
        assertFalse(ScheduleEvaluator.isRuleActive(friday, at("2026-10-17", 2 * 60))) // end exclusive
    }

    @Test
    fun `unknown time zone or clock falls back to the default playlist`() {
        val manifest =
            TestManifests.manifest(version = 1, media = emptyList(), playlists = emptyList(), defaultPlaylistId = null)
                .copy(defaultPlaylistId = "pl_default", schedule = listOf(rule("00:00", "00:00", id = "all")))
        val now = Instant.parse("2026-10-14T09:00:00Z")
        assertEquals("pl_all", ScheduleEvaluator.resolveActivePlaylist(manifest, now).playlistId)
        assertEquals("pl_default", ScheduleEvaluator.resolveActivePlaylist(manifest, null).playlistId)
        assertEquals("pl_default", ScheduleEvaluator.resolveActivePlaylist(manifest.copy(timezone = "Mars/Olympus"), now).playlistId)
    }

    @Test
    fun `next minute boundary`() {
        assertEquals(60_000, ScheduleEvaluator.millisUntilNextMinute(Instant.parse("2026-10-14T09:00:00Z")))
        assertEquals(500, ScheduleEvaluator.millisUntilNextMinute(Instant.parse("2026-10-14T09:00:59.500Z")))
    }
}
