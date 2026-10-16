import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { logger } from "../logger";
import { apiErrorBody, describeZodError, HttpError } from "./errors";

const CODE_BY_STATUS: Partial<Record<number, { code: string; message: string }>> = {
  400: { code: "validation_error", message: "Geçersiz istek." },
  401: { code: "unauthorized", message: "Oturum açmanız gerekiyor." },
  403: { code: "forbidden", message: "Bu işlem için yetkiniz yok." },
  404: { code: "not_found", message: "Kayıt bulunamadı." },
  405: { code: "method_not_allowed", message: "Bu yöntem desteklenmiyor." },
  409: { code: "conflict", message: "İşlem mevcut durumla çakışıyor." },
  413: { code: "payload_too_large", message: "İstek çok büyük." },
  415: { code: "unsupported_media_type", message: "Desteklenmeyen içerik türü." },
  429: { code: "rate_limited", message: "Çok fazla istek gönderildi. Lütfen biraz bekleyin." },
};

export function errorForStatus(status: number): { code: string; message: string } {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? { code: "internal", message: "Sunucu hatası." } : { code: "error", message: "İstek başarısız oldu." });
}

/** app.onError: every error leaves the server as { error: { code, message } }. */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof HttpError) {
    const response = c.json(apiErrorBody(error.code, error.message), error.status);
    for (const [key, value] of Object.entries(error.headers ?? {})) response.headers.set(key, value);
    return response;
  }
  // $ZodError covers both classic ZodError (schema.parse in handlers) and core errors.
  if (error instanceof z.core.$ZodError) {
    return c.json(apiErrorBody("validation_error", describeZodError(error)), 400);
  }
  if (error instanceof HTTPException) {
    // Thrown by Hono itself, e.g. malformed JSON body in a validator or body-limit.
    const status = error.status as ContentfulStatusCode;
    const mapped = errorForStatus(status);
    const message = status === 400 ? "Geçersiz istek gövdesi (JSON okunamadı)." : mapped.message;
    return c.json(apiErrorBody(mapped.code, message), status);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Safety nets for races the handlers did not pre-check.
    if (error.code === "P2025") return c.json(apiErrorBody("not_found", "Kayıt bulunamadı."), 404);
    if (error.code === "P2002") return c.json(apiErrorBody("conflict", "Bu kayıt zaten mevcut."), 409);
    if (error.code === "P2003") return c.json(apiErrorBody("conflict", "Kayıt başka kayıtlar tarafından kullanılıyor."), 409);
  }
  logger.error("Unhandled error", { error, method: c.req.method, path: c.req.path });
  return c.json(apiErrorBody("internal", "Beklenmeyen bir sunucu hatası oluştu."), 500);
}
