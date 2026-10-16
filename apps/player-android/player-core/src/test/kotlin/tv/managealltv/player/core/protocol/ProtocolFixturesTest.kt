package tv.managealltv.player.core.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import tv.managealltv.player.core.Fixtures
import tv.managealltv.player.core.sync.SyncPlanner

/**
 * Every fixture of packages/protocol is decoded STRICTLY (unknown keys fail, every nullable key
 * must be present) and re-encoded; the JSON tree must come out identical. This catches any drift in
 * property names, nullability or discriminators between the Kotlin models and the Zod schemas.
 */
class ProtocolFixturesTest {
    private val strict = ProtocolJson.strict

    private fun <T> roundTrip(name: String, serializer: KSerializer<T>): T {
        val text = Fixtures.read(name)
        val value = strict.decodeFromString(serializer, text)
        assertEquals(Json.parseToJsonElement(text), strict.encodeToJsonElement(serializer, value), "$name changed in a decode/encode round trip")
        // The production configuration must read the same fixture to the same value.
        assertEquals(value, ProtocolJson.default.decodeFromString(serializer, text))
        return value
    }

    @Test
    fun `manifest round-trips and is valid`() {
        val manifest = roundTrip("manifest.json", Manifest.serializer())
        assertEquals(7, manifest.version)
        assertEquals(MediaType.VIDEO, manifest.media("med_video1")?.type)
        assertEquals(listOf(Weekday.MON, Weekday.TUE, Weekday.WED, Weekday.THU, Weekday.FRI), manifest.schedule.single().days)
        assertEquals(emptyList(), manifest.issues())
        assertEquals(emptyList(), SyncPlanner.validate(manifest))
    }

    @Test
    fun `device status round-trips`() {
        val status = roundTrip("device-status.json", DeviceStatus.serializer())
        assertEquals(SyncState.DOWNLOADING, status.syncState)
        assertEquals(3_172_000_000L, status.freeStorageBytes)
    }

    @Test
    fun `pair request and response round-trip`() {
        val request = roundTrip("pair-request.json", PairRequest.serializer())
        assertEquals(listOf("video/avc", "video/hevc", "video/x-vnd.on2.vp9"), request.device.videoDecoders)
        val response = roundTrip("pair-response.json", PairResponse.serializer())
        assertEquals("482913", response.pairingCode)
    }

    @Test
    fun `pair poll responses use the status discriminator`() {
        val responses = roundTrip("pair-poll-responses.json", ListSerializer(PairPollResponse.serializer()))
        assertEquals(3, responses.size)
        assertIs<PairPollResponse.Pending>(responses[0])
        val paired = assertIs<PairPollResponse.Paired>(responses[1])
        assertEquals("dev_9f2c1a", paired.deviceId)
        assertIs<PairPollResponse.Expired>(responses[2])
    }

    @Test
    fun `server to device messages cover every command`() {
        val messages = roundTrip("ws-server-to-device.json", ListSerializer(ServerToDevice.serializer()))
        assertEquals(ServerToDevice.ManifestUpdated(8), messages.first())
        assertEquals(ServerToDevice.Unpaired, messages.last())
        val commands = messages.filterIsInstance<ServerToDevice.CommandMessage>().map { it.command }
        assertEquals(
            listOf(Command.Reload, Command.RestartApp, Command.Identify(30), Command.SetVolume(40), Command.Reboot),
            commands,
        )
    }

    @Test
    fun `device to server messages round-trip`() {
        val messages = roundTrip("ws-device-to-server.json", ListSerializer(DeviceToServer.serializer()))
        assertIs<DeviceToServer.StatusMessage>(messages[0])
        assertEquals(DeviceToServer.CommandResultMessage("cmd_4", ok = true, message = null), messages[1])
        assertEquals(DeviceToServer.CommandResultMessage("cmd_5", ok = false, message = "Device Owner değil"), messages[2])
    }

    @Test
    fun `every fixture file is covered by a test`() {
        val covered =
            setOf(
                "manifest.json",
                "device-status.json",
                "pair-request.json",
                "pair-response.json",
                "pair-poll-responses.json",
                "ws-server-to-device.json",
                "ws-device-to-server.json",
                // ScheduleCasesTest
                "schedule-cases.json",
            )
        val present = Fixtures.dir.listFiles { file -> file.name.endsWith(".json") }!!.map { it.name }.toSet()
        assertEquals(emptySet(), present - covered, "New fixtures need a Kotlin contract test")
    }

    @Test
    fun `a missing nullable key is rejected like in Zod`() {
        val status = Json.parseToJsonElement(Fixtures.read("device-status.json")).jsonObject
        val withoutLastError = JsonObject(status - "lastError").toString()
        assertFailsWith<SerializationException> { ProtocolJson.strict.decodeFromString(DeviceStatus.serializer(), withoutLastError) }
        assertFailsWith<SerializationException> { ProtocolJson.default.decodeFromString(DeviceStatus.serializer(), withoutLastError) }
    }

    @Test
    fun `unknown keys fail strictly but are ignored in production`() {
        val manifest = Json.parseToJsonElement(Fixtures.read("manifest.json")).jsonObject
        val extended = JsonObject(manifest + ("futureField" to JsonPrimitive(1))).toString()
        assertFailsWith<SerializationException> { ProtocolJson.strict.decodeFromString(Manifest.serializer(), extended) }
        assertEquals(7, ProtocolJson.default.decodeFromString(Manifest.serializer(), extended).version)
    }

    @Test
    fun `encoding writes explicit nulls and discriminators`() {
        val result = ProtocolJson.default.encodeToJsonElement(CommandResult.serializer(), CommandResult(ok = true, message = null)).jsonObject
        assertEquals(JsonNull, result["message"])

        val message = ProtocolJson.default.encodeToJsonElement(DeviceToServer.serializer(), DeviceToServer.CommandResultMessage("c1", false, null)).jsonObject
        assertEquals(JsonPrimitive("command_result"), message["type"])
        assertEquals(JsonNull, message["message"])

        val command = ProtocolJson.default.encodeToString(Command.serializer(), Command.Reload)
        assertEquals("""{"type":"reload"}""", command)
    }

    @Test
    fun `an unknown message type is an error the socket can skip`() {
        assertFailsWith<SerializationException> {
            ProtocolJson.default.decodeFromString(ServerToDevice.serializer(), """{"type":"screenshot"}""")
        }
    }
}
