import { afterAll, beforeAll } from "vitest";
import { prisma } from "../src/db";
import { ensureStorageDirs } from "../src/lib/storage";
import { deviceHub } from "../src/services/device-hub";

beforeAll(async () => {
  await ensureStorageDirs();
});

afterAll(async () => {
  deviceHub.closeAll();
  await prisma.$disconnect();
});
