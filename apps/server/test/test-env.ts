/**
 * Environment of the test run (shared by vitest.config.ts and the global setup). Tests always use
 * their own database; set TEST_DATABASE_URL to point them elsewhere (the name must end in "_test").
 */
import os from "node:os";
import path from "node:path";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://managealltv:managealltv@127.0.0.1:5432/managealltv_test";

export const TEST_MEDIA_DIR = path.join(os.tmpdir(), "managealltv-test-media");

export const TEST_PUBLIC_URL = "http://localhost:3000";

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123456789",
  PUBLIC_URL: TEST_PUBLIC_URL,
  PORT: "3000",
  MEDIA_DIR: TEST_MEDIA_DIR,
  MAX_UPLOAD_BYTES: "4294967296",
  DEFAULT_TIMEZONE: "Europe/Istanbul",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
  TRUST_PROXY: "false",
  EXTRA_TRUSTED_ORIGINS: "",
};
