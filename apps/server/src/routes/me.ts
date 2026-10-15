import type { api } from "@managealltv/protocol";
import { Hono } from "hono";
import { requireUser } from "../middleware/session";
import type { AppEnv } from "../types";

export function meRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);
  router.get("/", (c) => {
    const user = c.get("user");
    const me: api.Me = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      locationIds: user.locationIds,
      twoFactorEnabled: user.twoFactorEnabled,
    };
    return c.json(me);
  });
  return router;
}
