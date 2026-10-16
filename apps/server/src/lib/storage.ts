import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

/**
 * Media disk layout under MEDIA_DIR:
 *   uploads/            in-progress / finished tus uploads (originals, deleted after processing)
 *   files/<id>.<ext>    processed media served to devices and the panel
 *   thumbs/<id>.jpg     480 px wide panel thumbnails
 */
export const mediaRoot = path.resolve(env.MEDIA_DIR);
export const uploadsDir = path.join(mediaRoot, "uploads");
export const filesDir = path.join(mediaRoot, "files");
export const thumbsDir = path.join(mediaRoot, "thumbs");

export async function ensureStorageDirs(): Promise<void> {
  await Promise.all([uploadsDir, filesDir, thumbsDir].map((dir) => mkdir(dir, { recursive: true })));
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

/** File extension used under files/ for a processed MIME type (falls back to "bin"). */
export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase().replace(/^\./, "")] ?? "application/octet-stream";
}

// Ids come from the database (cuid) but are also taken from URLs; refuse anything that could escape
// the directory before it ever reaches path.join.
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Unsafe storage id: ${id}`);
}

/** Absolute path of a processed media file: files/<id>.<ext>. */
export function mediaFilePath(id: string, mimeType: string): string {
  assertSafeId(id);
  return path.join(filesDir, `${id}.${extensionForMime(mimeType)}`);
}

/** Absolute path of a media thumbnail: thumbs/<id>.jpg. */
export function thumbnailPath(id: string): string {
  assertSafeId(id);
  return path.join(thumbsDir, `${id}.jpg`);
}

/** Absolute path of an upload (tus file id) inside uploads/. */
export function uploadPath(uploadId: string): string {
  assertSafeId(uploadId);
  return path.join(uploadsDir, uploadId);
}

/** tus keeps each upload's metadata (size, metadata, creation date) next to it as <id>.json. */
export function uploadInfoPath(uploadId: string): string {
  return `${uploadPath(uploadId)}.json`;
}

/** Removes an upload and its tus metadata file; missing files are ignored. */
export async function removeUploadFiles(uploadId: string): Promise<void> {
  await Promise.all([uploadPath(uploadId), uploadInfoPath(uploadId)].map((target) => rm(target, { force: true })));
}

/**
 * Work file next to the final location (same file system, so the final rename is atomic and a
 * half-written file is never served). `tag` keeps the outputs of one processing run apart.
 */
export function processingTempPath(id: string, tag: string): string {
  assertSafeId(id);
  if (!/^[a-z0-9-]{1,32}$/.test(tag)) throw new Error(`Unsafe temp tag: ${tag}`);
  return path.join(filesDir, `.${id}.${tag}.tmp`);
}

/** Removes the processed file and thumbnail of a media item; missing files are ignored. */
export async function removeMediaFiles(id: string, mimeType: string | null): Promise<void> {
  const targets = [thumbnailPath(id)];
  if (mimeType) targets.push(mediaFilePath(id, mimeType));
  await Promise.all(targets.map((target) => rm(target, { force: true })));
}
