// Read applied model evidence through ai-gateway; never start or retry a paid call.
import { dbOf, type Db } from "../db.ts";
import { normalizedUppercase } from "../lib/text.ts";
import { extractJson } from "./llm.ts";
const sql = dbOf("ai-gateway");

export async function hasPrefilterReceipt(
  ids: number[],
  expected: { promptVersion: string; systemHash: string; userHash: string },
  db: Db = sql,
): Promise<boolean> {
  if (!ids.length) return false;
  const rows = await db<{ response: { choices?: Array<{ message?: { content?: string } }> } }[]>`
    SELECT response FROM receipts WHERE id = ANY(${ids}::bigint[]) AND purpose = 'prefilter_article' AND status = 'completed'
      AND request->>'promptVersion' = ${expected.promptVersion} AND request->>'systemHash' = ${expected.systemHash}
      AND request->>'userHash' = ${expected.userHash}`;
  return rows.some(({ response }) => {
    const text = response?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return false;
    try {
      const result = extractJson(text) as { label?: unknown } | null;
      return normalizedUppercase(result?.label) === "PASS";
    } catch {
      return false;
    }
  });
}
