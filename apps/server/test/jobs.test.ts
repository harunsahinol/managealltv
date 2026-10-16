import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db";
import { jobQueue, registerJob, sendJob, startJobs, stopJobs } from "../src/jobs";
import { runMaintenance } from "../src/maintenance";
import { PAIRING_RETENTION_MS } from "../src/services/pairing";
import { createDevice, createLocation, deviceInfo, resetDatabase } from "./helpers";

beforeEach(resetDatabase);

afterAll(async () => {
  await stopJobs();
});

describe("jobs", () => {
  it("runs registered handlers for queued jobs (before and after start)", async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = async (data: { value: string }) => {
      seen.push(data.value);
      if (seen.length === 2) release();
    };

    registerJob<{ value: string }>({ name: "test.before", handler: record, pollingIntervalSeconds: 0.5 });
    await expect(sendJob("test.before", { value: "x" })).rejects.toThrow(/not running/);
    await startJobs();
    expect(jobQueue()).not.toBeNull();
    registerJob<{ value: string }>({ name: "test.after", handler: record, pollingIntervalSeconds: 0.5 });
    // Give the late worker a moment to create its queue.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await sendJob("test.before", { value: "eins" })).toEqual(expect.any(String));
    expect(await sendJob("test.after", { value: "zwei" })).toEqual(expect.any(String));
    await done;
    expect(seen.sort()).toEqual(["eins", "zwei"]);

    await stopJobs();
    expect(jobQueue()).toBeNull();
  }, 30_000);
});

describe("maintenance", () => {
  it("expires stale commands and purges old pairings", async () => {
    const location = await createLocation();
    const { device } = await createDevice(location.id);
    const stale = await prisma.command.create({
      data: { deviceId: device.id, payload: { type: "reload" }, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    const fresh = await prisma.command.create({ data: { deviceId: device.id, payload: { type: "reload" } } });
    await prisma.devicePairing.create({
      data: { code: "123456", secretHash: "a".repeat(64), info: deviceInfo(), expiresAt: new Date(Date.now() - PAIRING_RETENTION_MS - 1000) },
    });

    await runMaintenance();

    expect((await prisma.command.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("expired");
    expect((await prisma.command.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("pending");
    expect(await prisma.devicePairing.count()).toBe(0);
  });
});
