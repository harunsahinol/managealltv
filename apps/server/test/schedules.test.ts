import { api, Manifest, manifestIssues } from "@managealltv/protocol";
import type { Device, Location, Playlist } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { body, type Client, createDevice, createLocation, deviceRequest, errorBody, login, resetDatabase } from "./helpers";
import { createReadyMedia } from "./media-helpers";

const { app } = createApp({ rateLimit: false });

let locationA: Location;
let locationB: Location;
let deviceA: { device: Device; token: string };
let deviceB: { device: Device; token: string };
let general: Playlist;
let lunch: Playlist;
let evening: Playlist;

async function playlistWithMedia(name: string): Promise<Playlist> {
  const { media } = await createReadyMedia(`${name} video`);
  return prisma.playlist.create({ data: { name, items: { create: [{ mediaId: media.id, position: 0 }] } } });
}

beforeEach(async () => {
  await resetDatabase();
  locationA = await createLocation("A Konumu");
  locationB = await createLocation("B Konumu", "Europe/London");
  general = await playlistWithMedia("Genel");
  lunch = await playlistWithMedia("Öğle");
  evening = await playlistWithMedia("Akşam");
  deviceA = await createDevice(locationA.id, { name: "A TV", defaultPlaylistId: general.id });
  deviceB = await createDevice(locationB.id, { name: "B TV", defaultPlaylistId: general.id });
});

function rule(overrides: Partial<api.ScheduleInput> = {}): api.ScheduleInput {
  return {
    playlistId: lunch.id,
    targetType: "location",
    targetId: locationA.id,
    days: [],
    startTime: "11:30",
    endTime: "14:00",
    startDate: null,
    endDate: null,
    priority: 10,
    ...overrides,
  };
}

async function create(client: Client, input: api.ScheduleInput): Promise<api.Schedule> {
  const res = await client.post("/api/schedules", { json: input });
  if (res.status !== 200) throw new Error(`Schedule create failed (${res.status}): ${await res.text()}`);
  return api.Schedule.parse(await body(res));
}

async function list(client: Client): Promise<api.Schedule[]> {
  const res = await client.get("/api/schedules");
  expect(res.status).toBe(200);
  return api.Schedule.array().parse(await body(res));
}

async function manifestOf(token: string): Promise<Manifest> {
  const res = await deviceRequest(app, token, "/manifest");
  expect(res.status).toBe(200);
  const manifest = Manifest.parse(await body(res));
  expect(manifestIssues(manifest)).toEqual([]);
  return manifest;
}

const versionOf = async (device: Device) => (await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).manifestVersion;

describe("schedules", () => {
  it("creates, reads, updates and deletes rules (admin)", async () => {
    const { client } = await login(app, "admin");

    const created = await create(client, rule({ days: ["fri", "mon", "mon"], startDate: "2026-11-01", endDate: "2026-12-31" }));
    expect(created).toMatchObject({
      playlistId: lunch.id,
      playlistName: "Öğle",
      targetType: "location",
      targetId: locationA.id,
      targetName: "A Konumu",
      // Stored Monday → Sunday without duplicates.
      days: ["mon", "fri"],
      startTime: "11:30",
      endTime: "14:00",
      startDate: "2026-11-01",
      endDate: "2026-12-31",
      priority: 10,
    });
    const onDevice = await create(client, rule({ targetType: "device", targetId: deviceB.device.id, playlistId: evening.id, startTime: "18:00", endTime: "02:00" }));
    expect(onDevice).toMatchObject({ targetName: "B TV", playlistName: "Akşam" });
    expect((await list(client)).map((s) => s.id).sort()).toEqual([created.id, onDevice.id].sort());

    const patched = await client.patch(`/api/schedules/${created.id}`, { json: { priority: 50, startDate: null, playlistId: evening.id } });
    expect(patched.status).toBe(200);
    expect(api.Schedule.parse(await body(patched))).toMatchObject({
      id: created.id,
      priority: 50,
      startDate: null,
      endDate: "2026-12-31",
      playlistId: evening.id,
      playlistName: "Akşam",
      days: ["mon", "fri"],
      createdAt: created.createdAt,
    });

    expect((await client.delete(`/api/schedules/${created.id}`)).status).toBe(204);
    expect((await client.delete(`/api/schedules/${created.id}`)).status).toBe(404);
    expect((await client.patch(`/api/schedules/${created.id}`, { json: { priority: 1 } })).status).toBe(404);
    expect((await list(client)).map((s) => s.id)).toEqual([onDevice.id]);
  });

  it("validates rules", async () => {
    const { client } = await login(app, "admin");
    const expectError = async (input: unknown, status: number, code: string) => {
      const res = await client.post("/api/schedules", { json: input });
      expect(res.status).toBe(status);
      expect((await errorBody(res)).error.code).toBe(code);
    };
    await expectError(rule({ startTime: "24:00" }), 400, "validation_error");
    await expectError(rule({ priority: 1001 }), 400, "validation_error");
    await expectError({ ...rule(), days: ["monday"] }, 400, "validation_error");
    await expectError(rule({ startDate: "2026-02-31" }), 400, "validation_error");
    await expectError(rule({ startDate: "2026-12-01", endDate: "2026-11-01" }), 400, "validation_error");
    await expectError(rule({ playlistId: "yok" }), 400, "validation_error");
    await expectError(rule({ targetId: "yok" }), 404, "not_found");
    await expectError(rule({ targetType: "device", targetId: locationA.id }), 404, "not_found");

    const created = await create(client, rule({ endDate: "2026-12-31" }));
    const res = await client.patch(`/api/schedules/${created.id}`, { json: { startDate: "2027-01-01" } });
    expect(res.status).toBe(400);
    expect(await prisma.schedule.count()).toBe(1);
  });

  it("limits editors and viewers to their locations", async () => {
    const { client: admin } = await login(app, "admin");
    const { client: editor } = await login(app, "editor", [locationA.id]);
    const { client: viewer } = await login(app, "viewer", [locationA.id]);

    const onA = await create(editor, rule());
    const onDeviceA = await create(editor, rule({ targetType: "device", targetId: deviceA.device.id }));
    const onB = await create(admin, rule({ targetId: locationB.id }));
    const onDeviceB = await create(admin, rule({ targetType: "device", targetId: deviceB.device.id }));

    // Out of scope targets look missing (404), not forbidden.
    for (const input of [rule({ targetId: locationB.id }), rule({ targetType: "device", targetId: deviceB.device.id })]) {
      const res = await editor.post("/api/schedules", { json: input });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).error.code).toBe("not_found");
    }

    const inScope = [onA.id, onDeviceA.id].sort();
    expect((await list(editor)).map((s) => s.id).sort()).toEqual(inScope);
    expect((await list(viewer)).map((s) => s.id).sort()).toEqual(inScope);
    expect((await list(admin)).map((s) => s.id).sort()).toEqual([onA.id, onDeviceA.id, onB.id, onDeviceB.id].sort());

    // Editors change and delete rules in scope only, and cannot move a rule out of their scope.
    expect((await editor.patch(`/api/schedules/${onA.id}`, { json: { priority: 20 } })).status).toBe(200);
    expect((await editor.patch(`/api/schedules/${onB.id}`, { json: { priority: 20 } })).status).toBe(404);
    expect((await editor.delete(`/api/schedules/${onDeviceB.id}`)).status).toBe(404);
    const moveOut = await editor.patch(`/api/schedules/${onA.id}`, { json: { targetId: locationB.id } });
    expect(moveOut.status).toBe(404);
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: onA.id } })).targetId).toBe(locationA.id);
    expect((await editor.delete(`/api/schedules/${onDeviceA.id}`)).status).toBe(204);

    // Viewers read only.
    expect((await viewer.post("/api/schedules", { json: rule() })).status).toBe(403);
    expect((await viewer.patch(`/api/schedules/${onA.id}`, { json: { priority: 1 } })).status).toBe(403);
    expect((await viewer.delete(`/api/schedules/${onA.id}`)).status).toBe(403);

    // A user without locations sees nothing.
    const { client: nowhere } = await login(app, "editor");
    expect(await list(nowhere)).toEqual([]);
    expect((await nowhere.post("/api/schedules", { json: rule() })).status).toBe(404);
  });

  it("puts rules into the manifests of their targets, ordered by priority then age", async () => {
    const { client } = await login(app, "admin");
    expect((await manifestOf(deviceA.token)).version).toBe(1);

    const low = await create(client, rule({ playlistId: evening.id, startTime: "18:00", endTime: "23:00", priority: 5 }));
    const first = await manifestOf(deviceA.token);
    expect(first.version).toBe(2);
    expect(first.schedule.map((r) => r.id)).toEqual([low.id]);
    expect(first.playlists.map((p) => p.id)).toEqual([general.id, evening.id]);
    // Another location's device is untouched.
    expect(await versionOf(deviceB.device)).toBe(1);

    const top = await create(client, rule({ targetType: "device", targetId: deviceA.device.id, days: ["mon", "fri"], priority: 10 }));
    const later = await create(client, rule({ playlistId: lunch.id, startTime: "08:00", endTime: "09:00", priority: 5 }));
    const manifest = await manifestOf(deviceA.token);
    expect(manifest.version).toBe(4);
    expect(manifest.schedule.map((r) => r.id)).toEqual([top.id, low.id, later.id]);
    expect(manifest.schedule[0]).toEqual({
      id: top.id,
      playlistId: lunch.id,
      days: ["mon", "fri"],
      startTime: "11:30",
      endTime: "14:00",
      startDate: null,
      endDate: null,
      priority: 10,
    });
    expect((await list(client)).map((s) => s.id)).toEqual([top.id, low.id, later.id]);

    // Raising a rule's priority reorders it.
    await client.patch(`/api/schedules/${later.id}`, { json: { priority: 11 } });
    const reordered = await manifestOf(deviceA.token);
    expect(reordered.version).toBe(5);
    expect(reordered.schedule.map((r) => r.id)).toEqual([later.id, top.id, low.id]);

    // Moving a rule to another location updates both sides.
    await client.patch(`/api/schedules/${low.id}`, { json: { targetId: locationB.id } });
    expect((await manifestOf(deviceA.token)).schedule.map((r) => r.id)).toEqual([later.id, top.id]);
    const other = await manifestOf(deviceB.token);
    expect(other.version).toBe(2);
    expect(other.timezone).toBe("Europe/London");
    expect(other.schedule.map((r) => r.id)).toEqual([low.id]);

    // An all-day rule wins right now (server view: expectedPlaylistId).
    const allDay = await create(client, rule({ targetType: "device", targetId: deviceB.device.id, playlistId: lunch.id, startTime: "00:00", endTime: "00:00", priority: 1000 }));
    const device = api.Device.parse(await body(await client.get(`/api/devices/${deviceB.device.id}`)));
    expect(device.expectedPlaylistId).toBe(lunch.id);

    // Deleting rules removes them (and their playlists) from the manifest.
    expect((await client.delete(`/api/schedules/${allDay.id}`)).status).toBe(204);
    expect((await client.delete(`/api/schedules/${low.id}`)).status).toBe(204);
    const cleared = await manifestOf(deviceB.token);
    expect(cleared.schedule).toEqual([]);
    expect(cleared.playlists.map((p) => p.id)).toEqual([general.id]);
    // 1 → moved rule in (2) → all-day rule (3) → its delete (4) → moved rule's delete (5).
    expect(cleared.version).toBe(5);
  });

  it("writes audit entries for every change", async () => {
    const { client, user } = await login(app, "editor", [locationA.id]);
    const created = await create(client, rule({ days: ["mon"], startTime: "18:00", endTime: "23:00", priority: 3 }));
    await client.patch(`/api/schedules/${created.id}`, { json: { priority: 4 } });
    await client.delete(`/api/schedules/${created.id}`);
    const rows = await prisma.auditLog.findMany({ where: { entityType: "schedule" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(rows.map((row) => [row.action, row.entityId, row.userId])).toEqual([
      ["schedule.create", created.id, user.id],
      ["schedule.update", created.id, user.id],
      ["schedule.delete", created.id, user.id],
    ]);
    expect(rows.map((row) => row.summary)).toEqual([
      '"A Konumu" konumu için "Öğle" zamanlaması eklendi (Pzt 18:00–23:00, öncelik 3)',
      '"A Konumu" konumu için "Öğle" zamanlaması güncellendi (Pzt 18:00–23:00, öncelik 4)',
      '"A Konumu" konumu için "Öğle" zamanlaması silindi (Pzt 18:00–23:00)',
    ]);
  });
});
