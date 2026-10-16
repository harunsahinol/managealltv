/**
 * Test helpers: database reset, an HTTP client with a cookie jar over app.request(), users that are
 * created through the real invite flow, devices paired through the real device API, and a real
 * listening server + WebSocket client for the device socket.
 */
import { serve } from "@hono/node-server";
import {
  type api,
  DEVICE_API_BASE,
  type DeviceInfo,
  type DeviceStatus,
  type DeviceToServer,
  PairPollResponse,
  PairRequest,
  PairResponse,
  ServerToDevice,
} from "@managealltv/protocol";
import type { Device, Location } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { CreatedApp } from "../src/app";
import { prisma } from "../src/db";
import { generateDeviceToken } from "../src/lib/crypto";
import { deviceHub } from "../src/services/device-hub";
import { acceptInvite, createInvite } from "../src/services/invites";
import { refreshManifests } from "../src/services/manifest";
import { TEST_PUBLIC_URL } from "./test-env";

type App = CreatedApp["app"];

export const ORIGIN = TEST_PUBLIC_URL;
export const DEFAULT_PASSWORD = "Dogru-Parola-2026";

// ------------------------------------------------------------------ fixtures / database

const pairRequestFixture = PairRequest.parse(
  JSON.parse(readFileSync(new URL("../../../packages/protocol/fixtures/pair-request.json", import.meta.url), "utf8")),
);

export function deviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return { ...pairRequestFixture.device, hardwareId: `hw-${randomBytes(6).toString("hex")}`, ...overrides };
}

/** Empties every application table (keeps the migration history) and drops live sockets. */
export async function resetDatabase(): Promise<void> {
  deviceHub.closeAll();
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${rows.map((r) => `"public"."${r.tablename}"`).join(", ")} CASCADE`);
}

export const uniqueSuffix = (): string => randomBytes(4).toString("hex");

/** Response body as unknown; tests parse it with the protocol schemas, which doubles as a contract check. */
export async function body(res: Response): Promise<unknown> {
  const value: unknown = await res.json();
  return value;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export async function errorBody(res: Response): Promise<ApiErrorBody> {
  const value = await body(res);
  if (typeof value !== "object" || value === null || !("error" in value)) throw new Error(`Not an ApiError: ${JSON.stringify(value)}`);
  return value as ApiErrorBody;
}

// ------------------------------------------------------------------ HTTP client

export interface RequestOptions {
  json?: unknown;
  /** Raw request body (e.g. a tus chunk); ignored when `json` is given. */
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** HTTP client over app.request() that keeps the Better Auth cookies like a browser would. */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(readonly app: App) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    if (options.json !== undefined) headers.set("content-type", "application/json");
    // Browsers send Origin on every state-changing request; Better Auth and our origin check need it.
    if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
    const res = await this.app.request(path, {
      method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body === undefined ? undefined : new Uint8Array(options.body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === "" || /max-age=0\b/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get(path: string, options?: RequestOptions) {
    return this.request("GET", path, options);
  }
  post(path: string, options?: RequestOptions) {
    return this.request("POST", path, options);
  }
  patch(path: string, options?: RequestOptions) {
    return this.request("PATCH", path, options);
  }
  put(path: string, options?: RequestOptions) {
    return this.request("PUT", path, options);
  }
  delete(path: string, options?: RequestOptions) {
    return this.request("DELETE", path, options);
  }
  head(path: string, options?: RequestOptions) {
    return this.request("HEAD", path, options);
  }
}

// ------------------------------------------------------------------ users

export interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
  role: api.Role;
}

export const tokenFromInviteUrl = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

/** Creates a user through the real invite + accept services (the only way accounts come to exist). */
export async function createUser(input: {
  role: api.Role;
  locationIds?: string[];
  name?: string;
  email?: string;
  password?: string;
}): Promise<TestUser> {
  const suffix = uniqueSuffix();
  const name = input.name ?? `Test ${input.role} ${suffix}`;
  const email = input.email ?? `${input.role}-${suffix}@example.com`;
  const password = input.password ?? DEFAULT_PASSWORD;
  const { link } = await createInvite({ name, email, role: input.role, locationIds: input.locationIds ?? [] }, null);
  const result = await acceptInvite(tokenFromInviteUrl(link.url), password);
  return { id: result.userId, name, email: result.email, password, role: input.role };
}

export async function signIn(app: App, email: string, password: string): Promise<Client> {
  const client = new Client(app);
  const res = await client.post("/api/auth/sign-in/email", { json: { email, password } });
  if (res.status !== 200) throw new Error(`Sign-in failed (${res.status}): ${await res.text()}`);
  return client;
}

/** A signed-in client for a fresh user with the given role/locations. */
export async function login(app: App, role: api.Role, locationIds: string[] = []): Promise<{ client: Client; user: TestUser }> {
  const user = await createUser({ role, locationIds });
  return { client: await signIn(app, user.email, user.password), user };
}

// ------------------------------------------------------------------ locations / devices

export function createLocation(name = `Konum ${uniqueSuffix()}`, timezone = "Europe/Istanbul"): Promise<Location> {
  return prisma.location.create({ data: { name, timezone } });
}

/** Inserts a paired device directly (no pairing round trip) and stores its first manifest hash. */
export async function createDevice(
  locationId: string,
  data: { name?: string; defaultPlaylistId?: string | null; volume?: number | null } = {},
): Promise<{ device: Device; token: string }> {
  const info = deviceInfo();
  const { token, hash } = generateDeviceToken();
  const device = await prisma.device.create({
    data: {
      name: data.name ?? `TV ${uniqueSuffix()}`,
      locationId,
      tokenHash: hash,
      hardwareId: info.hardwareId,
      manufacturer: info.manufacturer,
      model: info.model,
      androidVersion: info.androidVersion,
      sdkInt: info.sdkInt,
      appVersionName: info.appVersionName,
      appVersionCode: info.appVersionCode,
      screenWidth: info.screenWidth,
      screenHeight: info.screenHeight,
      freeStorageBytes: BigInt(info.freeStorageBytes),
      totalStorageBytes: BigInt(info.totalStorageBytes),
      videoDecoders: info.videoDecoders,
      defaultPlaylistId: data.defaultPlaylistId ?? null,
      volume: data.volume ?? null,
    },
  });
  await refreshManifests([device.id]);
  return { device: await prisma.device.findUniqueOrThrow({ where: { id: device.id } }), token };
}

export function deviceRequest(app: App, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return Promise.resolve(app.request(`${DEVICE_API_BASE}${path}`, { ...init, headers }));
}

export function postJson(app: App, path: string, json: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }),
  );
}

/** Full pairing through the device API: pair → admin claims → first poll delivers the token. */
export async function pairDevice(
  app: App,
  admin: Client,
  locationId: string,
  name = "Lobi 1",
): Promise<{ deviceId: string; token: string; pairing: PairResponse }> {
  const pairing = PairResponse.parse(await body(await postJson(app, `${DEVICE_API_BASE}/pair`, { device: deviceInfo() })));
  const claim = await admin.post("/api/devices/claim", { json: { pairingCode: pairing.pairingCode, name, locationId } });
  if (claim.status !== 200) throw new Error(`Claim failed (${claim.status}): ${await claim.text()}`);
  const poll = PairPollResponse.parse(
    await body(await postJson(app, `${DEVICE_API_BASE}/pair/poll`, { pairingSecret: pairing.pairingSecret })),
  );
  if (poll.status !== "paired") throw new Error(`Expected paired, got ${poll.status}`);
  return { deviceId: poll.deviceId, token: poll.deviceToken, pairing };
}

// ------------------------------------------------------------------ waiting

/** Polls `check` until it returns a non-null value (or throws on timeout). */
export async function waitFor<T>(check: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ------------------------------------------------------------------ real server + device socket

export interface TestServer {
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** Listens on a random local port with WebSocket support (needed for the device socket). */
export async function startServer(created: CreatedApp): Promise<TestServer> {
  const server = serve({ fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" });
  created.injectWebSocket(server);
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
}

type MessageOf<T extends ServerToDevice["type"]> = Extract<ServerToDevice, { type: T }>;

interface Waiter {
  type: ServerToDevice["type"];
  resolve: (message: ServerToDevice) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** A fake player on the device WebSocket: queues server messages and lets tests await them by type. */
export class DeviceSocket {
  private readonly inbox: ServerToDevice[] = [];
  private readonly waiters: Waiter[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.inbox.push(ServerToDevice.parse(JSON.parse(String(event.data))));
      this.flush();
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
    });
  }

  static connect(wsUrl: string, token: string): Promise<DeviceSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}${DEVICE_API_BASE}/ws`, { headers: { authorization: `Bearer ${token}` } });
      const socket = new DeviceSocket(ws);
      ws.addEventListener("open", () => resolve(socket), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
  }

  /** Resolves with the next (already received or future) message of the given type. */
  next<T extends ServerToDevice["type"]>(type: T, timeoutMs = 5000): Promise<MessageOf<T>> {
    return new Promise<MessageOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`No ${type} message within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter: Waiter = { type, resolve: (message) => resolve(message as MessageOf<T>), reject, timer };
      this.waiters.push(waiter);
      this.flush();
    });
  }

  /** Messages received so far that no next() call consumed. */
  pending(): readonly ServerToDevice[] {
    return this.inbox;
  }

  send(message: DeviceToServer): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }

  private flush(): void {
    for (const waiter of [...this.waiters]) {
      const index = this.inbox.findIndex((message) => message.type === waiter.type);
      if (index < 0) continue;
      const [message] = this.inbox.splice(index, 1);
      if (!message) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }
}

/** A DeviceStatus as a player would send it. */
export function deviceStatus(manifestVersion: number | null, overrides: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    manifestVersion,
    activePlaylistId: null,
    currentMediaId: null,
    syncState: "idle",
    syncFilesDone: 0,
    syncFilesTotal: 0,
    syncBytesDone: 0,
    syncBytesTotal: 0,
    lastError: null,
    freeStorageBytes: 1_000_000_000,
    uptimeSec: 60,
    appVersionName: "0.1.1",
    appVersionCode: 2,
    volume: 50,
    overlayPermission: true,
    deviceOwner: false,
    ...overrides,
  };
}
