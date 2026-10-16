import { api } from "@managealltv/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { deviceHub } from "../src/services/device-hub";
import { createCommand, deliverPendingCommands } from "../src/services/devices";
import { body, createDevice, createLocation, DeviceSocket, login, resetDatabase, startServer, type TestServer, waitFor } from "./helpers";

const created = createApp({ rateLimit: false });
let server: TestServer;

beforeAll(async () => {
  server = await startServer(created);
});

afterAll(async () => {
  await server.close();
});

beforeEach(resetDatabase);

function commandMessages(socket: DeviceSocket, id: string) {
  return socket.pending().filter((m) => m.type === "command" && m.id === id);
}

describe("command delivery", () => {
  it("sends a command once when its creation races with a reconnect's pending delivery", async () => {
    const location = await createLocation();
    const { device, token } = await createDevice(location.id);
    const socket = await DeviceSocket.connect(server.wsUrl, token);
    await waitFor(() => (deviceHub.isConnected(device.id) ? true : null));

    const [view] = await Promise.all([
      createCommand(device.id, { type: "reboot" }, null),
      deliverPendingCommands(device.id),
      deliverPendingCommands(device.id),
    ]);
    // Give any duplicate time to arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(commandMessages(socket, view.id)).toHaveLength(1);
    const row = await prisma.command.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.status).toBe("sent");
    socket.close();
  });

  it("keeps a command pending while the device is offline and sends it once on connect", async () => {
    const location = await createLocation();
    const { device, token } = await createDevice(location.id);

    const view = await createCommand(device.id, { type: "reload" }, null);
    expect(view.status).toBe("pending");

    const socket = await DeviceSocket.connect(server.wsUrl, token);
    const message = await socket.next("command");
    expect(message.id).toBe(view.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commandMessages(socket, view.id)).toHaveLength(0);
    await waitFor(async () => {
      const row = await prisma.command.findUniqueOrThrow({ where: { id: view.id } });
      return row.status === "sent" ? row : null;
    });
    socket.close();
  });
});

describe("location time zones", () => {
  it("stores the canonical IANA spelling the player's java.time can resolve", async () => {
    const { client } = await login(created.app, "admin");

    const createdRes = await client.post("/api/locations", {
      json: { name: "Yemekhane", address: null, timezone: "europe/istanbul" },
    });
    expect(createdRes.status).toBe(200);
    const location = api.Location.parse(await body(createdRes));
    expect(location.timezone).toBe("Europe/Istanbul");

    const patched = await client.patch(`/api/locations/${location.id}`, { json: { timezone: "utc" } });
    expect(patched.status).toBe(200);
    expect(api.Location.parse(await body(patched)).timezone).toBe("UTC");

    const invalid = await client.patch(`/api/locations/${location.id}`, { json: { timezone: "Mars/Olympus" } });
    expect(invalid.status).toBe(400);
  });
});
