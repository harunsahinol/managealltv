package tv.managealltv.player.core.protocol

/** Mirrors packages/protocol/src/common.ts and ws.ts. */
object ProtocolConstants {
    /** Device protocol version; bumped only on breaking changes to device-facing messages. */
    const val PROTOCOL_VERSION: Int = 1

    /** Base path of the device-facing API. */
    const val DEVICE_API_BASE: String = "/api/device/v1"

    /** Devices send a status message at least this often. */
    const val HEARTBEAT_INTERVAL_SEC: Int = 30

    /** The server treats a device as offline after this many seconds without a heartbeat. */
    const val OFFLINE_AFTER_SEC: Int = 90
}
