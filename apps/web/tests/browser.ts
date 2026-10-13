import { existsSync } from "node:fs";
import { chromium, type BrowserContext } from "@playwright/test";

/** Use an already installed browser. Never install one or silently pass without it. */
export function browserExecutable(override = process.env.E2E_BROWSER_PATH): string {
  if (override) {
    if (!existsSync(override)) throw new Error("E2E_BROWSER_PATH does not exist");
    return override;
  }
  const found = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ].find((file) => existsSync(file));
  if (!found) throw new Error("No existing Chrome/Chromium found; set E2E_BROWSER_PATH. Browser downloads are not part of verify.");
  return found;
}

export function localRequest(value: string, origins: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      origins.includes(url.origin) &&
      ["127.0.0.1", "localhost", "private.localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Production browser fixtures need no service workers or WebSockets. Block before network dispatch. */
export async function isolateBrowser(context: BrowserContext, origins: readonly string[]) {
  const blocked: string[] = [];
  await context.route("**/*", (route) => {
    if (localRequest(route.request().url(), origins)) return route.continue();
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    blocked.push(socket.url());
    socket.close();
  });
  return blocked;
}
