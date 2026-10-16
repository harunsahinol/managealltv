import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { parseRange } from "../src/lib/file-sender";
import { mediaFilePath } from "../src/lib/storage";
import { createDevice, createLocation, deviceRequest, errorBody, resetDatabase } from "./helpers";

const { app } = createApp({ rateLimit: false });

const content = randomBytes(10_000);
const sha256 = createHash("sha256").update(content).digest("hex");

let token: string;
let mediaId: string;

beforeEach(async () => {
  await resetDatabase();
  const media = await prisma.media.create({
    data: {
      name: "Tanıtım",
      fileName: "tanitim.mov",
      type: "video",
      status: "ready",
      mimeType: "video/mp4",
      size: BigInt(content.length),
      sha256,
      durationMs: 4000,
    },
  });
  mediaId = media.id;
  await writeFile(mediaFilePath(media.id, "video/mp4"), content);
  const playlist = await prisma.playlist.create({
    data: { name: "Genel", items: { create: [{ mediaId: media.id, position: 0 }] } },
  });
  const location = await createLocation();
  token = (await createDevice(location.id, { defaultPlaylistId: playlist.id })).token;
});

const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("GET /api/device/v1/media/:mediaId", () => {
  it("sends the whole file with validators", async () => {
    const res = await deviceRequest(app, token, `/media/${mediaId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(content.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(`"${sha256}"`);
    expect((await bytes(res)).equals(content)).toBe(true);
  });

  it("answers Range requests with 206 and the exact bytes", async () => {
    const middle = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: "bytes=100-1099" } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe(`bytes 100-1099/${content.length}`);
    expect(middle.headers.get("content-length")).toBe("1000");
    expect((await bytes(middle)).equals(content.subarray(100, 1100))).toBe(true);

    // Resume from an offset to the end (what a player does after a dropped connection).
    const tail = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: "bytes=9000-" } });
    expect(tail.status).toBe(206);
    expect((await bytes(tail)).equals(content.subarray(9000))).toBe(true);

    const suffix = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${content.length - 10}-${content.length - 1}/${content.length}`);
    expect((await bytes(suffix)).equals(content.subarray(content.length - 10))).toBe(true);

    const beyond = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: `bytes=${content.length}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${content.length}`);

    // If-Range with a stale validator → the full file instead of a partial one.
    const stale = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: "bytes=0-9", "if-range": '"old"' } });
    expect(stale.status).toBe(200);
    expect((await bytes(stale)).length).toBe(content.length);

    const fresh = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { range: "bytes=0-9", "if-range": `"${sha256}"` } });
    expect(fresh.status).toBe(206);

    const notModified = await deviceRequest(app, token, `/media/${mediaId}`, { headers: { "if-none-match": `"${sha256}"` } });
    expect(notModified.status).toBe(304);

    const head = await deviceRequest(app, token, `/media/${mediaId}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(content.length));
  });

  it("only serves media of the device's own manifest", async () => {
    const other = await prisma.media.create({
      data: { name: "Başka", fileName: "b.mp4", type: "video", status: "ready", mimeType: "video/mp4", size: 10n, sha256 },
    });
    await writeFile(mediaFilePath(other.id, "video/mp4"), content.subarray(0, 10));
    const res = await deviceRequest(app, token, `/media/${other.id}`);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).error.code).toBe("not_found");

    // Media that is no longer ready drops out of the manifest and cannot be downloaded.
    await prisma.media.update({ where: { id: mediaId }, data: { status: "processing" } });
    expect((await deviceRequest(app, token, `/media/${mediaId}`)).status).toBe(404);

    expect((await app.request(`/api/device/v1/media/${mediaId}`)).status).toBe(401);
  });
});

describe("parseRange", () => {
  it("parses single byte ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-30", 100)).toEqual({ start: 70, end: 99 });
    expect(parseRange("bytes=-300", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    // Ignored (→ full response): malformed, reversed, multi-range, other units.
    expect(parseRange("bytes=5-1", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
  });
});
