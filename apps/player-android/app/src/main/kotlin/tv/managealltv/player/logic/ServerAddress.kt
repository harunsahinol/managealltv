package tv.managealltv.player.logic

import tv.managealltv.player.core.net.ServerUrls

/** Validation of the server address typed with the remote on the settings screen. */
object ServerAddress {
    sealed interface Result {
        /** Normalised origin without a trailing slash, e.g. "https://tv.example.com". */
        data class Valid(val url: String) : Result

        data class Invalid(val reason: Reason) : Result
    }

    enum class Reason { EMPTY, NOT_A_URL, CLEARTEXT_NOT_ALLOWED }

    /**
     * Accepts "tv.example.com" (https is assumed) or a full http(s) URL; keeps only the origin because
     * every device API path is absolute. Plain http is refused unless [allowCleartext] (debug builds),
     * since the release network security config would block it anyway.
     */
    fun normalize(input: String, allowCleartext: Boolean): Result {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return Result.Invalid(Reason.EMPTY)
        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val url = ServerUrls.parseBaseUrl(withScheme) ?: return Result.Invalid(Reason.NOT_A_URL)
        if (!url.isHttps && !allowCleartext) return Result.Invalid(Reason.CLEARTEXT_NOT_ALLOWED)
        return Result.Valid(url.toString().removeSuffix("/"))
    }
}
