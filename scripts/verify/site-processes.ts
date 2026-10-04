import type { ChildProcess } from "node:child_process";
import { stop } from "./lib.ts";

/** Drain every owned child before a following stage reuses its ports/database. */
export async function stopSiteProcesses(children: readonly ChildProcess[], graceMs = 5000): Promise<void> {
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => stop(child, "SIGKILL"), graceMs);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        stop(child);
      });
    }),
  );
}
