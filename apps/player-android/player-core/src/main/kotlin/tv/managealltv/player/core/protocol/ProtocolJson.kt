package tv.managealltv.player.core.protocol

import kotlinx.serialization.json.Json

/**
 * Json configurations for the device protocol.
 *
 * The Zod schemas require every nullable key to be PRESENT (null, not missing), so encoding always
 * writes defaults and explicit nulls.
 */
object ProtocolJson {
    /**
     * Production configuration. Unknown keys are ignored so an older player keeps working when the
     * server adds fields; unknown enum values or message types still fail and must be handled.
     */
    val default: Json = Json {
        encodeDefaults = true
        explicitNulls = true
        ignoreUnknownKeys = true
    }

    /** Rejects unknown keys. Used by the contract tests to catch name or shape drift. */
    val strict: Json = Json(from = default) {
        ignoreUnknownKeys = false
    }
}
