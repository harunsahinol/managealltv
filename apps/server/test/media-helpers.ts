/**
 * Media test helpers: sample files generated on the fly (ffmpeg lavfi sources, sharp), an
 * independent ffprobe reader for assertions, raw tus 1.0 requests, and ready-made media rows.
 */
import type { Media } from "@prisma/client";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { expect } from "vitest";
import { prisma } from "../src/db";
import { mediaFilePath, thumbnailPath } from "../src/lib/storage";
import type { Client } from "./helpers";

const run = promisify(execFile);

export const FIXTURE_DIR = path.join(os.tmpdir(), "managealltv-test-fixtures");

export const TUS_HEADERS = { "tus-resumable": "1.0.0" } as const;

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ sample files

export interface VideoSpec {
  name: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** Mono sine tone at this sample rate; omit for a silent (no audio stream) video. */
  audioSampleRate?: number;
  /** Extra encoder arguments, e.g. to produce an already compatible stream. */
  encoder?: string[];
}

/** Generates (once per run) a small test video from ffmpeg's lavfi test sources. */
export async function makeVideo(spec: VideoSpec): Promise<string> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, spec.name);
  const inputs = ["-f", "lavfi", "-i", `testsrc2=size=${spec.width}x${spec.height}:rate=${spec.fps}`];
  if (spec.audioSampleRate !== undefined) inputs.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${spec.audioSampleRate}`);
  const encoder = spec.encoder ?? ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const audio = spec.audioSampleRate === undefined ? [] : ["-c:a", "aac", "-ac", "1"];
  await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...inputs, "-t", String(spec.seconds), ...encoder, ...audio, file]);
  return file;
}

/** A JPEG whose pixels are landscape but whose EXIF says "rotate 90° clockwise" (orientation 6). */
export async function makeRotatedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

export async function makePng(width = 640, height = 360): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 0.5 } } }).png().toBuffer();
}

// ------------------------------------------------------------------ ffprobe for assertions

export interface ProbedStream {
  codec_type: string;
  codec_name: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

export async function ffprobe(file: string): Promise<{ streams: ProbedStream[]; format: { format_name: string; duration: string } }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(stdout) as { streams: ProbedStream[]; format: { format_name: string; duration: string } };
}

export function frameRate(value: string | undefined): number {
  const [num = "0", den = "1"] = (value ?? "0/1").split("/");
  return Number(num) / Number(den);
}

/** MD5 of the first video stream's packets: equal values mean the stream was copied bit for bit. */
export async function videoStreamMd5(file: string): Promise<string> {
  const { stdout } = await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"]);
  return stdout.trim();
}

// ------------------------------------------------------------------ tus

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

export function tusMetadata(entries: Record<string, string | undefined>): string {
  return Object.entries(entries)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key} ${b64(value)}`)
    .join(",");
}

/** POST /api/uploads; returns the response and the upload path (pathname of Location). */
export async function tusCreate(client: Client, size: number, metadata: Record<string, string | undefined>) {
  const res = await client.post("/api/uploads", {
    headers: { ...TUS_HEADERS, "upload-length": String(size), "upload-metadata": tusMetadata(metadata) },
  });
  const location = res.headers.get("location");
  return { res, location, path: location === null ? null : new URL(location).pathname };
}

export function tusPatch(client: Client, uploadPath: string, offset: number, chunk: Uint8Array): Promise<Response> {
  return client.patch(uploadPath, {
    headers: { ...TUS_HEADERS, "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
    body: chunk,
  });
}

/** Uploads a whole file through tus (POST, then PATCH chunks) and returns the created media id. */
export async function tusUpload(
  client: Client,
  data: Uint8Array,
  metadata: { filename: string; filetype?: string },
  chunkSize = 256 * 1024,
): Promise<{ mediaId: string; uploadId: string }> {
  const created = await tusCreate(client, data.length, metadata);
  expect(created.res.status).toBe(201);
  if (created.path === null) throw new Error("no Location");
  let offset = 0;
  let last: Response | null = null;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + chunkSize);
    last = await tusPatch(client, created.path, offset, chunk);
    expect(last.status).toBe(204);
    offset += chunk.length;
    expect(last.headers.get("upload-offset")).toBe(String(offset));
  }
  const mediaId = last?.headers.get("media-id");
  if (!mediaId) throw new Error("final PATCH carried no Media-Id");
  return { mediaId, uploadId: created.path.split("/").pop() ?? "" };
}

export async function uploadFile(client: Client, file: string, filetype?: string) {
  return tusUpload(client, await readFile(file), { filename: path.basename(file), filetype });
}

// ------------------------------------------------------------------ ready media without processing

/** Inserts a ready media row with real bytes on disk (fast path for playlist/schedule tests). */
export async function createReadyMedia(
  name: string,
  options: { type?: "image" | "video"; durationMs?: number | null; uploadedById?: string | null } = {},
): Promise<{ media: Media; bytes: Buffer }> {
  const type = options.type ?? "video";
  const mimeType = type === "video" ? "video/mp4" : "image/jpeg";
  const bytes = randomBytes(2048);
  const media = await prisma.media.create({
    data: {
      name,
      fileName: `${name}.${type === "video" ? "mp4" : "jpg"}`,
      type,
      status: "ready",
      mimeType,
      size: BigInt(bytes.length),
      sha256: sha256(bytes),
      durationMs: type === "video" ? (options.durationMs === undefined ? 5000 : options.durationMs) : null,
      width: 1920,
      height: 1080,
      uploadedById: options.uploadedById ?? null,
    },
  });
  await writeFile(mediaFilePath(media.id, mimeType), bytes);
  await writeFile(thumbnailPath(media.id), bytes.subarray(0, 100));
  return { media, bytes };
}
