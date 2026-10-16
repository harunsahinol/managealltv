import type { DeviceStatus } from "@managealltv/protocol";
import { describe, expect, it } from "vitest";
import { describeCommand, deviceSync, isLongOffline } from "./devices";

const status: DeviceStatus = {
  manifestVersion: 7,
  activePlaylistId: "pl_1",
  currentMediaId: "m_1",
  syncState: "idle",
  syncFilesDone: 0,
  syncFilesTotal: 0,
  syncBytesDone: 0,
  syncBytesTotal: 0,
  lastError: null,
  freeStorageBytes: 1_000_000,
  uptimeSec: 100,
  appVersionName: "1.0.0",
  appVersionCode: 1,
  volume: 40,
  overlayPermission: true,
  deviceOwner: false,
};

describe("deviceSync", () => {
  it("reports devices that never sent a status", () => {
    expect(deviceSync({ status: null, manifestVersion: 3 }).kind).toBe("never");
  });

  it("is in sync when the versions match", () => {
    expect(deviceSync({ status, manifestVersion: 7 })).toEqual({ kind: "synced", label: "Güncel" });
  });

  it("warns when the TV is behind the server", () => {
    const view = deviceSync({ status, manifestVersion: 8 });
    expect(view.kind).toBe("outdated");
    if (view.kind === "outdated") expect(view.detail).toContain("Sunucuda sürüm 8, TV'de sürüm 7");
    const fresh = deviceSync({ status: { ...status, manifestVersion: null }, manifestVersion: 1 });
    if (fresh.kind === "outdated") expect(fresh.detail).toContain("TV'de henüz yok");
  });

  it("shows download progress by bytes, falling back to files", () => {
    const byBytes = deviceSync({
      status: { ...status, syncState: "downloading", syncFilesDone: 1, syncFilesTotal: 4, syncBytesDone: 25, syncBytesTotal: 100 },
      manifestVersion: 8,
    });
    expect(byBytes).toMatchObject({ kind: "downloading", fraction: 0.25, label: "İndiriliyor %25" });
    if (byBytes.kind === "downloading") expect(byBytes.detail).toBe("1/4 dosya, 25 B / 100 B");
    const byFiles = deviceSync({
      status: { ...status, syncState: "downloading", syncFilesDone: 3, syncFilesTotal: 4 },
      manifestVersion: 8,
    });
    expect(byFiles).toMatchObject({ kind: "downloading", fraction: 0.75 });
  });

  it("surfaces sync errors with the device's message", () => {
    expect(deviceSync({ status: { ...status, syncState: "error", lastError: "Disk dolu" }, manifestVersion: 8 })).toMatchObject({
      kind: "error",
      detail: "Disk dolu",
    });
  });
});

describe("isLongOffline", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("flags devices offline for more than 10 minutes", () => {
    const base = { createdAt: "2026-10-01T00:00:00Z" };
    expect(isLongOffline({ ...base, online: true, lastSeenAt: "2026-10-15T09:00:00Z" }, now)).toBe(false);
    expect(isLongOffline({ ...base, online: false, lastSeenAt: "2026-10-15T11:55:00Z" }, now)).toBe(false);
    expect(isLongOffline({ ...base, online: false, lastSeenAt: "2026-10-15T11:45:00Z" }, now)).toBe(true);
    expect(isLongOffline({ ...base, online: false, lastSeenAt: null }, now)).toBe(true);
  });
});

describe("describeCommand", () => {
  it("names commands in Turkish", () => {
    expect(describeCommand({ type: "reload" })).toBe("Yenile");
    expect(describeCommand({ type: "identify", durationSec: 30 })).toBe("Tanımla (30 sn)");
    expect(describeCommand({ type: "set_volume", volume: 35 })).toBe("Ses seviyesi 35");
    expect(describeCommand({ type: "reboot" })).toBe("Yeniden başlat");
  });
});
