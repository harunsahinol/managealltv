import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  authCodeToSnake,
  authFailureToError,
  codeForStatus,
  errorMessage,
  fallbackMessage,
  isApiError,
  toApiRequestError,
} from "./errors";

describe("toApiRequestError", () => {
  it("keeps the server's code and Turkish message", () => {
    const error = toApiRequestError(409, {
      error: { code: "media_in_use", message: "Bu medya 2 listede kullanılıyor." },
    });
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("media_in_use");
    expect(error.message).toBe("Bu medya 2 listede kullanılıyor.");
  });

  it("falls back to a Turkish text for a known code with an empty message", () => {
    const error = toApiRequestError(409, { error: { code: "playlist_in_use", message: " " } });
    expect(error.message).toBe(fallbackMessage("playlist_in_use", 409));
    expect(error.message).toContain("zamanlamada");
  });

  it("maps bodies that are not ApiError by status", () => {
    expect(toApiRequestError(404, null)).toMatchObject({ code: "not_found", status: 404 });
    expect(toApiRequestError(429, "<html>")).toMatchObject({ code: "rate_limited" });
    expect(toApiRequestError(502, { message: "Bad gateway" })).toMatchObject({ code: "internal" });
    expect(toApiRequestError(418, null).message).toContain("HTTP 418");
  });

  it("has a Turkish message for every documented code", () => {
    for (const code of ["validation_error", "unauthorized", "forbidden", "not_found", "conflict", "rate_limited", "internal",
      "media_in_use", "playlist_in_use", "location_not_empty", "last_admin", "email_taken", "pairing_not_found"]) {
      expect(fallbackMessage(code, 400)).not.toMatch(/HTTP/);
    }
  });
});

describe("codeForStatus", () => {
  it("covers the documented statuses", () => {
    expect(codeForStatus(400)).toBe("validation_error");
    expect(codeForStatus(401)).toBe("unauthorized");
    expect(codeForStatus(403)).toBe("forbidden");
    expect(codeForStatus(500)).toBe("internal");
    expect(codeForStatus(503)).toBe("internal");
  });
});

describe("errorMessage", () => {
  it("returns a sentence for anything thrown", () => {
    expect(errorMessage(new ApiRequestError(409, "last_admin", "Son yönetici."))).toBe("Son yönetici.");
    expect(errorMessage(new TypeError("Failed to fetch"))).toContain("Sunucuya ulaşılamadı");
    expect(errorMessage(new DOMException("aborted", "AbortError"))).toBe("İstek iptal edildi.");
    expect(errorMessage("oops")).toContain("Beklenmeyen");
  });

  it("narrows by code", () => {
    const error = new ApiRequestError(404, "not_found", "Yok.");
    expect(isApiError(error)).toBe(true);
    expect(isApiError(error, "not_found")).toBe(true);
    expect(isApiError(error, "conflict")).toBe(false);
    expect(isApiError(new Error("x"))).toBe(false);
  });
});

describe("Better Auth failures", () => {
  it("snake-cases Better Auth codes", () => {
    expect(authCodeToSnake("INVALID_EMAIL_OR_PASSWORD")).toBe("invalid_email_or_password");
    expect(authCodeToSnake("invalidCode")).toBe("invalid_code");
  });

  it("keeps the server-translated message", () => {
    const error = authFailureToError({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "E-posta adresi veya parola hatalı." });
    expect(error).toMatchObject({ status: 401, code: "invalid_email_or_password", message: "E-posta adresi veya parola hatalı." });
  });

  it("falls back when the message is missing", () => {
    const error = authFailureToError({ status: 429 });
    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("Çok fazla deneme");
  });
});
