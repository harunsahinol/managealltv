import { api } from "@managealltv/protocol";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { uploadInfoPath, uploadPath } from "../src/lib/storage";
import { processMedia } from "../src/services/media-processing";
import { body, Client, errorBody, login, resetDatabase, signIn, startServer } from "./helpers";
import { sha256, TUS_HEADERS, tusCreate, tusMetadata, tusPatch, tusUpload } from "./media-helpers";
import { TEST_PUBLIC_URL } from "./test-env";

const { app } = createApp({ rateLimit: false });

beforeEach(resetDatabase);

const exists = (file: string) => stat(file).then(
  () => true,
  () => false,
);

describe("tus uploads", () => {
  it("uploads in chunks, resumes with HEAD and creates a processing media with Media-Id", async () => {
    const { client, user } = await login(app, "editor");
    const data = randomBytes(300_000);

    const created = await tusCreate(client, data.length, { filename: "Tanıtım Filmi.mov", filetype: "video/quicktime" });
    expect(created.res.status).toBe(201);
    expect(created.res.headers.get("tus-resumable")).toBe("1.0.0");
    // Behind a proxy the server only knows PUBLIC_URL as its public origin.
    expect(created.location).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/api/uploads/[a-f0-9]{32}$`));
    const uploadPathname = created.path ?? "";
    const uploadId = uploadPathname.split("/").pop() ?? "";

    const first = await tusPatch(client, uploadPathname, 0, data.subarray(0, 100_000));
    expect(first.status).toBe(204);
    expect(first.headers.get("upload-offset")).toBe("100000");
    expect(first.headers.get("media-id")).toBeNull();

    // After a dropped connection the client asks where to continue.
    const head = await client.head(uploadPathname, { headers: TUS_HEADERS });
    expect(head.status).toBe(200);
    expect(head.headers.get("upload-offset")).toBe("100000");
    expect(head.headers.get("upload-length")).toBe(String(data.length));
    expect(head.headers.get("cache-control")).toBe("no-store");

    // A wrong offset is refused (409) without writing anything.
    const wrong = await tusPatch(client, uploadPathname, 5, data.subarray(5, 10));
    expect(wrong.status).toBe(409);
    expect((await errorBody(wrong)).error.code).toBe("upload_offset_conflict");

    const last = await tusPatch(client, uploadPathname, 100_000, data.subarray(100_000));
    expect(last.status).toBe(204);
    const mediaId = last.headers.get("media-id");
    expect(mediaId).toBeTruthy();
    expect(last.headers.get("access-control-expose-headers")).toContain("Media-Id");

    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId ?? "" } });
    expect(media).toMatchObject({
      name: "Tanıtım Filmi",
      fileName: "Tanıtım Filmi.mov",
      type: "video",
      status: "processing",
      sourceMimeType: "video/quicktime",
      uploadId,
      uploadedById: user.id,
    });
    expect(sha256(await readFile(uploadPath(uploadId)))).toBe(sha256(data));

    // The finished upload still answers HEAD with the media it became; a repeated final PATCH is idempotent.
    const headDone = await client.head(uploadPathname, { headers: TUS_HEADERS });
    expect(headDone.headers.get("media-id")).toBe(mediaId);
    const again = await tusPatch(client, uploadPathname, data.length, new Uint8Array(0));
    expect(again.status).toBe(204);
    expect(again.headers.get("media-id")).toBe(mediaId);
    expect(await prisma.media.count()).toBe(1);

    const list = api.Media.array().parse(await body(await client.get("/api/media")));
    expect(list).toEqual([
      expect.objectContaining({ id: mediaId, name: "Tanıtım Filmi", type: "video", status: "processing", size: null, uploadedByName: user.name, playlistCount: 0 }),
    ]);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "media.upload" } });
    expect(entry).toMatchObject({ userId: user.id, entityType: "media", entityId: mediaId });
    expect(entry.summary).toContain('"Tanıtım Filmi" videosu yüklendi');
  });

  it("infers the type from the file name and refuses bad metadata", async () => {
    const { client } = await login(app, "admin");

    const noName = await tusCreate(client, 10, { filetype: "image/png" });
    expect(noName.res.status).toBe(400);
    expect(noName.res.headers.get("content-type")).toContain("application/json");
    expect(await errorBody(noName.res)).toEqual({ error: { code: "validation_error", message: "Dosya adı (filename) zorunludur." } });

    const gif = await tusCreate(client, 10, { filename: "anim.gif", filetype: "image/gif" });
    expect(gif.res.status).toBe(415);
    expect((await errorBody(gif.res)).error.code).toBe("unsupported_media_type");

    const unknownExtension = await tusCreate(client, 10, { filename: "belge.pdf" });
    expect(unknownExtension.res.status).toBe(415);

    const empty = await tusCreate(client, 0, { filename: "bos.png" });
    expect(empty.res.status).toBe(400);
    expect((await errorBody(empty.res)).error.message).toBe("Dosya boş.");

    const tooBig = await tusCreate(client, 5 * 1024 ** 3, { filename: "dev.mp4" });
    expect(tooBig.res.status).toBe(413);
    expect((await errorBody(tooBig.res)).error.code).toBe("payload_too_large");

    const invalidMetadata = await client.post("/api/uploads", {
      headers: { ...TUS_HEADERS, "upload-length": "10", "upload-metadata": "filename bad*base64" },
    });
    expect(invalidMetadata.status).toBe(400);
    expect((await errorBody(invalidMetadata)).error.code).toBe("validation_error");

    const noVersion = await client.post("/api/uploads", { headers: { "upload-length": "10", "upload-metadata": tusMetadata({ filename: "a.png" }) } });
    expect(noVersion.status).toBe(412);

    // No file type from the browser: the extension decides (.mkv → video).
    const { mediaId } = await tusUpload(client, randomBytes(1000), { filename: "klip.MKV" });
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ type: "video", sourceMimeType: "video/x-matroska" });
    const image = await tusUpload(client, randomBytes(1000), { filename: "afiş.jpg", filetype: "image/jpg" });
    expect(await prisma.media.findUniqueOrThrow({ where: { id: image.mediaId } })).toMatchObject({ type: "image", sourceMimeType: "image/jpeg" });
  });

  it("is limited to admins and editors, and each upload to its owner", async () => {
    const anonymous = new Client(app);
    const res = await tusCreate(anonymous, 10, { filename: "a.png" });
    expect(res.res.status).toBe(401);
    expect((await errorBody(res.res)).error.code).toBe("unauthorized");

    const { client: viewer } = await login(app, "viewer");
    expect((await tusCreate(viewer, 10, { filename: "a.png" })).res.status).toBe(403);

    const { client: owner } = await login(app, "editor");
    const created = await tusCreate(owner, 10, { filename: "a.png" });
    const uploadPathname = created.path ?? "";
    const uploadId = uploadPathname.split("/").pop() ?? "";

    const { client: other } = await login(app, "editor");
    const { client: admin } = await login(app, "admin");
    for (const intruder of [other, admin]) {
      const patch = await tusPatch(intruder, uploadPathname, 0, randomBytes(10));
      expect(patch.status).toBe(404);
      expect((await intruder.head(uploadPathname, { headers: TUS_HEADERS })).status).toBe(404);
      expect((await intruder.delete(uploadPathname, { headers: TUS_HEADERS })).status).toBe(404);
    }
    expect(await prisma.media.count()).toBe(0);

    // Downloading an original back is not offered.
    expect((await owner.get(uploadPathname, { headers: TUS_HEADERS })).status).toBe(405);
    // A cross-site page cannot drive uploads with the editor's cookie.
    const forged = await owner.post("/api/uploads", {
      headers: { ...TUS_HEADERS, origin: "https://evil.example", "upload-length": "10", "upload-metadata": tusMetadata({ filename: "a.png" }) },
    });
    expect(forged.status).toBe(403);

    // The owner may cancel: both the data and the tus info file disappear.
    expect(await exists(uploadPath(uploadId))).toBe(true);
    const cancel = await owner.delete(uploadPathname, { headers: TUS_HEADERS });
    expect(cancel.status).toBe(204);
    expect(await exists(uploadPath(uploadId))).toBe(false);
    expect(await exists(uploadInfoPath(uploadId))).toBe(false);
  });

  it("answers OPTIONS with the tus capabilities", async () => {
    const res = await app.request("/api/uploads", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("tus-version")).toBe("1.0.0");
    expect(res.headers.get("tus-max-size")).toBe("4294967296");
    expect(res.headers.get("tus-extension")).toContain("creation");
  });

  it("builds the Location from a trusted forwarded origin only", async () => {
    const { client } = await login(app, "editor");
    // TRUST_PROXY is false in tests, so forwarded headers are ignored; an untrusted Host never ends
    // up in the Location either: PUBLIC_URL is used.
    const spoofed = await client.post("/api/uploads", {
      headers: {
        ...TUS_HEADERS,
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        "upload-length": "10",
        "upload-metadata": tusMetadata({ filename: "a.png" }),
      },
    });
    expect(spoofed.status).toBe(201);
    expect(spoofed.headers.get("location")?.startsWith(`${TEST_PUBLIC_URL}/api/uploads/`)).toBe(true);
  });

  it("accepts 50 MB chunks over real HTTP; a non-video ends as failed and the upload is deleted", async () => {
    const server = await startServer(createApp({ rateLimit: false }));
    try {
      const { user } = await login(app, "editor");
      const http = await signIn(app, user.email, user.password);
      const cookie = [...http.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const chunkSize = 50 * 1024 * 1024;
      const data = randomBytes(chunkSize + 3 * 1024 * 1024);
      const common = { ...TUS_HEADERS, cookie, origin: TEST_PUBLIC_URL };

      const create = await fetch(`${server.baseUrl}/api/uploads`, {
        method: "POST",
        headers: { ...common, "upload-length": String(data.length), "upload-metadata": tusMetadata({ filename: "rastgele.mp4", filetype: "video/mp4" }) },
      });
      expect(create.status).toBe(201);
      const uploadPathname = new URL(create.headers.get("location") ?? "").pathname;

      let offset = 0;
      let mediaId: string | null = null;
      while (offset < data.length) {
        const chunk = data.subarray(offset, offset + chunkSize);
        const patch = await fetch(`${server.baseUrl}${uploadPathname}`, {
          method: "PATCH",
          headers: { ...common, "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
          body: new Uint8Array(chunk),
        });
        expect(patch.status).toBe(204);
        offset += chunk.length;
        expect(patch.headers.get("upload-offset")).toBe(String(offset));
        mediaId = patch.headers.get("media-id");
      }
      if (mediaId === null) throw new Error("no Media-Id");
      const uploadId = uploadPathname.split("/").pop() ?? "";
      expect((await stat(uploadPath(uploadId))).size).toBe(data.length);
      expect(sha256(await readFile(uploadPath(uploadId)))).toBe(sha256(data));

      expect(await processMedia(mediaId)).toBe("failed");
      const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
      expect(media.status).toBe("failed");
      expect(media.error).toBe("Video okunamadı. Dosya bozuk ya da desteklenmeyen bir biçimde olabilir.");
      expect(media.uploadId).toBeNull();
      expect(await exists(uploadPath(uploadId))).toBe(false);
      expect(await exists(uploadInfoPath(uploadId))).toBe(false);
    } finally {
      await server.close();
    }
  }, 120_000);
});
