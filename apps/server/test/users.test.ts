import { api } from "@managealltv/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { body, createLocation, createUser, errorBody, login, resetDatabase, signIn } from "./helpers";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

describe("users", () => {
  it("lists users and updates role and locations", async () => {
    const { client: admin, user: me } = await login(app, "admin");
    const location = await createLocation();
    const viewer = await createUser({ role: "viewer" });

    const users = api.User.array().parse(await body(await admin.get("/api/users")));
    expect(users.map((u) => u.id).sort()).toEqual([me.id, viewer.id].sort());

    const res = await admin.patch(`/api/users/${viewer.id}`, { json: { role: "editor", locationIds: [location.id], name: "Yeni Ad" } });
    expect(res.status).toBe(200);
    expect(api.User.parse(await body(res))).toMatchObject({ role: "editor", locationIds: [location.id], name: "Yeni Ad", disabled: false });

    // Promoting to admin drops the location restriction.
    const promoted = api.User.parse(await body(await admin.patch(`/api/users/${viewer.id}`, { json: { role: "admin" } })));
    expect(promoted.locationIds).toEqual([]);
    expect(await prisma.userLocation.count({ where: { userId: viewer.id } })).toBe(0);

    expect((await admin.patch(`/api/users/${viewer.id}`, { json: { locationIds: ["missing"] } })).status).toBe(400);
    expect((await admin.patch("/api/users/missing", { json: { name: "X" } })).status).toBe(404);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.update", entityId: viewer.id }, orderBy: { createdAt: "asc" } });
    expect(entry.userId).toBe(me.id);
    expect(entry.summary).toContain("Yeni Ad");
  });

  it("protects the last active admin", async () => {
    const { client: first, user: firstUser } = await login(app, "admin");

    const selfDisable = await first.patch(`/api/users/${firstUser.id}`, { json: { disabled: true } });
    expect(selfDisable.status).toBe(409);
    expect((await errorBody(selfDisable)).error.code).toBe("cannot_disable_self");

    const demote = await first.patch(`/api/users/${firstUser.id}`, { json: { role: "editor" } });
    expect(demote.status).toBe(409);
    const error = await errorBody(demote);
    expect(error.error.code).toBe("last_admin");
    expect(error.error.message).toMatch(/yönetici/);

    // With a second admin the first may step down…
    const second = await createUser({ role: "admin" });
    const secondClient = await signIn(app, second.email, second.password);
    // …but once the second is disabled, the first is the last active admin again.
    expect((await first.patch(`/api/users/${second.id}`, { json: { disabled: true } })).status).toBe(200);
    expect((await secondClient.get("/api/me")).status).toBe(401);
    expect((await first.patch(`/api/users/${firstUser.id}`, { json: { role: "viewer" } })).status).toBe(409);

    expect((await first.patch(`/api/users/${second.id}`, { json: { disabled: false } })).status).toBe(200);
    const stepDown = await first.patch(`/api/users/${firstUser.id}`, { json: { role: "viewer" } });
    expect(stepDown.status).toBe(200);
    expect(api.User.parse(await body(stepDown)).role).toBe("viewer");
    // The change applies to the very next request of the demoted user.
    expect((await first.get("/api/users")).status).toBe(403);

    const remaining = await signIn(app, second.email, second.password);
    expect((await remaining.patch(`/api/users/${second.id}`, { json: { role: "editor" } })).status).toBe(409);
    expect((await remaining.patch(`/api/users/${second.id}`, { json: { disabled: true } })).status).toBe(409);
  });
});
