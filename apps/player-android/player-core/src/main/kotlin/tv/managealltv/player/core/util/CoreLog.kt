package tv.managealltv.player.core.util

/** Where player-core log lines go. The app routes them to Logcat; the default drops them. */
fun interface LogSink {
    fun log(level: LogLevel, tag: String, message: String, error: Throwable?)
}

enum class LogLevel { DEBUG, INFO, WARN, ERROR }

/**
 * Process-wide logger. A global sink (instead of a constructor parameter on every class) keeps the
 * public constructors small; set [sink] once at app start.
 */
object CoreLog {
    @Volatile
    var sink: LogSink = LogSink { _, _, _, _ -> }

    fun d(tag: String, message: String) = sink.log(LogLevel.DEBUG, tag, message, null)

    fun i(tag: String, message: String) = sink.log(LogLevel.INFO, tag, message, null)

    fun w(tag: String, message: String, error: Throwable? = null) = sink.log(LogLevel.WARN, tag, message, error)

    fun e(tag: String, message: String, error: Throwable? = null) = sink.log(LogLevel.ERROR, tag, message, error)
}
