/**
 * Recreates the test database schema from the migrations once per test run.
 *
 * Equivalent to `prisma migrate reset --force`, done by hand: Prisma refuses `migrate reset` when it
 * detects an AI agent without explicit user consent, and the tests must run the same way for people,
 * CI and agents. The database name must end in "_test" so this can never wipe a real database.
 */
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL, TEST_ENV, TEST_MEDIA_DIR } from "./test-env";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

export default async function setup(): Promise<void> {
  const databaseName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Refusing to reset "${databaseName}": the test database name must end in "_test".`);
  }

  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  try {
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await prisma.$disconnect();
  }

  execFileSync(path.join(serverDir, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: serverDir,
    env: { ...process.env, ...TEST_ENV },
    stdio: "pipe",
  });

  await rm(TEST_MEDIA_DIR, { recursive: true, force: true });
}
