import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
/** Output duties remain unchanged across suppliers; this identity is diagnostic metadata, never a paid-input cache key. */
export function modelOutputContract(schema: z.ZodType, parse?: (value: string) => unknown) {
  return sha256(stableJson([z.toJSONSchema(schema, { unrepresentable: "any" }), parse?.toString() ?? null]));
}
