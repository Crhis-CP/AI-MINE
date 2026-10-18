import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "@amp/backend/config";
import { initializeDb, closeDb } from "@amp/backend/db";
import { applyOwnerPolicySuspension } from "../packages/backend/src/operations/lane-controls.ts";

if (process.env.AMP_RELEASE_LOCK_HELD !== "1" || !/^[a-f0-9]{12,40}$/.test(process.env.AMP_RELEASE ?? "")) throw new Error("发布锁或准确版本证明缺失");
const file = path.join(REPO_ROOT, "industry/release-controls.json");
const controls = z
  .strictObject({ policyPause: z.strictObject({ id: z.string(), reason: z.string() }).optional() })
  .parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
await initializeDb("worker");
try {
  console.log(JSON.stringify(controls.policyPause ? await applyOwnerPolicySuspension(controls.policyPause) : { status: "no_changes" }));
} finally {
  await closeDb();
}
