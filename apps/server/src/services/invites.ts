/**
 * One-time invite / password-reset links (no e-mail server: the admin hands the link over).
 * Tokens are 32 random bytes (base64url); only their SHA-256 is stored. Valid 72 h, single use.
 *
 * Accepting works although public sign-up is disabled because users and credential accounts are
 * created through Better Auth's internal adapter (the same path its admin plugin uses), with
 * Better Auth's own password hasher, so /api/auth/sign-in/email accepts them afterwards.
 */
import type { api } from "@managealltv/protocol";
import type { Invite } from "@prisma/client";
import { auth } from "../auth";
import { prisma } from "../db";
import { env } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export function inviteUrl(token: string): string {
  return `${env.PUBLIC_URL}/invite/${token}`;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Throws 400 when any id is not an existing location. */
export async function assertLocationsExist(locationIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(locationIds)];
  if (unique.length === 0) return [];
  const found = await prisma.location.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw badRequest("Seçilen konumlardan biri bulunamadı.");
  return unique;
}

async function issue(data: Omit<Invite, "id" | "tokenHash" | "expiresAt" | "usedAt" | "createdAt">): Promise<{
  link: api.InviteLink;
  invite: Invite;
}> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await prisma.invite.create({ data: { ...data, tokenHash: sha256Hex(token), expiresAt } });
  return { link: { url: inviteUrl(token), expiresAt: expiresAt.toISOString() }, invite };
}

/** POST /api/users/invites. Earlier open invites for the same e-mail are invalidated. */
export async function createInvite(input: api.InviteCreate, createdById: string | null) {
  const email = normalizeEmail(input.email);
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict("email_taken", "Bu e-posta adresiyle kayıtlı bir kullanıcı zaten var.");
  }
  const locationIds = input.role === "admin" ? [] : await assertLocationsExist(input.locationIds);
  await prisma.invite.updateMany({
    where: { kind: "invite", email, usedAt: null },
    data: { usedAt: new Date() },
  });
  return issue({
    kind: "invite",
    name: input.name,
    email,
    role: input.role,
    locationIds,
    userId: null,
    createdById,
  });
}

/** POST /api/users/:id/password-reset. Earlier open reset links of the user are invalidated. */
export async function createPasswordReset(userId: string, createdById: string | null) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("Kullanıcı bulunamadı");
  await prisma.invite.updateMany({
    where: { kind: "password_reset", userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  const result = await issue({
    kind: "password_reset",
    name: user.name,
    email: user.email,
    role: null,
    locationIds: [],
    userId: user.id,
    createdById,
  });
  return { ...result, user };
}

/** An unused, unexpired invite for this token, or null. */
export async function findOpenInvite(token: string, now = new Date()): Promise<Invite | null> {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!invite || invite.usedAt !== null || invite.expiresAt <= now) return null;
  return invite;
}

export function toInviteInfo(invite: Invite): api.InviteInfo {
  return {
    kind: invite.kind,
    name: invite.name,
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
  };
}

const INVALID_LINK = "Bağlantı geçersiz, kullanılmış veya süresi dolmuş.";

/** Marks the invite used if it still is open; false when someone else used it first. */
async function consume(inviteId: string, now: Date): Promise<boolean> {
  const result = await prisma.invite.updateMany({
    where: { id: inviteId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return result.count === 1;
}

async function release(inviteId: string): Promise<void> {
  await prisma.invite.update({ where: { id: inviteId }, data: { usedAt: null } });
}

export type AcceptResult =
  | { kind: "invite"; userId: string; email: string; name: string }
  | { kind: "password_reset"; userId: string; email: string; name: string };

/** POST /api/invites/:token/accept. Creates the user (invite) or sets the password and revokes sessions (reset). */
export async function acceptInvite(token: string, password: string): Promise<AcceptResult> {
  const now = new Date();
  const invite = await findOpenInvite(token, now);
  if (!invite) throw notFound(INVALID_LINK);
  const ctx = await auth.$context;

  if (invite.kind === "invite") {
    if (await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } })) {
      throw conflict("email_taken", "Bu e-posta adresiyle kayıtlı bir kullanıcı zaten var.");
    }
    if (!(await consume(invite.id, now))) throw notFound(INVALID_LINK);
    try {
      const hash = await ctx.password.hash(password);
      const user = await ctx.internalAdapter.createUser(
        { name: invite.name, email: invite.email, emailVerified: true, role: invite.role ?? "viewer", disabled: false },
        { method: "admin" },
      );
      await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
      if (invite.role !== "admin" && invite.locationIds.length > 0) {
        // Locations deleted since the invite was issued are silently dropped.
        const existing = await prisma.location.findMany({ where: { id: { in: invite.locationIds } }, select: { id: true } });
        await prisma.userLocation.createMany({
          data: existing.map((l) => ({ userId: user.id, locationId: l.id })),
          skipDuplicates: true,
        });
      }
      return { kind: "invite", userId: user.id, email: user.email, name: user.name };
    } catch (error) {
      await release(invite.id);
      throw error;
    }
  }

  const userId = invite.userId;
  if (!userId) throw notFound(INVALID_LINK);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound(INVALID_LINK);
  if (!(await consume(invite.id, now))) throw notFound(INVALID_LINK);
  try {
    const hash = await ctx.password.hash(password);
    if (await ctx.internalAdapter.findCredentialAccount(userId)) {
      await ctx.internalAdapter.updatePassword(userId, hash);
    } else {
      await ctx.internalAdapter.createAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    }
  } catch (error) {
    await release(invite.id);
    throw error;
  }
  await revokeUserSessions(userId);
  return { kind: "password_reset", userId, email: user.email, name: user.name };
}

/** Signs a user out everywhere (password reset, disabling). */
export async function revokeUserSessions(userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}
