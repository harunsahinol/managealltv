import { api, DEVICE_API_BASE, PairResponse } from "@managealltv/protocol";
import type { Device, Location } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { body, Client, createDevice, createLocation, deviceInfo, errorBody, login, postJson, resetDatabase } from "./helpers";

const { app } = createApp({ rateLimit: false });

let locationA: Location;
let locationB: Location;
let deviceA: Device;
let deviceB: Device;

beforeEach(async () => {
  await resetDatabase();
  locationA = await createLocation("A Konumu");
  locationB = await createLocation("B Konumu");
  deviceA = (await createDevice(locationA.id, { name: "A TV" })).device;
  deviceB = (await createDevice(locationB.id, { name: "B TV" })).device;
});

const deviceIds = async (res: Response) => api.Device.array().parse(await body(res)).map((d) => d.id);

describe("authentication", () => {
  it("requires a session for the admin API", async () => {
    for (const path of ["/api/me", "/api/devices", "/api/locations", "/api/users"]) {
      const res = await new Client(app).get(path);
      expect(res.status).toBe(401);
      expect((await errorBody(res)).error.code).toBe("unauthorized");
    }
  });
});

describe("viewer", () => {
  it("sees only devices and locations in scope, read-only", async () => {
    const { client } = await login(app, "viewer", [locationA.id]);

    expect(await deviceIds(await client.get("/api/devices"))).toEqual([deviceA.id]);
    expect((await client.get(`/api/devices/${deviceA.id}`)).status).toBe(200);
    const hidden = await client.get(`/api/devices/${deviceB.id}`);
    expect(hidden.status).toBe(404);
    expect((await errorBody(hidden)).error.code).toBe("not_found");
    expect((await client.get(`/api/devices/${deviceB.id}/commands`)).status).toBe(404);
    expect(api.Location.array().parse(await body(await client.get("/api/locations"))).map((l) => l.id)).toEqual([locationA.id]);

    expect((await client.patch(`/api/devices/${deviceA.id}`, { json: { volume: 10 } })).status).toBe(403);
    expect((await client.post(`/api/devices/${deviceA.id}/commands`, { json: { type: "reload" } })).status).toBe(403);
    expect((await client.delete(`/api/devices/${deviceA.id}`)).status).toBe(403);
    expect((await client.get("/api/users")).status).toBe(403);
    expect((await client.post("/api/locations", { json: { name: "Yeni", address: null, timezone: "Europe/Istanbul" } })).status).toBe(403);
  });

  it("cannot claim devices", async () => {
    const { client } = await login(app, "viewer", [locationA.id]);
    const pairing = PairResponse.parse(await body(await postJson(app, `${DEVICE_API_BASE}/pair`, { device: deviceInfo() })));
    const res = await client.post("/api/devices/claim", {
      json: { pairingCode: pairing.pairingCode, name: "Gizli TV", locationId: locationA.id },
    });
    expect(res.status).toBe(403);
    expect((await errorBody(res)).error.code).toBe("forbidden");
    expect(await prisma.device.count()).toBe(2);
  });
});

describe("editor", () => {
  it("may only change the default playlist and volume of devices in its locations", async () => {
    const { client } = await login(app, "editor", [locationA.id]);
    const playlist = await prisma.playlist.create({ data: { name: "Genel" } });

    const volume = await client.patch(`/api/devices/${deviceA.id}`, { json: { volume: 30 } });
    expect(volume.status).toBe(200);
    expect(api.Device.parse(await body(volume)).volume).toBe(30);

    const defaultPlaylist = await client.patch(`/api/devices/${deviceA.id}`, { json: { defaultPlaylistId: playlist.id } });
    expect(defaultPlaylist.status).toBe(200);
    expect(api.Device.parse(await body(defaultPlaylist))).toMatchObject({ defaultPlaylistId: playlist.id, expectedPlaylistId: playlist.id });

    expect((await client.patch(`/api/devices/${deviceA.id}`, { json: { name: "Yeni ad" } })).status).toBe(403);
    expect((await client.patch(`/api/devices/${deviceA.id}`, { json: { locationId: locationB.id } })).status).toBe(403);
    expect((await client.patch(`/api/devices/${deviceA.id}`, { json: { defaultPlaylistId: "missing" } })).status).toBe(400);

    // Out of scope → 404, even for an otherwise allowed change.
    expect((await client.patch(`/api/devices/${deviceB.id}`, { json: { volume: 30 } })).status).toBe(404);
    expect((await client.post(`/api/devices/${deviceB.id}/commands`, { json: { type: "reload" } })).status).toBe(404);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: deviceB.id } })).volume).toBeNull();

    const command = await client.post(`/api/devices/${deviceA.id}/commands`, { json: { type: "reload" } });
    expect(command.status).toBe(200);
    expect(api.CommandView.parse(await body(command))).toMatchObject({ status: "pending", deviceId: deviceA.id });
    const invalid = await client.post(`/api/devices/${deviceA.id}/commands`, { json: { type: "set_volume", volume: 101 } });
    expect(invalid.status).toBe(400);

    expect((await client.delete(`/api/devices/${deviceA.id}`)).status).toBe(403);
    expect((await client.post("/api/devices/claim", { json: { pairingCode: "123456", name: "X", locationId: locationA.id } })).status).toBe(403);
    expect(await deviceIds(await client.get("/api/devices"))).toEqual([deviceA.id]);
    expect((await client.get("/api/users")).status).toBe(403);
  });
});

describe("admin", () => {
  it("sees everything and manages locations", async () => {
    const { client } = await login(app, "admin");
    expect((await deviceIds(await client.get("/api/devices"))).sort()).toEqual([deviceA.id, deviceB.id].sort());

    const created = await client.post("/api/locations", { json: { name: "C Konumu", address: "Cadde 1", timezone: "Europe/Berlin" } });
    expect(created.status).toBe(200);
    const location = api.Location.parse(await body(created));
    expect(location).toMatchObject({ name: "C Konumu", deviceCount: 0, timezone: "Europe/Berlin" });

    expect((await client.post("/api/locations", { json: { name: "Hatalı", address: null, timezone: "Mars/Olympus" } })).status).toBe(400);

    const renamed = await client.patch(`/api/locations/${location.id}`, { json: { name: "C2" } });
    expect(api.Location.parse(await body(renamed)).name).toBe("C2");

    const notEmpty = await client.delete(`/api/locations/${locationA.id}`);
    expect(notEmpty.status).toBe(409);
    expect((await errorBody(notEmpty)).error.code).toBe("location_not_empty");
    expect((await client.delete(`/api/locations/${location.id}`)).status).toBe(204);
    expect((await client.delete(`/api/locations/${location.id}`)).status).toBe(404);

    // Moving a device to another location changes its manifest (time zone, location rules).
    await client.patch(`/api/locations/${locationB.id}`, { json: { timezone: "Europe/London" } });
    const moved = await client.patch(`/api/devices/${deviceA.id}`, { json: { locationId: locationB.id, name: "Taşındı" } });
    expect(api.Device.parse(await body(moved))).toMatchObject({ locationId: locationB.id, locationName: "B Konumu", name: "Taşındı", manifestVersion: 2 });
  });
});
