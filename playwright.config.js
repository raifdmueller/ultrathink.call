import { defineConfig } from "@playwright/test";

// E2E config (story #20). Serves the static app and drives two browser contexts
// through a real WebRTC handshake with fake media. Uses the bundled Chromium
// (no Google Chrome channel) so it runs in CI and this sandbox.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  expect: { timeout: 20000 },
  // Real WebRTC handshakes under parallel load occasionally miss the connection
  // window; one retry absorbs that without masking a genuine, repeatable failure.
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:8080",
    browserName: "chromium",
    launchOptions: {
      // In the sandbox, point at the pre-installed Chromium via PW_CHROMIUM.
      // In CI, leave it unset and `npx playwright install chromium` provides one.
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "python3 -m http.server 8080",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
