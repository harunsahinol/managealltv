import type { api } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { notFound } from "../lib/errors";

export const mediaInclude = { uploadedBy: { select: { name: true } } } as const;
export type MediaRow = Prisma.MediaGetPayload<{ include: typeof mediaInclude }>;

/** Media list order: newest first (docs/API.md), id as a stable tie-breaker. */
export const MEDIA_ORDER: Prisma.MediaOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

/** Number of distinct playlists containing each media (a playlist may list the same media twice). */
export async function playlistCounts(mediaIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (mediaIds.length === 0) return counts;
  const pairs = await prisma.playlistItem.groupBy({
    by: ["mediaId", "playlistId"],
    where: { mediaId: { in: [...new Set(mediaIds)] } },
  });
  for (const pair of pairs) counts.set(pair.mediaId, (counts.get(pair.mediaId) ?? 0) + 1);
  return counts;
}

export function toMediaView(row: MediaRow, playlistCount: number): api.Media {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    error: row.error,
    size: row.size === null ? null : Number(row.size),
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    playlistCount,
    uploadedByName: row.uploadedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function toMediaViews(rows: readonly MediaRow[]): Promise<api.Media[]> {
  const counts = await playlistCounts(rows.map((row) => row.id));
  return rows.map((row) => toMediaView(row, counts.get(row.id) ?? 0));
}

export async function findMediaOrThrow(id: string): Promise<MediaRow> {
  const media = await prisma.media.findUnique({ where: { id }, include: mediaInclude });
  if (!media) throw notFound("Medya bulunamadı");
  return media;
}

/** Display name derived from an uploaded file name: no directories, no extension, at most 200 chars. */
export function displayNameFromFileName(fileName: string): string {
  const base = baseFileName(fileName);
  const withoutExtension = base.replace(/\.[^.]{1,10}$/, "").trim();
  const name = (withoutExtension.length > 0 ? withoutExtension : base).slice(0, 200).trim();
  return name.length > 0 ? name : "Adsız medya";
}

/** Last path segment (browsers send bare names, but some clients include a path). */
export function baseFileName(fileName: string): string {
  const parts = fileName.split(/[/\\]/);
  return (parts[parts.length - 1] ?? "").trim().slice(0, 255);
}

// ------------------------------------------------------------------ accepted upload types

/** Upload MIME types the processing step can handle, with the media type they become. */
export const ACCEPTED_UPLOAD_TYPES: Readonly<Record<string, api.Media["type"]>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/x-matroska": "video",
  "video/webm": "video",
};

/** Non-canonical names some browsers/OSes use for the same formats. */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "video/x-m4v": "video/mp4",
  "video/mkv": "video/x-matroska",
  "application/x-matroska": "video/x-matroska",
};

const MIME_BY_UPLOAD_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

export interface UploadType {
  mimeType: string;
  mediaType: api.Media["type"];
}

/**
 * Resolves the declared tus `filetype` (falling back to the file extension when the browser sent
 * none or a generic one) to an accepted type, or null when the upload must be refused.
 */
export function resolveUploadType(filetype: string | null | undefined, fileName: string): UploadType | null {
  const declared = (filetype ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  let mimeType: string | undefined;
  if (declared !== "" && declared !== "application/octet-stream") {
    mimeType = MIME_ALIASES[declared] ?? declared;
  } else {
    const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
    mimeType = extension === undefined ? undefined : MIME_BY_UPLOAD_EXTENSION[extension];
  }
  if (mimeType === undefined) return null;
  const mediaType = ACCEPTED_UPLOAD_TYPES[mimeType];
  return mediaType === undefined ? null : { mimeType, mediaType };
}
