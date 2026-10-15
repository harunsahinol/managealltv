package tv.managealltv.player.core.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/** packages/protocol/src/ws.ts `Command`: remote commands an authorised panel user can send. */
@Serializable
@JsonClassDiscriminator("type")
sealed interface Command {
    /** Fetch the manifest again and re-sync. */
    @Serializable
    @SerialName("reload")
    data object Reload : Command

    /** Restart the player app. */
    @Serializable
    @SerialName("restart_app")
    data object RestartApp : Command

    /** Show the device name full screen for a while, to find the TV. */
    @Serializable
    @SerialName("identify")
    data class Identify(val durationSec: Int) : Command

    @Serializable
    @SerialName("set_volume")
    data class SetVolume(val volume: Int) : Command

    /** Reboot the TV. Only works when the app is Device Owner. */
    @Serializable
    @SerialName("reboot")
    data object Reboot : Command
}

/** Messages the server sends on the device WebSocket (GET /api/device/v1/ws). */
@Serializable
@JsonClassDiscriminator("type")
sealed interface ServerToDevice {
    @Serializable
    @SerialName("manifest_updated")
    data class ManifestUpdated(val version: Int) : ServerToDevice

    @Serializable
    @SerialName("command")
    data class CommandMessage(val id: String, val command: Command) : ServerToDevice

    /** The device was removed in the panel; it must forget its token and show pairing again. */
    @Serializable
    @SerialName("unpaired")
    data object Unpaired : ServerToDevice
}

/** Messages the device sends on the WebSocket. */
@Serializable
@JsonClassDiscriminator("type")
sealed interface DeviceToServer {
    /** Sent on connect and then every [ProtocolConstants.HEARTBEAT_INTERVAL_SEC] seconds. */
    @Serializable
    @SerialName("status")
    data class StatusMessage(val status: DeviceStatus) : DeviceToServer

    @Serializable
    @SerialName("command_result")
    data class CommandResultMessage(
        val id: String,
        val ok: Boolean,
        val message: String?,
    ) : DeviceToServer
}
