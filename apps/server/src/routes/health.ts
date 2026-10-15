import { Hono } from "hono";
import type { AppEnv } from "../types";

export function healthRoutes() {
  const router = new Hono<AppEnv>();
  router.get("/", (c) => c.json({ status: "ok" as const }));
  return router;
}
