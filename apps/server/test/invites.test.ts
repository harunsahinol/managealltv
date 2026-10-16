import { api } from "@managealltv/protocol";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { sha256Hex } from "../src/lib/crypto";
import { INVITE_TTL_MS } from "../src/services/invites";
import {
  body,
  Client,
  createLocation,
  createUser,
  errorBody,
  login,
  ORIGIN,
  resetDatabase,
  signIn,
  tokenFromInviteUrl,
} from "./helpers";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

function signInRequest(email: string, password: string): Promise<Response> {
  return new Client(app).post("/api/auth/sign-in/email", { json: { email, password } });
}

describe("invites", () => {
  it("creates a single-use invite that creates the user, who can then sign in", async () => {
    const { client: admin } = await login(app, "admin");
    const location = await createLocation("Şube 1");

    const res = await admin.post("/api/users/invites", {
      json: { name: "Ayşe Yılmaz", email: "Ayse@Example.com", role: "editor", locationIds: [location.id] },
    });
    expect(res.status).toBe(200);
    const link = api.InviteLink.parse(await body(res));
    expect(link.url.startsWith(`${ORIGIN}/invite/`)).toBe(true);
    const token = tokenFromInviteUrl(link.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const validity = new Date(link.expiresAt).getTime() - Date.now();
    expect(validity).toBeGreaterThan(INVITE_TTL_MS - 60_000);
    expect(validity).toBeLessThanOrEqual(INVITE_TTL_MS);

    // Only the hash is stored.
    const stored = await prisma.invite.findFirstOrThrow({ where: { email: "ayse@example.com" } });
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const info = await new Client(app).get(`/api/invites/${token}`);
    expect(info.status).toBe(200);
    expect(api.InviteInfo.parse(await body(info))).toEqual({
      kind: "invite",
      name: "Ayşe Yılmaz",
      email: "ayse@example.com",
      expiresAt: link.expiresAt,
    });

    const weak = await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "kisa" } });
    expect(weak.status).toBe(400);
    expect((await errorBody(weak)).error.code).toBe("validation_error");

    const accepted = await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "Yeni-Parola-2026" } });
    expect(accepted.status).toBe(204);

    // Single use.
    expect((await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "Yeni-Parola-2026" } })).status).toBe(404);
    expect((await new Client(app).get(`/api/invites/${token}`)).status).toBe(404);

    // The new account signs in through Better Auth although public sign-up is disabled.
    const user = await signIn(app, "ayse@example.com", "Yeni-Parola-2026");
    const me = api.Me.parse(await body(await user.get("/api/me")));
    expect(me).toEqual({
      id: me.id,
      name: "Ayşe Yılmaz",
      email: "ayse@example.com",
      role: "editor",
      locationIds: [location.id],
      twoFactorEnabled: false,
    });

    const duplicate = await admin.post("/api/users/invites", {
      json: { name: "Başka", email: "ayse@example.com", role: "viewer", locationIds: [] },
    });
    expect(duplicate.status).toBe(409);
    expect((await errorBody(duplicate)).error.code).toBe("email_taken");

    const actions = (await prisma.auditLog.findMany()).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["user.invite", "invite.accept"]));
  });

  it("answers 404 for unknown and expired links and 400 for unknown locations", async () => {
    const { client: admin } = await login(app, "admin");
    expect((await new Client(app).get(`/api/invites/${"a".repeat(43)}`)).status).toBe(404);
    expect((await new Client(app).get("/api/invites/short")).status).toBe(404);

    const res = await admin.post("/api/users/invites", {
      json: { name: "Eski", email: "eski@example.com", role: "viewer", locationIds: [] },
    });
    const token = tokenFromInviteUrl(api.InviteLink.parse(await body(res)).url);
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await new Client(app).get(`/api/invites/${token}`)).status).toBe(404);
    expect((await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "Yeni-Parola-2026" } })).status).toBe(404);

    const badLocation = await admin.post("/api/users/invites", {
      json: { name: "X", email: "x@example.com", role: "viewer", locationIds: ["missing"] },
    });
    expect(badLocation.status).toBe(400);
  });

  it("password reset sets the new password and revokes all sessions", async () => {
    const { client: admin } = await login(app, "admin");
    const user = await createUser({ role: "viewer", password: "Eski-Parola-2026" });
    const session = await signIn(app, user.email, user.password);
    expect((await session.get("/api/me")).status).toBe(200);

    const res = await admin.post(`/api/users/${user.id}/password-reset`);
    expect(res.status).toBe(200);
    const token = tokenFromInviteUrl(api.InviteLink.parse(await body(res)).url);
    const info = api.InviteInfo.parse(await body(await new Client(app).get(`/api/invites/${token}`)));
    expect(info.kind).toBe("password_reset");
    expect(info.email).toBe(user.email);

    expect((await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "Yeni-Parola-2026" } })).status).toBe(204);

    expect((await session.get("/api/me")).status).toBe(401);
    expect((await signInRequest(user.email, "Eski-Parola-2026")).status).toBe(401);
    const fresh = await signIn(app, user.email, "Yeni-Parola-2026");
    expect((await fresh.get("/api/me")).status).toBe(200);
    expect((await new Client(app).post(`/api/invites/${token}/accept`, { json: { password: "Baska-Parola-2026" } })).status).toBe(404);

    expect((await admin.post("/api/users/missing/password-reset")).status).toBe(404);
  });

  it("disabled users lose their sessions and cannot sign in", async () => {
    const { client: admin } = await login(app, "admin");
    const user = await createUser({ role: "editor" });
    const session = await signIn(app, user.email, user.password);

    const res = await admin.patch(`/api/users/${user.id}`, { json: { disabled: true } });
    expect(res.status).toBe(200);
    expect(api.User.parse(await body(res)).disabled).toBe(true);
    expect((await session.get("/api/me")).status).toBe(401);

    const denied = await signInRequest(user.email, user.password);
    expect(denied.status).toBe(403);
    const error = await errorBody(denied);
    expect(error.error.code).toBe("account_disabled");
    expect(error.error.message).toBe("Bu hesap devre dışı bırakılmış.");

    await admin.patch(`/api/users/${user.id}`, { json: { disabled: false } });
    expect((await signInRequest(user.email, user.password)).status).toBe(200);
  });

  it("keeps public sign-up closed and offers TOTP with the ManageAllTV issuer", async () => {
    const signUp = await new Client(app).post("/api/auth/sign-up/email", {
      json: { name: "Yabancı", email: "stranger@example.com", password: "Bir-Parola-2026" },
    });
    expect(signUp.status).toBe(400);
    expect((await errorBody(signUp)).error.code).toBe("email_password_sign_up_disabled");
    expect(await prisma.user.count({ where: { email: "stranger@example.com" } })).toBe(0);

    const { client, user } = await login(app, "viewer");
    const enable = await client.post("/api/auth/two-factor/enable", { json: { password: user.password } });
    expect(enable.status).toBe(200);
    const result = (await body(enable)) as { totpURI?: string };
    expect(result.totpURI).toContain("issuer=ManageAllTV");
  });
});

describe("admin:invite CLI", () => {
  const serverDir = fileURLToPath(new URL("..", import.meta.url));
  const run = (args: string[]) =>
    promisify(execFile)(`${serverDir}node_modules/.bin/tsx`, ["src/cli/create-admin-invite.ts", ...args], {
      cwd: serverDir,
      env: process.env,
    });

  it("prints a one-time admin invite and refuses once an admin exists", async () => {
    const first = await run(["--", "--email", "Kurucu@Example.com", "--name", "Kurucu Yönetici"]);
    const url = /(http\S+\/invite\/\S+)/.exec(first.stdout)?.[1];
    expect(url).toBeDefined();
    const token = tokenFromInviteUrl(url ?? "");
    const info = api.InviteInfo.parse(await body(await new Client(app).get(`/api/invites/${token}`)));
    expect(info).toMatchObject({ kind: "invite", email: "kurucu@example.com", name: "Kurucu Yönetici" });
    expect((await prisma.invite.findFirstOrThrow({ where: { email: "kurucu@example.com" } })).role).toBe("admin");

    await createUser({ role: "admin" });
    await expect(run(["--email", "ikinci@example.com", "--name", "İkinci"])).rejects.toMatchObject({ code: 1 });
    const forced = await run(["--email", "ikinci@example.com", "--name", "İkinci", "--force"]);
    expect(forced.stdout).toContain("/invite/");
  }, 60_000);
});
