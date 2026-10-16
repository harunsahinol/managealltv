import { api, DEVICE_API_BASE, Manifest, manifestIssues, PairPollResponse, PairResponse, StatusAck } from "@managealltv/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { sha256Hex } from "../src/lib/crypto";
import { deviceHub } from "../src/services/device-hub";
import { PAIRING_TTL_MS, pollPairing } from "../src/services/pairing";
import {
  body,
  type Client,
  createDevice,
  createLocation,
  deviceInfo,
  deviceRequest,
  DeviceSocket,
  deviceStatus,
  errorBody,
  login,
  postJson,
  resetDatabase,
  startServer,
  type TestServer,
  waitFor,
} from "./helpers";

const created = createApp({ rateLimit: false });
const { app } = created;
let server: TestServer;

beforeAll(async () => {
  server = await startServer(created);
});

afterAll(async () => {
  await server.close();
});

beforeEach(resetDatabase);

async function pair(): Promise<PairResponse> {
  const res = await postJson(app, `${DEVICE_API_BASE}/pair`, { device: deviceInfo() });
  expect(res.status).toBe(200);
  return PairResponse.parse(await body(res));
}

async function poll(secret: string): Promise<PairPollResponse> {
  const res = await postJson(app, `${DEVICE_API_BASE}/pair/poll`, { pairingSecret: secret });
  expect(res.status).toBe(200);
  return PairPollResponse.parse(await body(res));
}

async function commands(client: Client, deviceId: string): Promise<api.CommandView[]> {
  const res = await client.get(`/api/devices/${deviceId}/commands`);
  expect(res.status).toBe(200);
  return api.CommandView.array().parse(await body(res));
}

describe("device pairing and sync", () => {
  it("pairs, serves the manifest, talks over the WebSocket and unpairs", async () => {
    const { client: admin } = await login(app, "admin");
    const location = await createLocation("Yemekhane", "Europe/Istanbul");

    // 1. The TV asks for a code.
    const pairing = await pair();
    expect(pairing.pairingCode).toMatch(/^\d{6}$/);
    expect(pairing.pollIntervalSec).toBeGreaterThanOrEqual(1);
    const ttl = new Date(pairing.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(PAIRING_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(PAIRING_TTL_MS);
    expect(await poll(pairing.pairingSecret)).toEqual({ status: "pending" });

    // 2. An admin types the code into the panel.
    const claimRes = await admin.post("/api/devices/claim", {
      json: { pairingCode: pairing.pairingCode, name: "Yemekhane 1", locationId: location.id },
    });
    expect(claimRes.status).toBe(200);
    const claimed = api.Device.parse(await body(claimRes));
    expect(claimed).toMatchObject({
      name: "Yemekhane 1",
      locationId: location.id,
      locationName: "Yemekhane",
      online: false,
      lastSeenAt: null,
      manifestVersion: 1,
      status: null,
      manufacturer: "TCL",
      model: "43P635",
    });
    // The token does not exist before the device collects it.
    expect((await prisma.device.findUniqueOrThrow({ where: { id: claimed.id } })).tokenHash).toBeNull();

    // 3. The next poll delivers the token exactly once.
    const paired = await poll(pairing.pairingSecret);
    if (paired.status !== "paired") throw new Error(`expected paired, got ${paired.status}`);
    expect(paired.deviceId).toBe(claimed.id);
    expect(paired.deviceName).toBe("Yemekhane 1");
    expect(paired.deviceToken).toMatch(/^mtv_d_[A-Za-z0-9_-]{43}$/);
    expect(await poll(pairing.pairingSecret)).toEqual({ status: "expired" });
    const token = paired.deviceToken;
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored.tokenHash).toBe(sha256Hex(token));

    // 4. Manifest with ETag, then 304.
    const manifestRes = await deviceRequest(app, token, "/manifest");
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get("etag")).toBe('"1"');
    const manifest = Manifest.parse(await body(manifestRes));
    expect(manifestIssues(manifest)).toEqual([]);
    expect(manifest).toMatchObject({
      protocolVersion: 1,
      version: 1,
      deviceId: claimed.id,
      deviceName: "Yemekhane 1",
      timezone: "Europe/Istanbul",
      defaultPlaylistId: null,
      playlists: [],
      media: [],
      schedule: [],
      settings: { volume: null, defaultImageDurationSec: 10 },
    });
    const notModified = await deviceRequest(app, token, "/manifest", { headers: { "if-none-match": '"1"' } });
    expect(notModified.status).toBe(304);

    // 5. HTTP status fallback.
    const statusRes = await deviceRequest(app, token, "/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deviceStatus(1)),
    });
    expect(statusRes.status).toBe(200);
    expect(StatusAck.parse(await body(statusRes))).toEqual({ manifestVersion: 1 });
    const online = api.Device.parse(await body(await admin.get(`/api/devices/${claimed.id}`)));
    expect(online.online).toBe(true);
    expect(online.status?.appVersionName).toBe("0.1.1");
    expect(online.appVersionName).toBe("0.1.1");

    // 6. WebSocket: a device change pushes manifest_updated.
    const socket = await DeviceSocket.connect(server.wsUrl, token);
    await waitFor(() => (deviceHub.isConnected(claimed.id) ? true : null));
    const patch = await admin.patch(`/api/devices/${claimed.id}`, { json: { volume: 40 } });
    expect(patch.status).toBe(200);
    expect(api.Device.parse(await body(patch)).manifestVersion).toBe(2);
    expect(await socket.next("manifest_updated")).toEqual({ type: "manifest_updated", version: 2 });
    const second = await deviceRequest(app, token, "/manifest", { headers: { "if-none-match": '"1"' } });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).toBe('"2"');
    expect(Manifest.parse(await body(second)).settings.volume).toBe(40);

    // A status with an old manifest version is answered with manifest_updated.
    socket.send({ type: "status", status: deviceStatus(1) });
    expect(await socket.next("manifest_updated")).toEqual({ type: "manifest_updated", version: 2 });
    // An up-to-date status is not.
    socket.send({ type: "status", status: deviceStatus(2, { uptimeSec: 999 }) });
    await waitFor(async () => {
      const row = await prisma.device.findUniqueOrThrow({ where: { id: claimed.id } });
      const status = row.status as { uptimeSec?: number } | null;
      return status?.uptimeSec === 999 ? true : null;
    });
    expect(socket.pending()).toEqual([]);

    // 7. Commands are delivered live and their results stored.
    const commandRes = await admin.post(`/api/devices/${claimed.id}/commands`, { json: { type: "identify", durationSec: 15 } });
    expect(commandRes.status).toBe(200);
    const view = api.CommandView.parse(await body(commandRes));
    expect(view.status).toBe("sent");
    const delivered = await socket.next("command");
    expect(delivered).toEqual({ type: "command", id: view.id, command: { type: "identify", durationSec: 15 } });
    socket.send({ type: "command_result", id: view.id, ok: true, message: null });
    await waitFor(async () => ((await commands(admin, claimed.id))[0]?.status === "succeeded" ? true : null));

    // 8. Deleting the device unpairs it and revokes the token.
    const deleted = await admin.delete(`/api/devices/${claimed.id}`);
    expect(deleted.status).toBe(204);
    expect(await socket.next("unpaired")).toEqual({ type: "unpaired" });
    expect((await socket.closed).code).toBe(4001);
    const revoked = await deviceRequest(app, token, "/manifest");
    expect(revoked.status).toBe(401);
    expect((await errorBody(revoked)).error.code).toBe("unauthorized");

    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["device.claim", "device.update", "device.command", "device.delete"]));
  });

  it("rejects WebSocket upgrades without a valid token", async () => {
    await expect(DeviceSocket.connect(server.wsUrl, "mtv_d_not-a-real-token-at-all-000000000000000")).rejects.toThrow();
    const res = await app.request(`${DEVICE_API_BASE}/manifest`);
    expect(res.status).toBe(401);
  });

  it("delivers pending commands on connect, expires old ones and replaces an older connection", async () => {
    const { client: admin } = await login(app, "admin");
    const location = await createLocation();
    const { device, token } = await createDevice(location.id);

    const fresh = api.CommandView.parse(
      await body(await admin.post(`/api/devices/${device.id}/commands`, { json: { type: "set_volume", volume: 30 } })),
    );
    expect(fresh.status).toBe("pending");
    const stale = await prisma.command.create({
      data: { deviceId: device.id, payload: { type: "reload" }, createdAt: new Date(Date.now() - 11 * 60_000) },
    });

    const first = await DeviceSocket.connect(server.wsUrl, token);
    expect(await first.next("command")).toEqual({ type: "command", id: fresh.id, command: { type: "set_volume", volume: 30 } });
    const list = await commands(admin, device.id);
    expect(list.find((c) => c.id === fresh.id)?.status).toBe("sent");
    expect(list.find((c) => c.id === stale.id)?.status).toBe("expired");

    // Results may also arrive over HTTP.
    const result = await deviceRequest(app, token, `/commands/${fresh.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, message: "Ses ayarlanamadı" }),
    });
    expect(result.status).toBe(204);
    const failed = (await commands(admin, device.id)).find((c) => c.id === fresh.id);
    expect(failed).toMatchObject({ status: "failed", message: "Ses ayarlanamadı" });
    const foreign = await deviceRequest(app, token, "/commands/unknown-id/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, message: null }),
    });
    expect(foreign.status).toBe(404);

    // One connection per device: a second socket closes the first.
    const second = await DeviceSocket.connect(server.wsUrl, token);
    expect((await first.closed).code).toBe(4000);
    second.close();
  });

  it("handles unknown, expired and already claimed pairings", async () => {
    const { client: admin } = await login(app, "admin");
    const location = await createLocation();

    expect(await poll("x".repeat(43))).toEqual({ status: "expired" });

    const unknownCode = await admin.post("/api/devices/claim", {
      json: { pairingCode: "000000", name: "TV", locationId: location.id },
    });
    expect(unknownCode.status).toBe(404);
    expect((await errorBody(unknownCode)).error.code).toBe("pairing_not_found");

    const pairing = await pair();
    // 15 minutes later the pairing is expired.
    expect(await pollPairing(pairing.pairingSecret, new Date(Date.now() + PAIRING_TTL_MS + 1000))).toEqual({ status: "expired" });

    const ok = await admin.post("/api/devices/claim", {
      json: { pairingCode: pairing.pairingCode, name: "TV 1", locationId: location.id },
    });
    expect(ok.status).toBe(200);
    const again = await admin.post("/api/devices/claim", {
      json: { pairingCode: pairing.pairingCode, name: "TV 2", locationId: location.id },
    });
    expect(again.status).toBe(404);
    expect(await prisma.device.count()).toBe(1);

    const badLocation = await admin.post("/api/devices/claim", {
      json: { pairingCode: (await pair()).pairingCode, name: "TV 3", locationId: "missing" },
    });
    expect(badLocation.status).toBe(400);
  });

  it("codes of open pairings are unique", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i += 1) codes.add((await pair()).pairingCode);
    expect(codes.size).toBe(20);
  });
});
