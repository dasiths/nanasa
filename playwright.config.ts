import { defineConfig } from "@playwright/test";

const browser = process.env.NANASA_BROWSER;
if (browser !== undefined && !["chromium", "firefox", "webkit"].includes(browser)) {
  throw new Error(`Unsupported NANASA_BROWSER: ${browser}`);
}

export default defineConfig({
  testDir: "./test/acceptance",
  outputDir: "./test-results/acceptance",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    browserName: (browser ?? "chromium") as "chromium" | "firefox" | "webkit",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});