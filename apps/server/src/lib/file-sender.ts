import type { Context } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { notFound } from "./errors";

export interface SendFileOptions {
  /** Absolute path on disk. */
  path: string;
  contentType: string;
  /** Strong validator without quotes (e.g. the media SHA-256). Defaults to size+mtime. */
  etag?: string;
  /** Defaults to "private, no-cache" — devices/panel revalidate with If-None-Match. */
  cacheControl?: string;
  /** Adds Content-Disposition (inline) with this file name. */
  downloadName?: string;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single "bytes=" range against a file size.
 * Returns null when the header should be ignored (absent, malformed or multi-range: a full 200 is a
 * valid answer to those), "unsatisfiable" for a 416, otherwise the inclusive byte range.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  // "last < first" is a syntactically invalid range, which RFC 9110 says to ignore (full 200).
  if (rawEnd !== "" && Number(rawEnd) < start) return null;
  // "bytes=<size>-" is what a resuming client sends when it already has everything: 416.
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return { start, end };
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .includes(etag);
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Streams a file with HTTP Range support (206 / 416), Accept-Ranges, Content-Length, ETag and
 * If-None-Match / If-Range handling. HEAD requests get the headers only. Missing file → 404 ApiError.
 */
export async function sendFile(c: Context, options: SendFileOptions): Promise<Response> {
  const info = await stat(options.path).catch(() => null);
  if (!info || !info.isFile()) throw notFound("Dosya bulunamadı");
  const size = info.size;
  const etag = `"${options.etag ?? `${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}`}"`;

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": options.contentType,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control": options.cacheControl ?? "private, no-cache",
  });
  if (options.downloadName) headers.set("Content-Disposition", contentDisposition(options.downloadName));

  if (etagMatches(c.req.header("if-none-match"), etag)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }

  // If-Range: only honour Range when the client's copy is still the current one; otherwise send it all.
  const ifRange = c.req.header("if-range");
  const rangeAllowed = !ifRange || ifRange === etag || ifRange === headers.get("Last-Modified");
  const range = rangeAllowed ? parseRange(c.req.header("range"), size) : null;

  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;

  // Hono serves HEAD through the GET handler; opening a stream nobody reads would leak a descriptor.
  if (c.req.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const stream = Readable.toWeb(createReadStream(options.path, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}
