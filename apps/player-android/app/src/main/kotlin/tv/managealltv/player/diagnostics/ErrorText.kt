package tv.managealltv.player.diagnostics

import android.content.Context
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.UnknownServiceException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import tv.managealltv.player.R
import tv.managealltv.player.core.net.ApiException
import tv.managealltv.player.core.net.ProtocolException

/** Turkish, installer-friendly descriptions of network failures. */
object ErrorText {
    fun describe(context: Context, error: Throwable): String {
        val detail = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
        return when (error) {
            is UnknownHostException -> context.getString(R.string.error_dns)
            is SocketTimeoutException -> context.getString(R.string.error_timeout)
            is ConnectException -> context.getString(R.string.error_connect, detail)
            // Subclasses of SSLException first.
            is SSLHandshakeException -> context.getString(R.string.error_tls_handshake, detail)
            is SSLPeerUnverifiedException -> context.getString(R.string.error_tls_handshake, detail)
            is SSLException -> context.getString(R.string.error_tls, detail)
            // OkHttp's answer to http:// when the network security config forbids cleartext.
            is UnknownServiceException -> context.getString(R.string.error_cleartext)
            is ApiException -> context.getString(R.string.error_http, error.httpStatus, error.serverMessage ?: error.code ?: "")
            is ProtocolException -> context.getString(R.string.error_protocol)
            else -> detail
        }
    }
}
