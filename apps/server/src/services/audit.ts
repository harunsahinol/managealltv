import type { Prisma } from "@prisma/client";
import type { Context } from "hono";
import { prisma } from "../db";
import { clientIp } from "../lib/client-ip";
import { logger } from "../logger";
import type { AppEnv } from "../types";

export interface AuditInput {
  /** Dotted English verb, e.g. "device.claim", "user.update", "location.delete". */
  action: string;
  /** e.g. "device", "user", "location", "media", "playlist", "schedule", "invite". */
  entityType: string;
  entityId?: string | null;
  /** Turkish, human readable, e.g. `"Lobi 1" cihazı eşleştirildi`. */
  summary: string;
  /** Optional structured before/after values (avoid secrets). */
  details?: Prisma.InputJsonValue;
}

export interface AuditActor {
  userId: string | null;
  ip: string | null;
}

type DbClient = Prisma.TransactionClient | typeof prisma;

/** Writes an AuditLog row for an explicit actor (e.g. a user who just accepted an invite). */
export async function auditAs(actor: AuditActor, input: AuditInput, db: DbClient = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: actor.userId,
      ip: actor.ip,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      ...(input.details === undefined ? {} : { details: input.details }),
    },
  });
}

/**
 * Writes an AuditLog row for the signed-in user of the request. Pass the transaction client to make
 * the entry atomic with the change; outside a transaction a failed write is logged, not thrown, so an
 * audit hiccup never turns a successful change into an error response.
 */
export async function audit(c: Context<AppEnv>, input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
  const actor: AuditActor = { userId: c.get("user")?.id ?? null, ip: clientIp(c) };
  if (tx) return auditAs(actor, input, tx);
  try {
    await auditAs(actor, input);
  } catch (error) {
    logger.error("Failed to write audit log", { error, action: input.action });
  }
}

/** Quotes a user-provided name for Turkish summaries: «"Lobi" konumu». */
export const q = (value: string): string => `"${value}"`;
