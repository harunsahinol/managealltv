import { api } from "@managealltv/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { body, Client, createLocation, errorBody, login, resetDatabase } from "./helpers";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

const entries = async (res: Response) => {
  expect(res.status).toBe(200);
  return api.AuditEntry.array().parse(await body(res));
};

describe("GET /api/audit", () => {
  it("lists entries of admin actions newest first, with user name and Turkish summary", async () => {
    const { client, user } = await login(app, "admin");
    const location = await client.post("/api/locations", { json: { name: "Merkez", address: null, timezone: "Europe/Istanbul" } });
    const { id: locationId } = api.Location.parse(await body(location));
    await client.post("/api/playlists", { json: { name: "Genel" } });
    await client.post("/api/users/invites", { json: { name: "Ayşe", email: "ayse@example.com", role: "viewer", locationIds: [locationId] } });

    const list = await entries(await client.get("/api/audit"));
    expect(list.map((entry) => entry.action)).toEqual(["user.invite", "playlist.create", "location.create"]);
    expect(list.every((entry) => entry.userName === user.name)).toBe(true);
    expect(list[2]).toMatchObject({ entityType: "location", entityId: locationId, summary: '"Merkez" konumu oluşturuldu' });
    expect(list[1]?.summary).toBe('"Genel" oynatma listesi oluşturuldu');
    const times = list.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("is for admins only", async () => {
    const anonymous = await new Client(app).get("/api/audit");
    expect(anonymous.status).toBe(401);
    for (const role of ["editor", "viewer"] as const) {
      const { client } = await login(app, role);
      const res = await client.get("/api/audit");
      expect(res.status).toBe(403);
      expect((await errorBody(res)).error.code).toBe("forbidden");
    }
  });

  it("pages with limit and before", async () => {
    const { client } = await login(app, "admin");
    const base = Date.parse("2026-10-01T08:00:00.000Z");
    // Ten entries one minute apart, plus one without a user (e.g. a CLI action).
    await prisma.auditLog.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        action: "location.update",
        entityType: "location",
        entityId: `loc-${i}`,
        summary: `Kayıt ${i}`,
        createdAt: new Date(base + i * 60_000),
      })),
    });
    const location = await createLocation("Silinecek");
    await prisma.auditLog.create({
      data: { action: "location.delete", entityType: "location", entityId: location.id, summary: "Sistem kaydı", createdAt: new Date(base - 60_000) },
    });

    const firstPage = await entries(await client.get("/api/audit?limit=4"));
    expect(firstPage.map((e) => e.summary)).toEqual(["Kayıt 9", "Kayıt 8", "Kayıt 7", "Kayıt 6"]);

    const last = firstPage.at(-1);
    if (!last) throw new Error("empty page");
    const secondPage = await entries(await client.get(`/api/audit?limit=4&before=${encodeURIComponent(last.at)}`));
    expect(secondPage.map((e) => e.summary)).toEqual(["Kayıt 5", "Kayıt 4", "Kayıt 3", "Kayıt 2"]);

    const rest = await entries(await client.get(`/api/audit?before=${encodeURIComponent(secondPage.at(-1)?.at ?? "")}`));
    expect(rest.map((e) => e.summary)).toEqual(["Kayıt 1", "Kayıt 0", "Sistem kaydı"]);
    expect(rest.at(-1)).toMatchObject({ userName: null, entityId: location.id });

    // Default page size is 100 (newest first).
    expect((await entries(await client.get("/api/audit"))).length).toBe(11);

    for (const query of ["limit=0", "limit=501", "limit=abc", "before=dün", "before=2026-10-01"]) {
      const res = await client.get(`/api/audit?${query}`);
      expect(res.status, query).toBe(400);
      expect((await errorBody(res)).error.code).toBe("validation_error");
    }
  });
});
