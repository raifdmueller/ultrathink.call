import { defineConfig } from "vitest/config";

// Unit tests only (*.test.js). The Playwright E2E specs live under tests/e2e/
// and are run by `npm run e2e`, never by vitest.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
