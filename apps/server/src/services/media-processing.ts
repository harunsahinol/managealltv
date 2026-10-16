/**
 * Media processing ("Processing" in docs/API.md): turns an uploaded original into the file the TVs
 * play plus a panel thumbnail, then stores SHA-256, size, duration and dimensions.
 *
 * - Images (sharp): EXIF auto-rotate, fit inside 1920×1080 without enlarging, JPEG q85, no metadata.
 * - Videos (ffmpeg): an already compatible H.264 stream is copied and only the audio is re-encoded
 *   (AAC-LC 48 kHz stereo, loudnorm); anything else is fully transcoded to the target profile.
 *
 * Runs as the pg-boss job "media.process", one job at a time (ffmpeg uses every core anyway).
 */
import type { MediaType } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { prisma } from "../db";
import { env } from "../env";
import { JOB_NAMES, jobQueue, registerJob, sendJob } from "../jobs";
import { ProcessError, runProcess } from "../lib/process-runner";
import {
  mediaFilePath,
  processingTempPath,
  removeMediaFiles,
  removeUploadFiles,
  thumbnailPath,
  uploadPath,
  uploadsDir,
} from "../lib/storage";
import { logger } from "../logger";
import { refreshManifestsForMedia } from "./manifest";
import { maxKeyframeGapSec, type ProbeResult, probeMedia, type Rational, rationalValue, type VideoStreamInfo } from "./media-probe";

// ------------------------------------------------------------------ target profile

export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const MAX_FPS = 30;
export const KEYFRAME_INTERVAL_SEC = 2;
export const IMAGE_JPEG_QUALITY = 85;
export const THUMBNAIL_WIDTH = 480;
export const LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11";

/** H.264 profiles every supported TV decodes in hardware (High ≤ level 4.1 is the target). */
const COPY_PROFILES = new Set(["Constrained Baseline", "Baseline", "Main", "High"]);
/** Level 4.1 as ffprobe reports it (level × 10). */
const COPY_MAX_LEVEL = 41;
/** Average video bit rate a copied stream may have: the transcode caps at 8 Mbit/s, plus a little slack. */
const COPY_MAX_VIDEO_BITRATE = 8_500_000;
/** Keyframes every 2 s is the target; allow some jitter before re-encoding a stream for it. */
const COPY_MAX_KEYFRAME_GAP_SEC = 2.5;

/** Job settings: a long 4K transcode on a small CPU-only server can take hours. */
export const MEDIA_JOB_EXPIRE_SECONDS = 4 * 60 * 60;
const MEDIA_JOB_RETRY_LIMIT = 2;
/** Media still "processing" after this long lost its job for good (e.g. it kept timing out). */
export const STUCK_PROCESSING_MS = 24 * 60 * 60 * 1000;
/** Uploads nobody finished (or whose media row vanished) are deleted after this long. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ errors

/** A processing failure whose `userMessage` (Turkish) is stored on the media and shown in the panel. */
export class MediaProcessingError extends Error {
  constructor(
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "MediaProcessingError";
  }
}

const MESSAGES = {
  uploadMissing: "Yüklenen dosya sunucuda bulunamadı. Lütfen dosyayı yeniden yükleyin.",
  imageUnreadable: "Resim okunamadı. Dosya bozuk ya da desteklenmeyen bir biçimde olabilir (JPEG, PNG veya WebP yükleyin).",
  videoUnreadable: "Video okunamadı. Dosya bozuk ya da desteklenmeyen bir biçimde olabilir.",
  noVideoStream: "Dosyada oynatılabilir bir görüntü akışı bulunamadı.",
  tooShort: "Videonun süresi okunamadı ya da video çok kısa.",
  convertFailed: "Video dönüştürülemedi. Dosya bozuk ya da desteklenmeyen bir biçimde olabilir.",
  unexpected: "Dosya işlenirken beklenmeyen bir hata oluştu.",
  stuck: "İşlem zamanında tamamlanamadı. Lütfen dosyayı yeniden yükleyin.",
} as const;

// ------------------------------------------------------------------ results

export interface ProcessedOutput {
  mimeType: string;
  width: number;
  height: number;
  durationMs: number | null;
  /** Videos only: true when the H.264 stream was copied instead of re-encoded. */
  videoCopied: boolean;
}

interface WorkFiles {
  file: string;
  thumbnail: string;
}

// ------------------------------------------------------------------ images

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether the file starts like JPEG, PNG or WebP. sharp picks its decoder from the content, not from
 * the declared tus filetype, so without this an "image/png" upload could be decoded as SVG (librsvg's
 * XInclude reads other files in the uploads directory into the picture), GIF, TIFF, HEIF and so on.
 */
async function isAcceptedImageFile(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    const head = buffer.subarray(0, bytesRead);
    const jpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE);
    const webp = head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
    return jpeg || png || webp;
  } finally {
    await handle.close();
  }
}

export async function processImage(source: string, out: WorkFiles): Promise<ProcessedOutput> {
  if (!(await isAcceptedImageFile(source))) throw new MediaProcessingError(MESSAGES.imageUnreadable);
  let info: { width: number; height: number };
  try {
    // failOn "error": accept files with harmless warnings (e.g. a few missing bytes) that viewers show anyway.
    info = await sharp(source, { failOn: "error" })
      .autoOrient()
      .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      // JPEG has no alpha; transparent areas of PNG/WebP logos become white, as on a printed page.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: IMAGE_JPEG_QUALITY })
      .toFile(out.file);
  } catch (error) {
    throw new MediaProcessingError(MESSAGES.imageUnreadable, { cause: error });
  }
  await sharp(out.file).resize({ width: THUMBNAIL_WIDTH }).jpeg({ quality: 80 }).toFile(out.thumbnail);
  return { mimeType: "image/jpeg", width: info.width, height: info.height, durationMs: null, videoCopied: false };
}

// ------------------------------------------------------------------ videos

function videoBitRate(probe: ProbeResult, video: VideoStreamInfo, fileSize: number): number | null {
  if (video.bitRate !== null) return video.bitRate;
  // MKV/WebM rarely state a per-stream rate: take the container's minus the audio's.
  const total = probe.bitRate ?? (probe.durationSec ? (fileSize * 8) / probe.durationSec : null);
  if (total === null) return null;
  return Math.max(0, total - (probe.audio?.bitRate ?? 0));
}

/**
 * Whether the video stream already matches the target profile and can be copied bit for bit:
 * H.264 (Constrained) Baseline/Main/High ≤ 4.1, 8-bit 4:2:0, ≤ 1920×1080 landscape box, square
 * pixels, no rotation flag, progressive, ≤ 30 fps, ≤ ~8 Mbit/s, a keyframe at least every ~2 s.
 */
export async function canCopyVideo(source: string, probe: ProbeResult, signal?: AbortSignal): Promise<boolean> {
  const video = probe.video;
  if (video === null || video.codec !== "h264") return false;
  if (video.profile === null || !COPY_PROFILES.has(video.profile)) return false;
  if (video.level === null || video.level > COPY_MAX_LEVEL) return false;
  if (video.pixFmt !== "yuv420p") return false;
  if (video.width > MAX_WIDTH || video.height > MAX_HEIGHT) return false;
  if (video.rotation !== 0 || video.sampleAspect !== null || video.interlaced) return false;
  if (video.frameRate === null || rationalValue(video.frameRate) > MAX_FPS + 1e-6) return false;
  const { size } = await stat(source);
  const bitRate = videoBitRate(probe, video, size);
  if (bitRate === null || bitRate > COPY_MAX_VIDEO_BITRATE) return false;
  const gap = await maxKeyframeGapSec(source, video.index, signal);
  return gap !== null && gap <= COPY_MAX_KEYFRAME_GAP_SEC;
}

/**
 * Output frame rate for a source above 30 fps: halve while that keeps a watchable rate (60 → 30,
 * 50 → 25, 59.94 → 29.97; dropping every other frame stays smooth), otherwise fall back to 30.
 * Null when the source is already ≤ 30 fps.
 */
export function targetFrameRate(source: Rational | null): Rational | null {
  if (source === null || rationalValue(source) <= MAX_FPS + 1e-6) return null;
  let rate = source;
  while (rationalValue(rate) > MAX_FPS + 1e-6) {
    const half = { num: rate.num, den: rate.den * 2 };
    rate = rationalValue(half) >= 23.9 ? half : { num: MAX_FPS, den: 1 };
  }
  return rate;
}

const ratio = (r: Rational): string => `${r.num}/${r.den}`;

function audioArgs(probe: ProbeResult): string[] {
  if (probe.audio === null) return ["-an"];
  return [
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    // Downmix/upmix to stereo first so loudnorm measures what is played; loudnorm works at 192 kHz
    // internally, hence the final resample back to 48 kHz.
    "-af",
    `aformat=channel_layouts=stereo,${LOUDNORM_FILTER},aresample=48000`,
  ];
}

const COMMON_OUTPUT_ARGS = ["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4"];

function streamMaps(probe: ProbeResult, video: VideoStreamInfo): string[] {
  const maps = ["-map", `0:${video.index}`];
  if (probe.audio !== null) maps.push("-map", `0:${probe.audio.index}`);
  return maps;
}

/** ffmpeg arguments for copying the video stream and re-encoding only the audio. */
export function remuxArgs(source: string, output: string, probe: ProbeResult, video: VideoStreamInfo): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    ...streamMaps(probe, video),
    "-c:v",
    "copy",
    ...audioArgs(probe),
    ...COMMON_OUTPUT_ARGS,
    output,
  ];
}

/** ffmpeg arguments for the full transcode to the target profile. */
export function transcodeArgs(source: string, output: string, probe: ProbeResult, video: VideoStreamInfo): string[] {
  const filters: string[] = [];
  // Rotation flags are applied by ffmpeg's autorotate before these filters, so iw/ih are upright.
  if (video.interlaced) filters.push("yadif=mode=send_frame:deint=interlaced");
  // Non-square pixels (e.g. anamorphic DV): stretch to square pixels first so the box fit is right.
  if (video.sampleAspect !== null) filters.push("scale=w=iw*sar:h=ih", "setsar=1");
  const fps = targetFrameRate(video.frameRate);
  if (fps !== null) filters.push(`fps=${ratio(fps)}`);
  filters.push(
    `scale=w='min(${MAX_WIDTH},iw)':h='min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "setsar=1",
    "format=yuv420p",
  );

  const outputRate = fps ?? video.frameRate;
  const gop = outputRate === null ? null : Math.max(1, Math.round(rationalValue(outputRate) * KEYFRAME_INTERVAL_SEC));
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    ...streamMaps(probe, video),
    "-vf",
    filters.join(","),
    // Safety net for variable frame rate sources whose average rate looked fine.
    "-fpsmax",
    String(MAX_FPS),
    "-c:v",
    "libx264",
    "-preset",
    "faster",
    "-crf",
    "22",
    "-maxrate",
    "8M",
    "-bufsize",
    "16M",
    "-profile:v",
    "high",
    "-level:v",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    ...(gop === null ? [] : ["-g", String(gop)]),
    "-force_key_frames",
    `expr:gte(t,n_forced*${KEYFRAME_INTERVAL_SEC})`,
    ...audioArgs(probe),
    ...COMMON_OUTPUT_ARGS,
    output,
  ];
}

async function nonEmptyFile(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return info !== null && info.isFile() && info.size > 0;
}

/** 480 px wide JPEG from a frame a little into the video (first frames are often black fades). */
async function videoThumbnail(video: string, thumbnail: string, durationSec: number, signal?: AbortSignal): Promise<void> {
  const attempt = (seekSec: number) =>
    runProcess(
      env.FFMPEG_PATH,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        seekSec.toFixed(3),
        "-i",
        video,
        "-frames:v",
        "1",
        "-vf",
        `scale=${THUMBNAIL_WIDTH}:-2`,
        "-q:v",
        "3",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "-update",
        "1",
        thumbnail,
      ],
      { signal },
    );
  await attempt(Math.min(3, durationSec * 0.25));
  // Seeking can land past the last decodable frame of very short clips; the first frame always works.
  if (!(await nonEmptyFile(thumbnail))) await attempt(0);
  if (!(await nonEmptyFile(thumbnail))) throw new Error("ffmpeg produced no thumbnail");
}

function describeProcessError(error: unknown): Record<string, unknown> {
  return error instanceof ProcessError ? { error, stderr: error.stderrTail } : { error };
}

export async function processVideo(source: string, out: WorkFiles, signal?: AbortSignal): Promise<ProcessedOutput> {
  let probe: ProbeResult;
  try {
    probe = await probeMedia(source, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MediaProcessingError(MESSAGES.videoUnreadable, { cause: error });
  }
  const video = probe.video;
  if (video === null) throw new MediaProcessingError(MESSAGES.noVideoStream);
  if (probe.durationSec === null || probe.durationSec < 0.1) throw new MediaProcessingError(MESSAGES.tooShort);

  const copy = await canCopyVideo(source, probe, signal);
  const args = copy ? remuxArgs(source, out.file, probe, video) : transcodeArgs(source, out.file, probe, video);
  try {
    await runProcess(env.FFMPEG_PATH, args, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MediaProcessingError(MESSAGES.convertFailed, { cause: error });
  }

  const result = await probeMedia(out.file, signal);
  if (result.video === null || result.durationSec === null) throw new MediaProcessingError(MESSAGES.convertFailed);
  await videoThumbnail(out.file, out.thumbnail, result.durationSec, signal);
  return {
    mimeType: "video/mp4",
    width: result.video.width,
    height: result.video.height,
    durationMs: Math.max(1, Math.round(result.durationSec * 1000)),
    videoCopied: copy,
  };
}

// ------------------------------------------------------------------ the job

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  const { size } = await stat(file);
  return { sha256: hash.digest("hex"), size };
}

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null)) !== null;
}

async function markFailed(mediaId: string, uploadId: string | null, message: string): Promise<void> {
  // Only a row that is still processing: a deleted or meanwhile finished media stays as it is.
  const updated = await prisma.media.updateMany({
    where: { id: mediaId, status: "processing" },
    data: { status: "failed", error: message, uploadId: null },
  });
  if (uploadId !== null) await removeUploadFiles(uploadId);
  if (updated.count > 0) await refreshManifestsForMedia([mediaId]);
}

function convert(type: MediaType, source: string, out: WorkFiles, signal?: AbortSignal): Promise<ProcessedOutput> {
  return type === "image" ? processImage(source, out) : processVideo(source, out, signal);
}

export interface ProcessMediaOptions {
  /** pg-boss job signal: aborted on job expiry or shutdown, which kills a running ffmpeg. */
  signal?: AbortSignal;
}

export type ProcessMediaOutcome = "ready" | "failed" | "skipped";

/**
 * Processes one media item. Idempotent: anything not in "processing" is skipped, so duplicate or
 * retried jobs are harmless. Conversion problems end in status "failed" with a Turkish message;
 * an abort (shutdown, expiry) rethrows and leaves the media "processing" for the retry; database
 * errors rethrow too, so pg-boss retries them.
 */
export async function processMedia(mediaId: string, options: ProcessMediaOptions = {}): Promise<ProcessMediaOutcome> {
  const { signal } = options;
  const media = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!media || media.status !== "processing") return "skipped";

  const uploadId = media.uploadId;
  if (uploadId === null || !(await exists(uploadPath(uploadId)))) {
    logger.warn("Media upload missing", { mediaId, uploadId });
    await markFailed(mediaId, uploadId, MESSAGES.uploadMissing);
    return "failed";
  }
  const source = uploadPath(uploadId);

  const tag = randomBytes(4).toString("hex");
  const work: WorkFiles = { file: processingTempPath(mediaId, `${tag}-file`), thumbnail: processingTempPath(mediaId, `${tag}-thumb`) };
  const cleanWork = () => Promise.all([rm(work.file, { force: true }), rm(work.thumbnail, { force: true })]);
  const startedAt = Date.now();

  let output: ProcessedOutput;
  try {
    output = await convert(media.type, source, work, signal);
  } catch (error) {
    await cleanWork();
    if (signal?.aborted) throw error;
    const message = error instanceof MediaProcessingError ? error.userMessage : MESSAGES.unexpected;
    logger.warn("Media processing failed", {
      mediaId,
      type: media.type,
      ...describeProcessError(error instanceof MediaProcessingError && error.cause !== undefined ? error.cause : error),
    });
    await markFailed(mediaId, uploadId, message);
    return "failed";
  }

  try {
    const { sha256, size } = await hashFile(work.file);
    await rename(work.file, mediaFilePath(mediaId, output.mimeType));
    await rename(work.thumbnail, thumbnailPath(mediaId));
    const updated = await prisma.media.updateMany({
      where: { id: mediaId, status: "processing" },
      data: {
        status: "ready",
        error: null,
        mimeType: output.mimeType,
        size: BigInt(size),
        sha256,
        durationMs: output.durationMs,
        width: output.width,
        height: output.height,
        uploadId: null,
      },
    });
    await removeUploadFiles(uploadId);
    if (updated.count === 0) {
      // Deleted (or otherwise settled) while we were working: nothing may reference these files.
      await removeMediaFiles(mediaId, output.mimeType);
      return "skipped";
    }
    logger.info("Media ready", {
      mediaId,
      type: media.type,
      videoCopied: output.videoCopied,
      size,
      width: output.width,
      height: output.height,
      durationMs: output.durationMs,
      ms: Date.now() - startedAt,
    });
  } finally {
    await cleanWork();
  }
  await refreshManifestsForMedia([mediaId]);
  return "ready";
}

// ------------------------------------------------------------------ queueing

registerJob<{ mediaId: string }>({
  name: JOB_NAMES.mediaProcess,
  handler: async ({ mediaId }, job) => {
    await processMedia(mediaId, { signal: job.signal });
  },
  concurrency: 1,
  queue: {
    // One queued-or-active job per media (singletonKey = media id), so re-queueing is always safe.
    policy: "exclusive",
    expireInSeconds: MEDIA_JOB_EXPIRE_SECONDS,
    retryLimit: MEDIA_JOB_RETRY_LIMIT,
    retryDelay: 30,
    // A crashed server's job is retried after a minute of silence instead of after the full expiry.
    heartbeatSeconds: 60,
  },
});

/**
 * Queues processing of a media item. Returns false (and leaves the media "processing") when the job
 * queue is not running yet; requeueProcessingMedia() at start-up and in maintenance picks it up.
 */
export async function enqueueMediaProcessing(mediaId: string): Promise<boolean> {
  if (jobQueue() === null) {
    logger.warn("Job queue not running; media will be queued later", { mediaId });
    return false;
  }
  try {
    await sendJob(JOB_NAMES.mediaProcess, { mediaId }, { singletonKey: mediaId });
    return true;
  } catch (error) {
    logger.error("Could not queue media processing", { mediaId, error });
    return false;
  }
}

/** Makes sure every "processing" media has a job (duplicates are suppressed by the singleton key). */
export async function requeueProcessingMedia(): Promise<number> {
  if (jobQueue() === null) return 0;
  const rows = await prisma.media.findMany({ where: { status: "processing" }, select: { id: true }, orderBy: { createdAt: "asc" } });
  let queued = 0;
  for (const row of rows) if (await enqueueMediaProcessing(row.id)) queued += 1;
  return queued;
}

/** Media whose processing never finished (its job kept expiring) is marked failed after a day. */
export async function failStuckMedia(now = new Date()): Promise<number> {
  const stuck = await prisma.media.findMany({
    where: { status: "processing", createdAt: { lt: new Date(now.getTime() - STUCK_PROCESSING_MS) } },
    select: { id: true, uploadId: true },
  });
  for (const media of stuck) {
    logger.warn("Media stuck in processing; marking failed", { mediaId: media.id });
    await markFailed(media.id, media.uploadId, MESSAGES.stuck);
  }
  return stuck.length;
}

/**
 * Deletes uploads that will never be processed: unfinished/abandoned ones and leftovers whose media
 * is gone or already settled. Uploads of media still waiting for processing are kept.
 */
export async function cleanupStaleUploads(now = new Date()): Promise<number> {
  const names = await readdir(uploadsDir).catch(() => [] as string[]);
  const ids = new Set(names.map((name) => name.replace(/\.json$/, "")).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)));
  let removed = 0;
  for (const id of ids) {
    const info = (await stat(uploadPath(id)).catch(() => null)) ?? (await stat(`${uploadPath(id)}.json`).catch(() => null));
    if (info === null || now.getTime() - info.mtimeMs < STALE_UPLOAD_MS) continue;
    const media = await prisma.media.findUnique({ where: { uploadId: id }, select: { id: true, status: true } });
    if (media?.status === "processing") continue;
    if (media) await prisma.media.update({ where: { id: media.id }, data: { uploadId: null } });
    await removeUploadFiles(id);
    removed += 1;
  }
  return removed;
}
