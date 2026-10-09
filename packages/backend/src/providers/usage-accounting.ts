import type { Db } from "../db.ts";
import { beijingDate } from "@amp/contracts/time";

/** A database receipt reuse is not a provider prompt-cache hit. Called inside the existing claim transaction. */
export async function recordLocalReuse(
  db: Db,
  input: { service: string; model?: string | null; purpose: string; lane?: "news" | "policy" | "unknown" },
  now = new Date(),
) {
  await db`INSERT INTO ai.local_reuse_daily(day,lane,service,model,purpose,count)
    VALUES(${beijingDate(now)},${input.lane ?? "unknown"},${input.service},${input.model ?? ""},${input.purpose},1)
    ON CONFLICT(day,lane,service,model,purpose) DO UPDATE SET count=ai.local_reuse_daily.count+1`;
}
