import { toApiRequestError } from "./api/errors";

/** tus chunk size from the architecture (§8.2): also keeps every request under proxy body limits. */
export const UPLOAD_CHUNK_SIZE = 50 * 1024 * 1024;

/** Delays between automatic retries of a failed chunk (ms). */
export const UPLOAD_RETRY_DELAYS = [0, 1_000, 3_000, 5_000, 10_000, 20_000];

/**
 * The formats the server accepts (apps/server/src/services/media.ts ACCEPTED_UPLOAD_TYPES and its aliases).
 * Anything else would only be refused with 415 once the upload starts.
 */
const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/x-m4v",
  "video/quicktime",
  "video/x-matroska",
  "video/mkv",
  "application/x-matroska",
  "video/webm",
]);
const ACCEPTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "m4v", "mov", "mkv", "webm"]);

/** Value for the file input's accept attribute. */
export const UPLOAD_ACCEPT = [...ACCEPTED_TYPES, ...[...ACCEPTED_EXTENSIONS].map((extension) => `.${extension}`)].join(",");

/** Shown next to rejected files. */
export const ACCEPTED_FORMATS_TEXT = "JPEG, PNG, WebP resimler ve MP4, MOV, MKV, WebM videolar";

/**
 * Browsers leave `type` empty for some containers (e.g. .mkv), so the extension decides when the type is
 * missing or generic.
 */
export function isAcceptedMediaFile(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase();
  if (ACCEPTED_TYPES.has(type)) return true;
  if (type !== "" && type !== "application/octet-stream") return false;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPTED_EXTENSIONS.has(extension);
}

/** Turkish message for a failed tus request (status 0/null = the connection itself failed). */
export function uploadErrorMessage(status: number | null, body: string | null): string {
  if (status === null || status === 0) {
    return "Bağlantı koptu ve yükleme birkaç denemeden sonra durdu. Aynı dosyayı yeniden seçerseniz kaldığı yerden devam eder.";
  }
  if (status === 413) return "Dosya izin verilen en büyük boyutu aşıyor.";
  let json: unknown = null;
  if (body !== null && body !== "") {
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      json = null;
    }
  }
  const error = toApiRequestError(status, json);
  if (error.code === "forbidden") return "Dosya yükleme yetkiniz yok.";
  return error.message;
}
