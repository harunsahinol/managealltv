package tv.managealltv.player.core.util

import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Exponential backoff with jitter: retry n (0-based) waits about initial × multiplier^n, capped at
 * [maxDelayMs], minus up to [jitterRatio] of it at random. The jitter keeps TVs that lost the server
 * at the same moment (power cut, server restart) from all reconnecting in the same second.
 */
class ExponentialBackoff(
    val initialDelayMs: Long,
    val maxDelayMs: Long,
    val multiplier: Double = 2.0,
    val jitterRatio: Double = 0.2,
    private val random: Random = Random.Default,
) {
    init {
        require(initialDelayMs > 0) { "initialDelayMs must be positive" }
        require(maxDelayMs >= initialDelayMs) { "maxDelayMs must be >= initialDelayMs" }
        require(multiplier >= 1.0) { "multiplier must be >= 1" }
        require(jitterRatio in 0.0..1.0) { "jitterRatio must be within 0..1" }
    }

    fun delayMs(attempt: Int): Long {
        val exponential = initialDelayMs * multiplier.pow(attempt.coerceIn(0, 64))
        val capped = min(exponential, maxDelayMs.toDouble())
        val jitter = capped * jitterRatio * random.nextDouble()
        return (capped - jitter).toLong().coerceAtLeast(1)
    }
}
