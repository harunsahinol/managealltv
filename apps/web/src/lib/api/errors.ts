import { ApiError } from "@managealltv/protocol";

/** Codes the panel itself produces (no server response involved). */
export type ClientErrorCode = "network_error" | "invalid_response" | "aborted";

/**
 * Any failure of an API call. `message` is always Turkish and safe to show; `code` is the server's
 * stable snake_case code (or one of ClientErrorCode) for branching, e.g. "media_in_use".
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Fallback texts for the codes in docs/API.md. The server already sends Turkish messages; these are
 * used only when a response has no usable body (proxy error pages, empty 409s, ...).
 */
const CODE_MESSAGES: Record<string, string> = {
  validation_error: "Girilen bilgiler geçersiz. Lütfen alanları kontrol edin.",
  unauthorized: "Oturumunuz kapanmış. Lütfen yeniden giriş yapın.",
  forbidden: "Bu işlem için yetkiniz yok.",
  not_found: "Aradığınız kayıt bulunamadı. Silinmiş olabilir.",
  conflict: "Bu işlem şu anki durumla çakışıyor. Sayfayı yenileyip tekrar deneyin.",
  rate_limited: "Çok fazla deneme yapıldı. Lütfen biraz bekleyip tekrar deneyin.",
  internal: "Sunucuda beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
  payload_too_large: "Gönderilen veri çok büyük.",
  media_in_use: "Bu medya bir oynatma listesinde kullanılıyor. Önce listeden çıkarın.",
  playlist_in_use: "Bu liste bir TV'nin varsayılan listesi ya da bir zamanlamada kullanılıyor. Önce oralardan kaldırın.",
  location_not_empty: "Bu konumda hâlâ TV var. Önce TV'leri başka bir konuma taşıyın ya da silin.",
  last_admin: "Sistemde en az bir etkin yönetici kalmalı.",
  email_taken: "Bu e-posta adresiyle kayıtlı bir kullanıcı zaten var.",
  pairing_not_found: "Bu kodla bekleyen bir TV bulunamadı. Kodun süresi dolmuş olabilir; TV ekranındaki güncel kodu girin.",
  network_error: "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
  invalid_response: "Sunucudan beklenmeyen bir yanıt geldi. Sayfayı yenileyip tekrar deneyin.",
  aborted: "İstek iptal edildi.",
};

const STATUS_CODES: Record<number, string> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

/** Stable code for a status when the body did not carry one. */
export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "internal" : "unknown");
}

/** Turkish fallback text for a code, then for a status. */
export function fallbackMessage(code: string, status: number): string {
  return (
    CODE_MESSAGES[code] ??
    CODE_MESSAGES[codeForStatus(status)] ??
    `İstek başarısız oldu (HTTP ${status}). Lütfen tekrar deneyin.`
  );
}

/**
 * Turns a non-2xx response (status + parsed JSON body, or null) into an ApiRequestError. A body in
 * the ApiError shape wins; its message is kept as is because the server writes it in Turkish.
 */
export function toApiRequestError(status: number, body: unknown): ApiRequestError {
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    const text = message.trim().length > 0 ? message : fallbackMessage(code, status);
    return new ApiRequestError(status, code, text);
  }
  const code = codeForStatus(status);
  return new ApiRequestError(status, code, fallbackMessage(code, status));
}

export function networkError(): ApiRequestError {
  return new ApiRequestError(0, "network_error", fallbackMessage("network_error", 0));
}

export function invalidResponseError(status: number): ApiRequestError {
  return new ApiRequestError(status, "invalid_response", fallbackMessage("invalid_response", status));
}

/** A Turkish sentence for anything a catch block can receive. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return fallbackMessage("aborted", 0);
  if (error instanceof TypeError) return fallbackMessage("network_error", 0);
  return "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.";
}

export function isApiError(error: unknown, code?: string): error is ApiRequestError {
  return error instanceof ApiRequestError && (code === undefined || error.code === code);
}

// ---------------------------------------------------------------- Better Auth errors

/** The error object Better Auth's client returns (`{ data, error }`). */
export interface AuthFailure {
  status: number;
  statusText?: string;
  code?: string | undefined;
  message?: string | undefined;
}

/** "INVALID_EMAIL_OR_PASSWORD" → "invalid_email_or_password", like the server's ApiError codes. */
export function authCodeToSnake(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** The server translates Better Auth messages to Turkish; fall back to our own text when one is missing. */
export function authFailureToError(failure: AuthFailure): ApiRequestError {
  const code =
    failure.code !== undefined && failure.code !== "" ? authCodeToSnake(failure.code) : codeForStatus(failure.status);
  const message =
    failure.message !== undefined && failure.message.trim() !== "" ? failure.message : fallbackMessage(code, failure.status);
  return new ApiRequestError(failure.status, code, message);
}
