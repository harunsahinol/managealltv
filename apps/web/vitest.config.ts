import { defineConfig } from "vitest/config";

// Unit tests cover pure helpers only (formatting, schedule summaries, error mapping, permissions),
// so they run in Node without a DOM.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
