import { z } from "zod";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const booleanFromString = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "postgresql:// URL olmalı"),
  /** Better Auth secret: signs cookies and encrypts 2FA secrets. Changing it logs everybody out. */
  BETTER_AUTH_SECRET: z.string().min(32, "En az 32 karakter olmalı"),
  /** Public origin of the panel/API, e.g. https://tv.example.com (invite links, cookies, CSRF). */
  PUBLIC_URL: z.url().transform((v) => v.replace(/\/+$/, "")),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MEDIA_DIR: z.string().min(1).default("./data/media"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4_294_967_296),
  DEFAULT_TIMEZONE: z.string().refine(isValidTimeZone, "Geçerli bir IANA saat dilimi olmalı").default("Europe/Istanbul"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /**
   * Set to true when running behind a reverse proxy (Caddy) that overwrites X-Forwarded-For.
   * Only then is the header used for rate limiting and audit IPs; otherwise it could be spoofed.
   */
  TRUST_PROXY: booleanFromString,
  /** Extra comma separated origins allowed for auth requests (e.g. the Vite dev server). */
  EXTRA_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    // Fail fast with a readable message instead of a stack trace deep inside a module.
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

export const env: Env = loadEnv();

export const publicUrl = new URL(env.PUBLIC_URL);
export const isHttps = publicUrl.protocol === "https:";
