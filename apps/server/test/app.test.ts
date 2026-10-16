import { DEVICE_API_BASE } from "@managealltv/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { body, Client, deviceInfo, errorBody, login, postJson, resetDatabase } from "./helpers";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

describe("app", () => {
  it("answers /health with security headers", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("uses the ApiError shape for unknown routes and validation errors (Turkish messages)", async () => {
    const missing = await app.request("/api/nope");
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).error.code).toBe("not_found");

    const invalid = await postJson(app, `${DEVICE_API_BASE}/pair`, { device: { ...deviceInfo(), sdkInt: "otuz" } });
    expect(invalid.status).toBe(400);
    const error = await errorBody(invalid);
    expect(error.error.code).toBe("validation_error");
    expect(error.error.message).toContain("device.sdkInt");
    expect(error.error.message).toContain("Geçersiz");

    const malformed = await app.request(`${DEVICE_API_BASE}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).error.code).toBe("validation_error");
  });

  it("adds the ApiError shape to Better Auth errors and translates them", async () => {
    const res = await new Client(app).post("/api/auth/sign-in/email", { json: { email: "yok@example.com", password: "Yanlis-Parola-1" } });
    expect(res.status).toBe(401);
    const value = (await body(res)) as { code: string; message: string; error: { code: string; message: string } };
    expect(value.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(value.error).toEqual({ code: "invalid_email_or_password", message: "E-posta adresi veya parola hatalı." });
    expect(value.message).toBe(value.error.message);
  });

  it("rejects state-changing requests from foreign origins", async () => {
    const { client } = await login(app, "admin");
    const location = { name: "Yeni", address: null, timezone: "Europe/Istanbul" };
    const foreign = await client.post("/api/locations", { json: location, headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect((await errorBody(foreign)).error.code).toBe("forbidden");
    expect((await client.post("/api/locations", { json: location })).status).toBe(200);
  });

  it("rate limits pairing per client", async () => {
    const limited = createApp({ rateLimit: true }).app;
    for (let i = 0; i < 10; i += 1) {
      expect((await postJson(limited, `${DEVICE_API_BASE}/pair`, { device: deviceInfo() })).status).toBe(200);
    }
    const res = await postJson(limited, `${DEVICE_API_BASE}/pair`, { device: deviceInfo() });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await errorBody(res)).error.code).toBe("rate_limited");
  });

  it("rate limits sign-in attempts", async () => {
    const limited = createApp({ rateLimit: true }).app;
    const attempt = () => new Client(limited).post("/api/auth/sign-in/email", { json: { email: "a@example.com", password: "Yanlis-Parola-1" } });
    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});
