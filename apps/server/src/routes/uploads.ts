/**
 * tus 1.0 resumable uploads at /api/uploads (docs/API.md "Media"). The panel uploads in 50 MB chunks
 * (ARCHITECTURE §8.2), so every request stays far below proxy body limits and a dropped connection
 * only costs the current chunk.
 *
 * Auth: the Hono middleware resolves the session (admin/editor only) before tus sees the request;
 * the tus hooks then tie each upload to the user who created it, so nobody can append to, inspect
 * or cancel another person's upload.
 */
import { Server, type ServerOptions } from "@tus/server";
import { FileStore } from "@tus/file-store";
import { Prisma, type Media } from "@prisma/client";
import { Hono } from "hono";
import { trustedOrigins } from "../auth";
import { prisma } from "../db";
import { env, publicUrl } from "../env";
import { clientIp } from "../lib/client-ip";
import { errorForStatus } from "../lib/error-handler";
import { apiErrorBody, HttpError } from "../lib/errors";
import { uploadsDir } from "../lib/storage";
import { logger } from "../logger";
import { requireRole, requireUser } from "../middleware/session";
import { auditAs, q } from "../services/audit";
import { baseFileName, displayNameFromFileName, resolveUploadType } from "../services/media";
import { enqueueMediaProcessing } from "../services/media-processing";
import type { AppEnv, AuthUser } from "../types";

export const UPLOADS_PATH = "/api/uploads";
/** Response header carrying the id of the Media created when an upload finishes. */
export const MEDIA_ID_HEADER = "Media-Id";
/** tus metadata key holding the uploader's user id (set by the server, never trusted from clients). */
const OWNER_METADATA_KEY = "ownerId";

/** tus methods; GET (downloading an original back) is deliberately not offered. */
const TUS_METHODS = new Set(["POST", "PATCH", "HEAD", "DELETE", "OPTIONS"]);

/** Turkish messages for tus' own (English, plain text) error responses, by status. */
const TUS_ERROR_MESSAGES: Partial<Record<number, { code: string; message: string }>> = {
  400: { code: "validation_error", message: "Geçersiz yükleme isteği." },
  403: { code: "validation_error", message: "Geçersiz yükleme isteği (eksik başlık)." },
  404: { code: "not_found", message: "Yükleme bulunamadı." },
  409: { code: "upload_offset_conflict", message: "Yükleme konumu uyuşmuyor; yükleme kaldığı yerden yeniden denenmeli." },
  410: { code: "upload_gone", message: "Bu yükleme artık mevcut değil; dosyayı yeniden yükleyin." },
  412: { code: "unsupported_tus_version", message: "Desteklenmeyen tus sürümü." },
  413: { code: "payload_too_large", message: "Dosya izin verilen en büyük boyutu aşıyor." },
  500: { code: "internal", message: "Yükleme sırasında bir sunucu hatası oluştu." },
  501: { code: "not_implemented", message: "Bu yükleme özelliği desteklenmiyor." },
};

interface UploadRequestContext {
  user: AuthUser;
  ip: string | null;
}

/**
 * The tus hooks only receive the Request; the user that the Hono middleware resolved is passed along
 * keyed by that same Request object (tus hands it through unchanged).
 */
const requestContexts = new WeakMap<Request, UploadRequestContext>();

/** Error shape tus understands from hooks: status_code + body. The body is already an ApiError. */
class TusHookError extends Error {
  readonly status_code: number;
  readonly body: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TusHookError";
    this.status_code = status;
    this.body = JSON.stringify(apiErrorBody(code, message));
  }
}

function contextOf(req: Request): UploadRequestContext {
  const context = requestContexts.get(req);
  if (!context) throw new TusHookError(401, "unauthorized", "Oturum açmanız gerekiyor.");
  return context;
}

/**
 * Origin for the Location header. Behind Caddy the API sees its own internal address, so the URL is
 * built from PUBLIC_URL — unless the request came in through another trusted origin (e.g. the Vite
 * dev server's proxy), in which case that one is used so the browser stays on its own origin.
 * X-Forwarded-Proto/Host only count when TRUST_PROXY is on (tus' respectForwardedHeaders).
 */
function uploadOrigin(proto: string, host: string | null | undefined): string {
  const candidate = host ? `${proto}://${host}` : null;
  return candidate !== null && trustedOrigins().includes(candidate) ? candidate : publicUrl.origin;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`;
}

async function createMediaForUpload(
  upload: { id: string; size?: number; metadata?: Record<string, string | null> },
  context: UploadRequestContext,
): Promise<Media> {
  // A repeated final PATCH (offset already equal to the size) calls onUploadFinish again.
  const existing = await prisma.media.findUnique({ where: { uploadId: upload.id } });
  if (existing) return existing;

  const fileName = baseFileName(upload.metadata?.filename ?? "");
  const type = resolveUploadType(upload.metadata?.filetype, fileName);
  if (fileName === "" || type === null) throw new TusHookError(415, "unsupported_media_type", "Desteklenmeyen dosya türü.");

  let media: Media;
  try {
    media = await prisma.$transaction(async (tx) => {
      const row = await tx.media.create({
        data: {
          name: displayNameFromFileName(fileName),
          type: type.mediaType,
          fileName,
          sourceMimeType: type.mimeType,
          uploadId: upload.id,
          uploadedById: context.user.id,
        },
      });
      await auditAs(
        { userId: context.user.id, ip: context.ip },
        {
          action: "media.upload",
          entityType: "media",
          entityId: row.id,
          summary: `${q(row.name)} ${type.mediaType === "video" ? "videosu" : "resmi"} yüklendi (${formatMegabytes(upload.size ?? 0)})`,
          details: { fileName, mimeType: type.mimeType, size: upload.size ?? null },
        },
        tx,
      );
      return row;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.media.findUniqueOrThrow({ where: { uploadId: upload.id } });
    }
    throw error;
  }
  await enqueueMediaProcessing(media.id);
  return media;
}

function createTusServer(): Server {
  const datastore = new FileStore({ directory: uploadsDir });
  const options: Omit<ServerOptions, "locker"> & { datastore: FileStore } = {
    path: UPLOADS_PATH,
    datastore,
    maxSize: env.MAX_UPLOAD_BYTES,
    respectForwardedHeaders: env.TRUST_PROXY,
    allowedOrigins: trustedOrigins(),
    allowedCredentials: true,
    exposedHeaders: [MEDIA_ID_HEADER],
    generateUrl: (_req, { proto, host, path, id }) => `${uploadOrigin(proto, host)}${path}/${id}`,

    onIncomingRequest: async (req, uploadId) => {
      const { user } = contextOf(req);
      if (req.method === "POST") return;
      const upload = await datastore.getUpload(uploadId);
      // Someone else's upload looks exactly like a missing one.
      if (upload.metadata?.[OWNER_METADATA_KEY] !== user.id) throw new TusHookError(404, "not_found", "Yükleme bulunamadı.");
    },

    onUploadCreate: async (req, upload) => {
      const { user } = contextOf(req);
      const metadata = upload.metadata ?? {};
      const fileName = baseFileName(metadata.filename ?? "");
      if (fileName === "") throw new TusHookError(400, "validation_error", "Dosya adı (filename) zorunludur.");
      const type = resolveUploadType(metadata.filetype, fileName);
      if (type === null) {
        throw new TusHookError(
          415,
          "unsupported_media_type",
          "Desteklenmeyen dosya türü. JPEG, PNG ve WebP resimleri ile MP4, MOV, MKV ve WebM videoları yüklenebilir.",
        );
      }
      if (upload.size === 0) throw new TusHookError(400, "validation_error", "Dosya boş.");
      return { metadata: { ...metadata, filename: fileName, filetype: type.mimeType, [OWNER_METADATA_KEY]: user.id } };
    },

    onUploadFinish: async (req, upload) => {
      const media = await createMediaForUpload(upload, contextOf(req));
      return { headers: { [MEDIA_ID_HEADER]: media.id } };
    },

    onResponseError: (req, error) => {
      // tus turns unexpected exceptions (database down, disk full) into a bare 500; keep the cause.
      if (!("status_code" in error) || error.status_code >= 500) {
        logger.error("Upload request failed", { method: req.method, url: req.url, error });
      }
      return undefined;
    },
  };
  return new Server(options);
}

/**
 * Makes tus responses follow the API conventions: errors become `{ error: { code, message } }` with a
 * Turkish message, and a HEAD on a finished upload also names the Media it became (a client that
 * lost the final PATCH response learns the id when it resumes).
 */
async function finalizeResponse(req: Request, response: Response): Promise<Response> {
  if (response.status >= 400) {
    const text = await response.text();
    let body: string;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) throw new Error("not an ApiError");
      body = text;
    } catch {
      const mapped = TUS_ERROR_MESSAGES[response.status] ?? errorForStatus(response.status);
      body = JSON.stringify(apiErrorBody(mapped.code, mapped.message));
    }
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Content-Length", String(Buffer.byteLength(body)));
    return new Response(body, { status: response.status, headers });
  }

  if (req.method === "HEAD" && response.status === 200) {
    const offset = response.headers.get("upload-offset");
    if (offset !== null && offset === response.headers.get("upload-length")) {
      const uploadId = new URL(req.url).pathname.split("/").pop() ?? "";
      const media = await prisma.media.findUnique({ where: { uploadId }, select: { id: true } });
      if (media) response.headers.set(MEDIA_ID_HEADER, media.id);
    }
  }
  return response;
}

export function uploadsRoutes() {
  const tus = createTusServer();
  const router = new Hono<AppEnv>();

  // CORS preflights carry no cookies; tus answers them without touching any upload.
  router.use("*", (c, next) => (c.req.method === "OPTIONS" ? next() : requireUser(c, next)));
  router.use("*", (c, next) => (c.req.method === "OPTIONS" ? next() : requireRole("admin", "editor")(c, next)));

  router.all("*", async (c) => {
    if (!TUS_METHODS.has(c.req.method)) {
      throw new HttpError(405, "method_not_allowed", "Bu yöntem desteklenmiyor.", { Allow: [...TUS_METHODS].join(", ") });
    }
    const req = c.req.raw;
    if (c.req.method !== "OPTIONS") requestContexts.set(req, { user: c.get("user"), ip: clientIp(c) });
    return finalizeResponse(req, await tus.handleWeb(req));
  });

  return router;
}
