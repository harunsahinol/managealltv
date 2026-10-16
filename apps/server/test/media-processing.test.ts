import { api } from "@managealltv/protocol";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { jobQueue, startJobs, stopJobs } from "../src/jobs";
import { mediaFilePath, thumbnailPath, uploadPath } from "../src/lib/storage";
import {
  cleanupStaleUploads,
  enqueueMediaProcessing,
  failStuckMedia,
  processMedia,
  STALE_UPLOAD_MS,
  STUCK_PROCESSING_MS,
  targetFrameRate,
} from "../src/services/media-processing";
import { body, errorBody, login, resetDatabase, waitFor } from "./helpers";
import {
  ffprobe,
  frameRate,
  makePng,
  makeRotatedJpeg,
  makeVideo,
  sha256,
  tusUpload,
  uploadFile,
  videoStreamMd5,
} from "./media-helpers";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

afterAll(async () => {
  await stopJobs();
});

const exists = (file: string) => stat(file).then(
  () => true,
  () => false,
);

async function readyMedia(id: string) {
  const media = await prisma.media.findUniqueOrThrow({ where: { id } });
  expect(media.status).toBe("ready");
  expect(media.error).toBeNull();
  expect(media.uploadId).toBeNull();
  if (media.mimeType === null || media.sha256 === null || media.size === null) throw new Error("incomplete media");
  const file = mediaFilePath(media.id, media.mimeType);
  const bytes = await readFile(file);
  // Stored hash and size describe exactly the file that devices download.
  expect(media.sha256).toBe(sha256(bytes));
  expect(Number(media.size)).toBe(bytes.length);
  const thumbnail = await sharp(thumbnailPath(media.id)).metadata();
  expect(thumbnail.format).toBe("jpeg");
  expect(thumbnail.width).toBe(480);
  return { media, file };
}

describe("video processing", () => {
  it("transcodes a 60 fps video to H.264 High ≤ 30 fps with normalised AAC stereo", async () => {
    const source = await makeVideo({ name: "fast-60fps.mp4", width: 1280, height: 720, fps: 60, seconds: 3, audioSampleRate: 44_100 });
    const { client } = await login(app, "editor");
    const { mediaId, uploadId } = await uploadFile(client, source, "video/mp4");

    expect(await processMedia(mediaId)).toBe("ready");
    const { media, file } = await readyMedia(mediaId);
    expect(await exists(uploadPath(uploadId))).toBe(false);
    expect(media).toMatchObject({ type: "video", mimeType: "video/mp4", width: 1280, height: 720 });
    expect(media.durationMs).toBeGreaterThanOrEqual(2900);
    expect(media.durationMs).toBeLessThanOrEqual(3300);

    const probe = await ffprobe(file);
    expect(probe.format.format_name).toContain("mp4");
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: 1280, height: 720 });
    expect(video?.level).toBeLessThanOrEqual(41);
    expect(frameRate(video?.avg_frame_rate)).toBeLessThanOrEqual(30);
    expect(frameRate(video?.r_frame_rate)).toBe(30);
    expect(audio).toMatchObject({ codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 });
    // The re-encoded stream differs from the source.
    expect(await videoStreamMd5(file)).not.toBe(await videoStreamMd5(source));
  });

  it("copies an already compatible H.264 stream and only re-encodes the audio", async () => {
    const source = await makeVideo({
      name: "compatible.mp4",
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      audioSampleRate: 44_100,
      encoder: ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-g", "60", "-b:v", "2M"],
    });
    const { client } = await login(app, "admin");
    const { mediaId } = await uploadFile(client, source, "video/mp4");

    expect(await processMedia(mediaId)).toBe("ready");
    const { media, file } = await readyMedia(mediaId);
    expect(media).toMatchObject({ width: 1280, height: 720 });
    expect(await videoStreamMd5(file)).toBe(await videoStreamMd5(source));
    const audio = (await ffprobe(file)).streams.find((s) => s.codec_type === "audio");
    // Mono 44.1 kHz in, stereo 48 kHz out: the audio went through the encoder (and loudnorm).
    expect(audio).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
  });

  it("fits a portrait video without audio into 1920×1080 with even dimensions", async () => {
    const source = await makeVideo({ name: "portrait.mkv", width: 720, height: 1280, fps: 25, seconds: 1 });
    const { client } = await login(app, "editor");
    const { mediaId } = await uploadFile(client, source);

    expect(await processMedia(mediaId)).toBe("ready");
    const { media, file } = await readyMedia(mediaId);
    // 720×1280 scaled into the 1080 px tall box: 607.5 → 608 (even) × 1080.
    expect(media).toMatchObject({ width: 608, height: 1080 });
    const streams = (await ffprobe(file)).streams;
    expect(streams.map((s) => s.codec_type)).toEqual(["video"]);
    expect(streams[0]).toMatchObject({ codec_name: "h264", profile: "High", width: 608, height: 1080 });
    expect(frameRate(streams[0]?.r_frame_rate)).toBe(25);
  });

  it("picks clean output frame rates", () => {
    expect(targetFrameRate({ num: 30, den: 1 })).toBeNull();
    expect(targetFrameRate({ num: 30000, den: 1001 })).toBeNull();
    expect(targetFrameRate({ num: 60, den: 1 })).toEqual({ num: 60, den: 2 });
    expect(targetFrameRate({ num: 50, den: 1 })).toEqual({ num: 50, den: 2 });
    expect(targetFrameRate({ num: 60000, den: 1001 })).toEqual({ num: 60000, den: 2002 });
    expect(targetFrameRate({ num: 120, den: 1 })).toEqual({ num: 120, den: 4 });
    expect(targetFrameRate({ num: 40, den: 1 })).toEqual({ num: 30, den: 1 });
    expect(targetFrameRate(null)).toBeNull();
  });
});

describe("image processing", () => {
  it("auto-rotates by EXIF, fits inside 1920×1080, writes a metadata-free JPEG", async () => {
    const { client } = await login(app, "editor");
    const jpeg = await makeRotatedJpeg();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const { mediaId } = await tusUpload(client, jpeg, { filename: "afiş.jpg", filetype: "image/jpeg" });

    expect(await processMedia(mediaId)).toBe("ready");
    const { media, file } = await readyMedia(mediaId);
    // 3000×2000 shown rotated is 2000×3000; inside 1920×1080 that is 720×1080.
    expect(media).toMatchObject({ type: "image", mimeType: "image/jpeg", width: 720, height: 1080, durationMs: null });
    const output = await sharp(file).metadata();
    expect(output).toMatchObject({ format: "jpeg", width: 720, height: 1080 });
    expect(output.orientation).toBeUndefined();
    expect(output.exif).toBeUndefined();
  });

  it("never enlarges small images and flattens transparency", async () => {
    const { client } = await login(app, "editor");
    const { mediaId } = await tusUpload(client, await makePng(640, 360), { filename: "logo.png", filetype: "image/png" });
    expect(await processMedia(mediaId)).toBe("ready");
    const { media, file } = await readyMedia(mediaId);
    expect(media).toMatchObject({ width: 640, height: 360, mimeType: "image/jpeg" });
    expect((await sharp(file).metadata()).hasAlpha).toBe(false);
  });

  it("marks unreadable images failed with a Turkish message", async () => {
    const { client } = await login(app, "editor");
    const { mediaId, uploadId } = await tusUpload(client, Buffer.from("bu bir resim değil"), { filename: "bozuk.png", filetype: "image/png" });
    expect(await processMedia(mediaId)).toBe("failed");
    const media = api.Media.parse(await body(await client.get(`/api/media/${mediaId}`)));
    expect(media.status).toBe("failed");
    expect(media.error).toContain("Resim okunamadı");
    expect(await exists(uploadPath(uploadId))).toBe(false);
    // Processing a settled media again does nothing.
    expect(await processMedia(mediaId)).toBe("skipped");
  });
});

describe("media files in the panel", () => {
  it("serves the processed file with Range and the thumbnail once ready", async () => {
    const { client } = await login(app, "viewer");
    const { client: editor } = await login(app, "editor");
    const { mediaId } = await tusUpload(editor, await makePng(800, 600), { filename: "Duyuru.png", filetype: "image/png" });

    const early = await client.get(`/api/media/${mediaId}/thumbnail`);
    expect(early.status).toBe(404);
    expect((await errorBody(early)).error.code).toBe("not_found");
    expect((await client.get(`/api/media/${mediaId}/file`)).status).toBe(404);

    await processMedia(mediaId);
    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
    const bytes = await readFile(mediaFilePath(mediaId, "image/jpeg"));

    const thumbnail = await client.get(`/api/media/${mediaId}/thumbnail`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    expect(thumbnail.headers.get("cache-control")).toBe("private, max-age=86400");

    const full = await client.get(`/api/media/${mediaId}/file`);
    expect(full.status).toBe(200);
    expect(full.headers.get("etag")).toBe(`"${media.sha256}"`);
    expect(full.headers.get("content-disposition")).toContain("Duyuru.jpg");
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await client.get(`/api/media/${mediaId}/file`, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(0, 100))).toBe(true);

    const view = api.Media.parse(await body(await client.get(`/api/media/${mediaId}`)));
    expect(view).toMatchObject({ status: "ready", size: bytes.length, width: 800, height: 600, durationMs: null });
  });
});

describe("processing through the job queue", () => {
  it("processes an upload with the pg-boss worker and never queues a media twice", async () => {
    await startJobs();
    expect(jobQueue()).not.toBeNull();
    const { client } = await login(app, "editor");
    const { mediaId } = await tusUpload(client, await makePng(320, 240), { filename: "kuyruk.png", filetype: "image/png" });

    const ready = await waitFor(async () => {
      const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
      return media.status === "processing" ? null : media;
    }, 30_000);
    expect(ready.status).toBe("ready");
    await stopJobs();
  }, 60_000);

  it("leaves media processing when the queue is not running", async () => {
    expect(jobQueue()).toBeNull();
    const { client } = await login(app, "editor");
    const { mediaId } = await tusUpload(client, await makePng(), { filename: "sonra.png" });
    expect(await enqueueMediaProcessing(mediaId)).toBe(false);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).status).toBe("processing");
  });
});

describe("media housekeeping", () => {
  it("removes abandoned uploads and fails media stuck in processing", async () => {
    const { client } = await login(app, "editor");
    const { mediaId, uploadId } = await tusUpload(client, await makePng(), { filename: "takili.png" });
    // An upload nobody finished, last touched two days ago.
    const abandoned = "a".repeat(32);
    await writeFile(uploadPath(abandoned), "yarım");
    await writeFile(`${uploadPath(abandoned)}.json`, "{}");
    const old = new Date(Date.now() - 2 * STALE_UPLOAD_MS);
    await utimes(uploadPath(abandoned), old, old);
    await utimes(uploadPath(uploadId), old, old);

    expect(await cleanupStaleUploads()).toBe(1);
    expect(await exists(uploadPath(abandoned))).toBe(false);
    // Still waiting for processing: kept, however old.
    expect(await exists(uploadPath(uploadId))).toBe(true);

    expect(await failStuckMedia()).toBe(0);
    await prisma.media.update({ where: { id: mediaId }, data: { createdAt: new Date(Date.now() - STUCK_PROCESSING_MS - 1000) } });
    expect(await failStuckMedia()).toBe(1);
    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
    expect(media).toMatchObject({ status: "failed", uploadId: null });
    expect(media.error).toContain("zamanında tamamlanamadı");
    expect(await exists(uploadPath(uploadId))).toBe(false);
  });
});
