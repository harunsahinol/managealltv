import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./test/test-env.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    env: TEST_ENV,
    // All files share one database; running them one after another keeps resets from colliding.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
