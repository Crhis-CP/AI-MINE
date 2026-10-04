// Synthetic admission evidence for existing publication tests, never a content-quality sample.
import { promptVersion } from "@amp/backend/editorial/prompts";
export const scopeVersion = promptVersion("prefilter");
export const scopeOutput = { prefilter: { label: "PASS", reason: "合成范围证据" } };

import { randomUUID } from "node:crypto";
import { dbOf } from "@amp/backend/db";
import { loadAnalyzeInput } from "@amp/backend/editorial/analyze";
import { prefilterUser, PREFILTER_SYSTEM } from "@amp/backend/editorial/writing";
import { sha256 } from "@amp/backend/lib/ids";

export async function scopeReceipt(articleId: string): Promise<number> {
  const input = (await loadAnalyzeInput(articleId))!;
  const sql = dbOf("ai-gateway");
  const request = { promptVersion: scopeVersion, systemHash: sha256(PREFILTER_SYSTEM), userHash: sha256(prefilterUser(input)) };
  const response = { choices: [{ message: { content: JSON.stringify(scopeOutput.prefilter) } }] };
  const [row] = await sql<
    { id: number }[]
  >`INSERT INTO receipts (logical_key, service, purpose, subject, status, origin, request, response, received_at, completed_at)
    VALUES (${`scope-fixture:${randomUUID()}`}, 'fixture', 'prefilter_article', ${`article:${articleId}@${input.revision}`}, 'completed', 'replay',
      ${sql.json(request)}, ${sql.json(response)}, now(), now()) RETURNING id`;
  return row!.id;
}
