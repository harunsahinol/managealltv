import { PrismaClient } from "@prisma/client";
import { env } from "./env";

/** The single Prisma client of the process. */
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});

export type Db = typeof prisma;
