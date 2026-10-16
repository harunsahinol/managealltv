import type { z } from "zod";
import { ApiRequestError, invalidResponseError, networkError, toApiRequestError } from "./errors";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function send(method: Method, path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body, credentials: "same-origin", signal: options.signal });
  } catch (error) {
    // Let react-query see aborts as aborts (it cancels queries on unmount); everything else is the network.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw networkError();
  }
  if (!response.ok) throw toApiRequestError(response.status, await readJson(response));
  return response;
}

/** Calls the API and validates the JSON body against the protocol schema. */
export async function requestJson<S extends z.ZodType>(
  method: Method,
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.infer<S>> {
  const response = await send(method, path, options);
  const json = await readJson(response);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // A contract mismatch is a bug on one side; keep the details in the console for whoever debugs it.
    console.error(`Unexpected response for ${method} ${path}`, parsed.error.issues);
    throw invalidResponseError(response.status);
  }
  return parsed.data;
}

/** Calls an endpoint that answers 204 (or whose body the panel does not need). */
export async function requestVoid(method: Method, path: string, options: RequestOptions = {}): Promise<void> {
  await send(method, path, options);
}

export const get = <S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal) =>
  requestJson("GET", path, schema, { signal });

export { ApiRequestError };
