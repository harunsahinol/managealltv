import type { ApiError } from "@managealltv/protocol";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/**
 * Throw this from any handler/service; app.onError turns it into the protocol's ApiError body.
 * `message` is Turkish (shown to users), `code` is stable English snake_case.
 */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function apiErrorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export const badRequest = (message: string, code = "validation_error") => new HttpError(400, code, message);
export const unauthorized = (message = "Oturum açmanız gerekiyor") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Bu işlem için yetkiniz yok") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Kayıt bulunamadı", code = "not_found") => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/**
 * Turkish, single-line summary of a ZodError. Issue messages come from zod's Turkish locale, which
 * app.ts installs globally (z.config(z.locales.tr())), or from the schema's own Turkish messages.
 */
export function describeZodError(error: z.core.$ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length > 5 ? ` (+${error.issues.length - 5} hata daha)` : "";
  return `Geçersiz istek. ${parts.join("; ")}${more}`;
}

export function validationError(error: z.core.$ZodError): HttpError {
  return new HttpError(400, "validation_error", describeZodError(error));
}
