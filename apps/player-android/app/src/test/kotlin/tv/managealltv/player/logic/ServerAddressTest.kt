package tv.managealltv.player.logic

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerAddressTest {
    private fun valid(url: String) = ServerAddress.Result.Valid(url)

    private fun invalid(reason: ServerAddress.Reason) = ServerAddress.Result.Invalid(reason)

    @Test
    fun `host only gets https`() {
        assertEquals(valid("https://tv.example.com"), ServerAddress.normalize("  tv.example.com ", allowCleartext = false))
    }

    @Test
    fun `only the origin is kept`() {
        assertEquals(valid("https://tv.example.com:8443"), ServerAddress.normalize("https://tv.example.com:8443/panel/?x=1#y", allowCleartext = false))
        assertEquals(valid("https://tv.example.com"), ServerAddress.normalize("HTTPS://TV.Example.com/", allowCleartext = false))
    }

    @Test
    fun `cleartext only when allowed`() {
        assertEquals(invalid(ServerAddress.Reason.CLEARTEXT_NOT_ALLOWED), ServerAddress.normalize("http://192.168.1.10:3000", allowCleartext = false))
        assertEquals(valid("http://192.168.1.10:3000"), ServerAddress.normalize("http://192.168.1.10:3000", allowCleartext = true))
    }

    @Test
    fun `garbage is rejected`() {
        assertEquals(invalid(ServerAddress.Reason.EMPTY), ServerAddress.normalize("   ", allowCleartext = false))
        assertEquals(invalid(ServerAddress.Reason.NOT_A_URL), ServerAddress.normalize("ftp://tv.example.com", allowCleartext = true))
        assertEquals(invalid(ServerAddress.Reason.NOT_A_URL), ServerAddress.normalize("tv example com", allowCleartext = true))
    }
}
