package tv.managealltv.player.core.protocol

import java.time.DayOfWeek
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** packages/protocol/src/common.ts `MediaType`. */
@Serializable
enum class MediaType {
    @SerialName("image")
    IMAGE,

    @SerialName("video")
    VIDEO,
}

/** packages/protocol/src/common.ts `Weekday`. */
@Serializable
enum class Weekday(val dayOfWeek: DayOfWeek) {
    @SerialName("mon")
    MON(DayOfWeek.MONDAY),

    @SerialName("tue")
    TUE(DayOfWeek.TUESDAY),

    @SerialName("wed")
    WED(DayOfWeek.WEDNESDAY),

    @SerialName("thu")
    THU(DayOfWeek.THURSDAY),

    @SerialName("fri")
    FRI(DayOfWeek.FRIDAY),

    @SerialName("sat")
    SAT(DayOfWeek.SATURDAY),

    @SerialName("sun")
    SUN(DayOfWeek.SUNDAY),
    ;

    companion object {
        fun of(dayOfWeek: DayOfWeek): Weekday = entries.first { it.dayOfWeek == dayOfWeek }
    }
}

/** Every non-2xx JSON response from the server: `{ "error": { "code", "message" } }`. */
@Serializable
data class ApiError(val error: Body) {
    @Serializable
    data class Body(
        /** Stable English snake_case code, e.g. "unauthorized". */
        val code: String,
        /** Turkish, may be shown to users. */
        val message: String,
    )
}
