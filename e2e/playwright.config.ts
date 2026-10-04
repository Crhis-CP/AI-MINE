import path from "node:path";
import { defineConfig } from "@playwright/test";
import { browserExecutable } from "./browser.ts";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "smoke.spec.ts",
  outputDir: path.resolve(import.meta.dirname, "../.verify/e2e-smoke/results"),
  reporter: [["line"], ["json", { outputFile: path.resolve(import.meta.dirname, "../.verify/e2e-smoke/report.json") }]],
  forbidOnly: true,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  use: {
    headless: true,
    serviceWorkers: "block",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
    colorScheme: "light",
    trace: "retain-on-failure",
    launchOptions: { executablePath: browserExecutable(), args: ["--disable-background-networking", "--disable-component-update"] },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
