import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

/** No resources are created on import; each caller owns its child and uses an isolated environment. */
export async function apiProcess(t: TestContext, env: NodeJS.ProcessEnv, args: readonly string[] = ["apps/api/src/main.ts"]) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  const child = spawn(process.execPath, args, {
    env: { ...env, API_HOST: "127.0.0.1", API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    });
  });
  // Register cleanup before readiness checks so assertion failures cannot leave a process listening.
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      return await finished;
    } finally {
      clearTimeout(timeout);
    }
  };
  t.after(stop);
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    output: () => output,
    stop,
    async waitForExit() {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        return await finished;
      } finally {
        clearTimeout(timeout);
      }
    },
    async ready() {
      for (let i = 0; i < 100 && !exited; i++) {
        try {
          if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(250) })).ok) return;
        } catch {
          // Readiness is bounded and an early process exit is checked on the next iteration.
        }
        await delay(50);
      }
      assert.fail(`API did not become ready: ${output}`);
    },
  };
}
