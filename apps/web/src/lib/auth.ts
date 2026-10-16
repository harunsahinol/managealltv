import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { z } from "zod";
import { type AuthFailure, authFailureToError, invalidResponseError, networkError } from "./api/errors";

/**
 * Better Auth client for /api/auth (same origin). The server translates Better Auth's error texts to
 * Turkish (apps/server/src/routes/auth.ts), so `error.message` can be shown as is.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [twoFactorClient()],
});

interface AuthResult {
  data: unknown;
  error: AuthFailure | null;
}

async function call(run: () => Promise<AuthResult>): Promise<unknown> {
  let result: AuthResult;
  try {
    result = await run();
  } catch {
    throw networkError();
  }
  if (result.error !== null) throw authFailureToError(result.error);
  return result.data;
}

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw invalidResponseError(200);
  return parsed.data;
}

const TwoFactorRedirect = z.object({ twoFactorRedirect: z.literal(true) });

/** Password step. `twoFactor: true` means a TOTP (or backup) code is needed before a session exists. */
export async function signInWithPassword(email: string, password: string): Promise<{ twoFactor: boolean }> {
  const data = await call(() => authClient.signIn.email({ email, password }));
  return { twoFactor: TwoFactorRedirect.safeParse(data).success };
}

/** Second step of sign-in, or confirming a freshly set up authenticator while signed in. */
export async function verifyTotp(code: string, trustDevice = false): Promise<void> {
  await call(() => authClient.twoFactor.verifyTotp({ code, trustDevice }));
}

export async function verifyBackupCode(code: string, trustDevice = false): Promise<void> {
  await call(() => authClient.twoFactor.verifyBackupCode({ code, trustDevice }));
}

export async function signOut(): Promise<void> {
  await call(() => authClient.signOut());
}

const EnableResult = z.object({ totpURI: z.string().min(1), backupCodes: z.array(z.string()) });

/** Starts TOTP setup. Two-factor becomes active only after verifyTotp() succeeds with a code from the app. */
export async function enableTwoFactor(password: string): Promise<z.infer<typeof EnableResult>> {
  const data = await call(() => authClient.twoFactor.enable({ password }));
  return parse(EnableResult, data);
}

export async function disableTwoFactor(password: string): Promise<void> {
  await call(() => authClient.twoFactor.disable({ password }));
}

const BackupCodesResult = z.object({ backupCodes: z.array(z.string()) });

/** Replaces the backup codes; the old ones stop working. */
export async function regenerateBackupCodes(password: string): Promise<string[]> {
  const data = await call(() => authClient.twoFactor.generateBackupCodes({ password }));
  return parse(BackupCodesResult, data).backupCodes;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await call(() => authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }));
}
