import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { prisma } from "./db";
import { env, isHttps, publicUrl } from "./env";

/** Header our own /api/auth handler sets from the trusted client IP (see routes/auth.ts). */
export const CLIENT_IP_HEADER = "x-managealltv-client-ip";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const auth = betterAuth({
  appName: "ManageAllTV",
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [publicUrl.origin, ...env.EXTRA_TRUSTED_ORIGINS],
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Accounts are only created through admin invites (routes/invites.ts).
    disableSignUp: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
  },
  user: {
    additionalFields: {
      role: {
        type: ["admin", "editor", "viewer"],
        required: false,
        defaultValue: "viewer",
        input: false,
      },
      disabled: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  plugins: [twoFactor({ issuer: "ManageAllTV" })],
  databaseHooks: {
    session: {
      create: {
        // Covers password sign-in and the 2FA verification step alike.
        before: async (session) => {
          const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { disabled: true } });
          if (!user || user.disabled) {
            throw new APIError("FORBIDDEN", { code: "ACCOUNT_DISABLED", message: "Bu hesap devre dışı bırakılmış." });
          }
        },
      },
    },
  },
  advanced: {
    useSecureCookies: isHttps,
    // Only our handler sets this header (from the socket or a trusted proxy), so it cannot be forged.
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  telemetry: { enabled: false },
});

export type Auth = typeof auth;
