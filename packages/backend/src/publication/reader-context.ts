import { readCurrentPublicPolicies } from "@amp/backend/admin/sources";
import { z } from "zod";
import { ENTITIES } from "@amp/industry/taxonomy";
import type { SourceAttribution } from "@amp/contracts/http/public";
import type { ItemDetail } from "@amp/contracts/site";
import { sql, type Db } from "../db.ts";

const policyLabel = z.object({
  licence_label_zh: z.string(),
  conditions: z.array(z.string()),
  licence_url: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .default(null),
  legal_url: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .default(null),
});
const conditionLabels: Record<string, string> = {
  third_party_excluded: "许可不涵盖原文中的第三方材料。",
  no_official_endorsement: "本站整理不代表原发布方认可。",
  licence_at_access_applies: "使用时请核对原发布方当前许可条款。",
};
export function readerAttribution(name: string, url: string, policy: unknown): z.infer<typeof SourceAttribution> {
  const parsed = policyLabel.safeParse(policy);
  return {
    publishers: [{ name, url }],
    license: parsed.success ? { name: parsed.data.licence_label_zh, url: parsed.data.licence_url } : null,
    notice: parsed.success
      ? parsed.data.conditions
          .map((c) => conditionLabels[c])
          .filter(Boolean)
          .join(" ") || null
      : null,
    legalUrl: parsed.success ? parsed.data.legal_url : null,
  };
}
const context = z.object({
  entityId: z.string(),
  name: z.string(),
  originalName: z.string().nullable(),
  description: z.string().nullable(),
  quote: z.string().min(12),
  sources: z.array(z.object({ name: z.string(), url: z.url({ protocol: /^https?$/ }) })).min(1),
});
const namesCompany = (entityId: string, quote: string) =>
  ENTITIES[entityId]?.aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^\p{ASCII}+$/u.test(alias) ? new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(quote) : quote.includes(alias);
  });
/** Only current material evidence may establish company context; dictionary names are never model guesses. */
export function verifiedCompanyContext(output: unknown, body: string, originalUrl: string): NonNullable<ItemDetail["companyContext"]> {
  const raw = z.object({ company_context: z.array(context).max(12) }).safeParse(output);
  if (!raw.success) return [];
  return raw.data.company_context
    .filter((c) => namesCompany(c.entityId, c.quote) && body.includes(c.quote) && c.sources.every((source) => source.url === originalUrl))
    .map((c) => ({
      name: ENTITIES[c.entityId]!.name,
      originalName: c.originalName && ENTITIES[c.entityId]!.aliases.includes(c.originalName) && body.includes(c.originalName) ? c.originalName : null,
      description: c.description,
      sources: [{ name: "原文依据", url: originalUrl }],
    }));
}
export async function publicCompanyContext(articleId: string): Promise<NonNullable<ItemDetail["companyContext"]>> {
  const [row] = await sql<
    { company_context: NonNullable<ItemDetail["companyContext"]> }[]
  >`SELECT company_context FROM publications WHERE article_id=${articleId}`;
  return row?.company_context ?? [];
}

/** Read source-owned licence projections through their port, once per source and request. */
export async function attachSourcePolicies<T extends { source_id: string; source_policy?: unknown }>(rows: T[], db?: Db): Promise<T[]> {
  const ids = [...new Set(rows.map((row) => row.source_id))];
  const policies = new Map<string, unknown>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    for (const [id, policy] of await readCurrentPublicPolicies(ids.slice(offset, offset + 100), db)) policies.set(id, policy);
  }
  for (const row of rows) row.source_policy = policies.get(row.source_id) ?? null;
  return rows;
}
