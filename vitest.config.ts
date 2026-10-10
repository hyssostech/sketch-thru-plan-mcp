import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Show console output of passing tests too: the search evaluation prints its score and misses.
    silent: false,
  },
});
