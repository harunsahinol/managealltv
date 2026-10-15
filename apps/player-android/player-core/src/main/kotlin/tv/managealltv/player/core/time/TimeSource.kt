package tv.managealltv.player.core.time

import java.time.Duration
import java.time.Instant

/** Clock abstraction so schedule and timing logic can be tested with a fixed time. */
interface TimeSource {
    /** Wall-clock time, used for the schedule. May jump (NTP sync, manual change). */
    fun now(): Instant

    /** Monotonic milliseconds, used for elapsed time (uptime, timeouts). Never jumps. */
    fun monotonicMs(): Long

    companion object {
        val SYSTEM: TimeSource = SystemTimeSource
    }
}

object SystemTimeSource : TimeSource {
    override fun now(): Instant = Instant.now()

    override fun monotonicMs(): Long = System.nanoTime() / 1_000_000
}

/** A [TimeSource] that only moves when told to; for tests (also usable from the app's tests). */
class ManualTimeSource(
    @Volatile var instant: Instant,
    @Volatile var monotonicMillis: Long = 0,
) : TimeSource {
    override fun now(): Instant = instant

    override fun monotonicMs(): Long = monotonicMillis

    fun advance(duration: Duration) {
        instant = instant.plus(duration)
        monotonicMillis += duration.toMillis()
    }
}
