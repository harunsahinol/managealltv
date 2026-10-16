package tv.managealltv.player.core.schedule

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import tv.managealltv.player.core.protocol.Manifest
import tv.managealltv.player.core.protocol.ScheduleRule
import tv.managealltv.player.core.protocol.Weekday

/** A wall-clock moment in the schedule's time zone. */
data class LocalMoment(
    val date: LocalDate,
    val weekday: Weekday,
    /** Minutes since local midnight, 0-1439 (seconds are ignored). */
    val minutes: Int,
)

data class ActivePlaylist(
    /** Null means nothing should play (no rule active and no default playlist). */
    val playlistId: String?,
    /** The rule that selected the playlist; null when the default playlist applies. */
    val ruleId: String?,
)

/**
 * Kotlin port of packages/protocol/src/schedule.ts. Must give the same answer for every case in
 * packages/protocol/fixtures/schedule-cases.json:
 * - startTime < endTime: active on matching days from startTime (inclusive) to endTime (exclusive).
 * - startTime > endTime: overnight window; it belongs to the day it starts on.
 * - startTime == endTime: the whole day.
 * - days empty = every day; startDate/endDate are inclusive and checked against the start day.
 * - Highest priority wins; on a tie the rule that comes first in the list wins.
 */
object ScheduleEvaluator {
    fun toLocalMoment(instant: Instant, zone: ZoneId): LocalMoment {
        val local = instant.atZone(zone)
        return LocalMoment(
            date = local.toLocalDate(),
            weekday = Weekday.of(local.dayOfWeek),
            minutes = local.hour * 60 + local.minute,
        )
    }

    fun isRuleActive(rule: ScheduleRule, now: LocalMoment): Boolean {
        // The TS side ends up with NaN for malformed values and never matches; do the same.
        val start = parseTimeOfDay(rule.startTime) ?: return false
        val end = parseTimeOfDay(rule.endTime) ?: return false
        if (start == end) return dayMatches(rule, now.date, now.weekday)
        if (start < end) {
            return now.minutes >= start && now.minutes < end && dayMatches(rule, now.date, now.weekday)
        }
        // Overnight window: it belongs to the day it starts on.
        if (now.minutes >= start) return dayMatches(rule, now.date, now.weekday)
        if (now.minutes < end) {
            val previous = now.date.minusDays(1)
            return dayMatches(rule, previous, Weekday.of(previous.dayOfWeek))
        }
        return false
    }

    /** Highest priority active rule wins; on a tie the first one in the list wins. */
    fun resolveActivePlaylist(
        rules: List<ScheduleRule>,
        defaultPlaylistId: String?,
        now: LocalMoment,
    ): ActivePlaylist {
        var best: ScheduleRule? = null
        for (rule in rules) {
            if (isRuleActive(rule, now) && (best == null || rule.priority > best.priority)) best = rule
        }
        return if (best == null) {
            ActivePlaylist(playlistId = defaultPlaylistId, ruleId = null)
        } else {
            ActivePlaylist(playlistId = best.playlistId, ruleId = best.id)
        }
    }

    /**
     * Resolves the playlist for [manifest] at [instant]. A null [instant] means the clock cannot be
     * trusted; like an unknown time zone it falls back to the default playlist (ARCHITECTURE §16).
     */
    fun resolveActivePlaylist(manifest: Manifest, instant: Instant?): ActivePlaylist {
        val zone = zoneOrNull(manifest.timezone)
        if (instant == null || zone == null) {
            return ActivePlaylist(playlistId = manifest.defaultPlaylistId, ruleId = null)
        }
        return resolveActivePlaylist(manifest.schedule, manifest.defaultPlaylistId, toLocalMoment(instant, zone))
    }

    fun zoneOrNull(timezone: String): ZoneId? =
        try {
            ZoneId.of(timezone)
        } catch (_: DateTimeException) {
            null
        }

    private fun dayMatches(rule: ScheduleRule, date: LocalDate, weekday: Weekday): Boolean {
        if (rule.days.isNotEmpty() && weekday !in rule.days) return false
        // Plain string comparison like schedule.ts: "YYYY-MM-DD" sorts chronologically, and a value the
        // regex accepts but the calendar does not (e.g. 2026-02-30) still behaves exactly as on the server.
        val day = date.toString()
        if (rule.startDate != null && day < rule.startDate) return false
        if (rule.endDate != null && day > rule.endDate) return false
        return true
    }

    private val TIME_OF_DAY = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")

    /** "HH:MM" to minutes since midnight; null when malformed. */
    internal fun parseTimeOfDay(value: String): Int? {
        val match = TIME_OF_DAY.matchEntire(value) ?: return null
        return match.groupValues[1].toInt() * 60 + match.groupValues[2].toInt()
    }

    /** Milliseconds from [instant] to the next full minute: the schedule cannot change in between. */
    fun millisUntilNextMinute(instant: Instant): Long {
        val intoMinute = Math.floorMod(instant.toEpochMilli(), 60_000L)
        return 60_000L - intoMinute
    }
}
