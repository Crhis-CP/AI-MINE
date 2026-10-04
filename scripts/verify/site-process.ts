// Explicit CLI used by baseline/run.sh; importing the env helper itself starts nothing.
import { spawn } from "node:child_process";
import path from "node:path";
import { siteChildEnvironments } from "./api-harness.ts";
import { stopSiteProcesses } from "./site-processes.ts";

const role = process.argv[2];
if (role !== "public-api" && role !== "private-api" && role !== "web" && role !== "validate") throw new Error("Harness process role is required");
const environments = siteChildEnvironments(process.env);
if (role === "validate") process.exit(0);
const root = path.resolve(import.meta.dirname, "../..");
const child = spawn(process.execPath, [role === "web" ? "apps/web/server.ts" : "apps/api/src/main.ts"], {
  cwd: root,
  env: environments[role],
  stdio: "inherit",
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopSiteProcesses([child]);
  });
child.on("error", () => {
  console.error("Harness child could not start");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
