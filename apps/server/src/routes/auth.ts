import { Hono } from "hono";
import { auth, CLIENT_IP_HEADER } from "../auth";
import { clientIp } from "../lib/client-ip";
import { errorForStatus } from "../lib/error-handler";
import { rateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../types";

/**
 * Turkish texts for the Better Auth error codes a panel user can actually run into. Unknown codes
 * fall back to a generic message for the status.
 */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-posta adresi veya parola hatalı.",
  INVALID_EMAIL: "Geçersiz e-posta adresi.",
  INVALID_PASSWORD: "Parola hatalı.",
  PASSWORD_TOO_SHORT: "Parola en az 12 karakter olmalı.",
  PASSWORD_TOO_LONG: "Parola en fazla 128 karakter olabilir.",
  USER_NOT_FOUND: "Kullanıcı bulunamadı.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Bu hesabın parolası yok.",
  ACCOUNT_DISABLED: "Bu hesap devre dışı bırakılmış.",
  SESSION_EXPIRED: "Oturumun süresi doldu. Lütfen yeniden giriş yapın.",
  SESSION_NOT_FRESH: "Bu işlem için yeniden giriş yapmanız gerekiyor.",
  FAILED_TO_CREATE_SESSION: "Oturum açılamadı.",
  FAILED_TO_GET_SESSION: "Oturum bilgisi alınamadı.",
  INVALID_ORIGIN: "İstek kaynağı geçersiz.",
  MISSING_OR_NULL_ORIGIN: "İstek kaynağı (Origin) eksik.",
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "Başka bir siteden gelen giriş isteği engellendi.",
  VALIDATION_ERROR: "Geçersiz istek.",
  MISSING_FIELD: "Zorunlu bir alan eksik.",
  BODY_MUST_BE_AN_OBJECT: "Geçersiz istek gövdesi.",
  FIELD_NOT_ALLOWED: "Bu alan değiştirilemez.",
  EMAIL_CAN_NOT_BE_UPDATED: "E-posta adresi değiştirilemez.",
  // Sign-up is disabled: accounts only come from invites.
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "Kayıt kapalı. Hesaplar yalnız yönetici davetiyle açılır.",
  // twoFactor plugin
  INVALID_CODE: "Doğrulama kodu hatalı.",
  INVALID_BACKUP_CODE: "Yedek kod hatalı.",
  TOTP_NOT_ENABLED: "İki adımlı doğrulama etkin değil.",
  TOTP_ALREADY_ENABLED: "İki adımlı doğrulama zaten etkin.",
  TOTP_NOT_CONFIGURED: "İki adımlı doğrulama ayarlanmamış.",
  TWO_FACTOR_NOT_ENABLED: "İki adımlı doğrulama etkin değil.",
  BACKUP_CODES_NOT_ENABLED: "Yedek kodlar etkin değil.",
  INVALID_TWO_FACTOR_COOKIE: "İki adımlı doğrulama oturumu geçersiz veya süresi dolmuş. Lütfen yeniden giriş yapın.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Çok fazla hatalı deneme. Lütfen yeniden giriş yapın.",
  ACCOUNT_TEMPORARILY_LOCKED: "Çok fazla hatalı doğrulama denemesi. Hesap geçici olarak kilitlendi, lütfen daha sonra tekrar deneyin.",
};

/** "INVALID_EMAIL_OR_PASSWORD" → "invalid_email_or_password" (ApiError codes are snake_case). */
function toSnakeCase(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

/**
 * Better Auth answers errors with `{ code, message }` (English). The panel's Better Auth client reads
 * those top-level fields, so they are kept (message translated) and the protocol's ApiError
 * `error: { code, message }` is added next to them: every error body satisfies both readers.
 */
async function translateAuthError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  let body: unknown = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    body = await response.json().catch(() => null);
  }
  const rawCode = readString(body, "code");
  const fallback = errorForStatus(response.status);
  const message = (rawCode !== null ? AUTH_MESSAGES[rawCode] : undefined) ?? fallback.message;
  const code = rawCode !== null ? toSnakeCase(rawCode) : fallback.code;
  const base = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const translated = { ...base, code: rawCode ?? code, message, error: { code, message } };

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(translated), { status: response.status, statusText: response.statusText, headers });
}

export interface AuthRoutesOptions {
  rateLimit: boolean;
}

/** Better Auth (e-mail + password, TOTP) mounted at /api/auth. */
export function authRoutes(options: AuthRoutesOptions) {
  const router = new Hono<AppEnv>();
  const enabled = options.rateLimit;

  // Brute-force protection: password and second-factor guesses are limited per client IP.
  router.post("/sign-in/*", rateLimit({ limit: 10, windowMs: 60_000, enabled }));
  router.post("/two-factor/*", rateLimit({ limit: 10, windowMs: 60_000, enabled }));
  router.post("/change-password", rateLimit({ limit: 5, windowMs: 60_000, enabled }));

  router.on(["GET", "POST"], "/*", async (c) => {
    const headers = new Headers(c.req.raw.headers);
    // Better Auth trusts this header for its IP bookkeeping (session.ipAddress); only we may set it.
    headers.delete(CLIENT_IP_HEADER);
    const ip = clientIp(c);
    if (ip !== null) headers.set(CLIENT_IP_HEADER, ip);
    const method = c.req.method;
    // Auth bodies are tiny JSON documents; buffering avoids re-wrapping a half-consumed stream.
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
    const response = await auth.handler(new Request(c.req.url, { method, headers, body }));
    return translateAuthError(response);
  });

  return router;
}
