import type { HttpBindings } from "@hono/node-server";
import type { api } from "@managealltv/protocol";
import type { Device } from "@prisma/client";

/** The signed-in panel user, loaded fresh from the database on every request. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: api.Role;
  /** Locations an editor/viewer is limited to; always empty for admins. */
  locationIds: string[];
  twoFactorEnabled: boolean;
  sessionId: string;
}

export interface AppVariables {
  /** Set by requireUser (session middleware). */
  user: AuthUser;
  /** Set by requireDevice (bearer token middleware). */
  device: Device;
}

/** Hono environment of the whole app. Bindings are absent when driven through app.request() in tests. */
export type AppEnv = {
  Bindings: HttpBindings;
  Variables: AppVariables;
};
