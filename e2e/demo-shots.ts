// README screenshots from the real production web build and the local demo API (synthetic data, no filing numbers).
//   npm run build --workspace @amp/web && node e2e/demo-shots.ts [outDir]
// Default outDir: docs/assets/reader-preview. Desktop 1440×1000, phone 390×844, light/dark by colour-scheme preference.
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { webEnvironment } from "../apps/web/runtime-env.ts";
import { openLog, ROOT, start } from "../scripts/verify/lib.ts";
import { stopSiteProcesses } from "../scripts/verify/site-processes.ts";
import { browserExecutable } from "./browser.ts";
import { startDemoReaderApi } from "./demo-api.ts";

const SHOTS = [
  { file: "reader-light.png", path: "/", viewport: { width: 1440, height: 1000 }, scheme: "light" },
  { file: "reader-dark.png", path: "/", viewport: { width: 1440, height: 1000 }, scheme: "dark" },
  { file: "reader-mobile.png", path: "/", viewport: { width: 390, height: 844 }, scheme: "light" },
  { file: "about-flow-dark.png", path: "/about", viewport: { width: 1440, height: 1000 }, scheme: "dark" },
] as const;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function takeDemoShots(outDir = path.join(ROOT, "docs/assets/reader-preview")) {
  if (!existsSync(path.join(ROOT, "apps/web/build/public/server/index.js"))) throw new Error("Build the web first: npm run build --workspace @amp/web");
  mkdirSync(outDir, { recursive: true });
  const api = await startDemoReaderApi(await freePort());
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = webEnvironment({
    PATH: process.env.PATH,
    NODE_ENV: "production",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: String(port),
    SITE_URL: origin,
    PRIVATE_HOST: "127.0.0.1",
    TRUST_PROXY: "false",
    API_BASE_URL: api.url,
  });
  const web = start(process.execPath, ["--import", path.join(ROOT, "e2e/web-clock.ts"), "apps/web/server.ts"], {
    env,
    log: openLog(path.join(outDir, ".demo-web.log")),
  });
  const browser = await chromium.launch({ executablePath: browserExecutable() });
  try {
    for (
      let i = 0;
      !(await fetch(`${origin}/api/health`)
        .then((r) => r.ok)
        .catch(() => false));
      i++
    ) {
      if (i > 100 || web.exitCode !== null) throw new Error("Production web did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: shot.viewport, colorScheme: shot.scheme, reducedMotion: "reduce", locale: "zh-CN" });
      await page.goto(origin + shot.path, { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(outDir, shot.file) });
      await page.close();
    }
  } finally {
    await browser.close();
    await stopSiteProcesses([web]);
    await api.close();
  }
  return SHOTS.map((shot) => path.join(outDir, shot.file));
}

if (import.meta.main) console.log((await takeDemoShots(process.argv[2])).join("\n"));
