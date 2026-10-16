import { describe, expect, it } from "vitest";
import { activeRuleId, schedulesForDevice, toManifestRules } from "./active-schedule";
import { loginPathFor, safeNextPath } from "./navigation";
import { formatPairingCode, normalizePairingCode } from "./pairing";
import { passwordProblems } from "./passwords";
import { groupSecret, normalizeTotpCode, totpSecretFromUri } from "./totp";
import { isAcceptedMediaFile, uploadErrorMessage } from "./upload";
import type { api } from "@managealltv/protocol";

describe("navigation", () => {
  it("only follows local paths after login", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("/media?x=1")).toBe("/media?x=1");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/login")).toBe("/");
  });

  it("builds the login redirect", () => {
    expect(loginPathFor("/", "")).toBe("/login");
    expect(loginPathFor("/devices/abc", "?tab=1")).toBe("/login?next=%2Fdevices%2Fabc%3Ftab%3D1");
  });
});

describe("pairing codes", () => {
  it("accepts the code the way people type it", () => {
    expect(normalizePairingCode("482 913")).toBe("482913");
    expect(normalizePairingCode("482-913")).toBe("482913");
    expect(normalizePairingCode("4829131")).toBe("482913");
    expect(formatPairingCode("482913")).toBe("482 913");
    expect(formatPairingCode("48")).toBe("48");
  });
});

describe("passwordProblems", () => {
  it("matches the server's 12–128 rule and checks the repeat", () => {
    expect(passwordProblems("kısa", "kısa")).toEqual({ password: "En az 12 karakter olmalı." });
    expect(passwordProblems("yeterince-uzun-parola", "farklı")).toEqual({ repeat: "Parolalar aynı değil." });
    expect(passwordProblems("yeterince-uzun-parola", "yeterince-uzun-parola")).toEqual({});
    expect(passwordProblems("x".repeat(129), "x".repeat(129))).toEqual({ password: "En fazla 128 karakter olabilir." });
  });
});

describe("totp helpers", () => {
  it("reads the secret from an otpauth URI", () => {
    expect(totpSecretFromUri("otpauth://totp/ManageAllTV:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=ManageAllTV")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(totpSecretFromUri("not a uri")).toBeNull();
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
  });
});

describe("uploads", () => {
  it("accepts images and videos, also by extension when the type is missing", () => {
    expect(isAcceptedMediaFile({ name: "a.jpg", type: "image/jpeg" })).toBe(true);
    expect(isAcceptedMediaFile({ name: "a.mp4", type: "video/mp4" })).toBe(true);
    expect(isAcceptedMediaFile({ name: "film.MKV", type: "" })).toBe(true);
    expect(isAcceptedMediaFile({ name: "rapor.pdf", type: "application/pdf" })).toBe(false);
    expect(isAcceptedMediaFile({ name: "notlar.txt", type: "" })).toBe(false);
    // Formats the server would refuse with 415 are stopped before the upload starts.
    expect(isAcceptedMediaFile({ name: "anim.gif", type: "image/gif" })).toBe(false);
    expect(isAcceptedMediaFile({ name: "foto.heic", type: "" })).toBe(false);
    expect(isAcceptedMediaFile({ name: "eski.avi", type: "video/x-msvideo" })).toBe(false);
    expect(isAcceptedMediaFile({ name: "klip.MOV", type: "video/quicktime" })).toBe(true);
    expect(isAcceptedMediaFile({ name: "resim.webp", type: "application/octet-stream" })).toBe(true);
  });

  it("maps tus failures to Turkish messages", () => {
    expect(uploadErrorMessage(null, null)).toContain("Bağlantı koptu");
    expect(uploadErrorMessage(413, "")).toContain("en büyük boyutu");
    expect(uploadErrorMessage(403, "")).toBe("Dosya yükleme yetkiniz yok.");
    expect(uploadErrorMessage(400, JSON.stringify({ error: { code: "validation_error", message: "Dosya adı eksik." } }))).toBe(
      "Dosya adı eksik.",
    );
    expect(uploadErrorMessage(500, "not json")).toContain("Sunucuda");
  });
});

describe("active schedule", () => {
  const schedule = (over: Partial<api.Schedule>): api.Schedule => ({
    id: "s",
    playlistId: "pl",
    targetType: "location",
    targetId: "loc",
    days: [],
    startTime: "00:00",
    endTime: "00:00",
    startDate: null,
    endDate: null,
    priority: 0,
    playlistName: "Liste",
    targetName: "Hedef",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });

  it("orders rules like the manifest (priority desc, then oldest first)", () => {
    const rules = toManifestRules([
      schedule({ id: "low", priority: 1 }),
      schedule({ id: "new", priority: 5, createdAt: "2026-10-02T00:00:00.000Z" }),
      schedule({ id: "old", priority: 5, createdAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(rules.map((rule) => rule.id)).toEqual(["old", "new", "low"]);
  });

  it("finds the rule active now in the location's zone", () => {
    const lunch = schedule({ id: "lunch", days: ["thu"], startTime: "11:30", endTime: "14:00", priority: 10 });
    // 2026-10-15 is a Thursday; 09:00Z is 12:00 in Istanbul (UTC+3).
    const now = new Date("2026-10-15T09:00:00Z");
    expect(activeRuleId([lunch], "pl-default", "Europe/Istanbul", now)).toBe("lunch");
    expect(activeRuleId([lunch], "pl-default", "UTC", now)).toBeNull();
    expect(activeRuleId([lunch], null, "Not/AZone", now)).toBeNull();
  });

  it("selects schedules aimed at the device or its location", () => {
    const list = [
      schedule({ id: "d", targetType: "device", targetId: "dev-1" }),
      schedule({ id: "l", targetType: "location", targetId: "loc-1" }),
      schedule({ id: "other", targetType: "device", targetId: "dev-2" }),
    ];
    expect(schedulesForDevice(list, { id: "dev-1", locationId: "loc-1" }).map((s) => s.id)).toEqual(["d", "l"]);
  });
});
