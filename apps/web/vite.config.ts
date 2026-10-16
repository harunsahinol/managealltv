import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * In development the panel runs on Vite (5173) and talks to the API on 3000 through this proxy, so
 * the browser only ever sees one origin and the session cookie works as in production.
 * The API's CSRF check compares the Origin header with its trusted origins: add
 * EXTRA_TRUSTED_ORIGINS=http://localhost:5173 to apps/server/.env (the Origin is not rewritten here
 * on purpose, so the dev setup exercises the same check as production).
 */
const API_TARGET = "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, ws: true },
      "/health": { target: API_TARGET },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: API_TARGET, ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
