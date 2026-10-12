import { readCurrentBody } from "@amp/backend/content/materials";
import { overrideFields } from "@amp/backend/admin/content";

/** Explicit synthetic human confirmation for legacy behavioral tests. Never supplies a production permission. */
export async function confirmedManualEdit(articleId: string, input: Parameters<typeof overrideFields>[1], actor: string) {
  const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname;
  if (!/_(test|ci)$/.test(database)) throw new Error("Confirmed manual fixture requires an isolated test database");
  const material = await readCurrentBody(articleId);
  if (!material) throw new Error("Synthetic manual revision material is missing");
  const original = `${material.title}\n${material.body_text ?? ""}`;
  if (original.trim().length < 12) throw new Error("Synthetic source must contain at least 12 characters of genuine fixture evidence");
  const result = await overrideFields(
    articleId,
    {
      ...input,
      command: "publish",
      source_revision: material.revision,
      source_checked: true,
      facts_checked: true,
      evidence_quote: Array.from(original.trim()).slice(0, 1200).join(""),
      resolution_note: "合成测试显式核对本修订原文并解决此前事实冲突。",
    },
    actor,
  );
  if (!result || !("publication" in result)) throw new Error("Confirmed manual fixture did not publish the explicit revision");
  return result.publication;
}
