import { toApiRequestError } from "./api/errors";

/** tus chunk size from the architecture (§8.2): also keeps every request under proxy body limits. */
export const UPLOAD_CHUNK_SIZE = 50 * 1024 * 1024;

/** Delays between automatic retries of a failed chunk (ms). */
export const UPLOAD_RETRY_DELAYS = [0, 1_000, 3_000, 5_000, 10_000, 20_000];

const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "wmv", "3gp"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif"];

/**
 * Only images and videos can be shown on a TV. Browsers leave `type` empty for some containers
 * (e.g. .mkv), so the extension decides when the type is missing.
 */
export function isAcceptedMediaFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) return true;
  if (file.type !== "" && file.type !== "application/octet-stream") return false;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(extension) || IMAGE_EXTENSIONS.includes(extension);
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
