import { dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { loadAnalyzeInput, evaluationInputFingerprint } from "@amp/backend/editorial/analyze";
import { sha256 } from "@amp/backend/lib/ids";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
const sql = dbOf("sources");
export async function boundEvaluationFixture(value: {
  title: string;
  body: string | null;
  source: string;
  tier: string;
  kind: string;
  firstParty: boolean;
  publishedAt: string | null;
  language?: string;
}) {
  if (!/_(test|ci)$/.test(new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname))
    throw new Error("Evaluation fixture requires isolated test database");
  const sourceId = `eval-${sha256(JSON.stringify([value.source, value.tier, value.kind, value.firstParty])).slice(0, 20)}`;
  await sql`INSERT INTO sources(id,name,kind,tier,first_party) VALUES(${sourceId},${value.source},${value.kind},${value.tier},${value.firstParty}) ON CONFLICT(id) DO NOTHING`;
  const url = `https://evaluation.invalid/${sha256(JSON.stringify([value.title, value.body, value.publishedAt])).slice(0, 32)}`;
  await ensureModelSourceFixture(sourceId, [url]);
  const material = await upsertMaterial({
    sourceId,
    url,
    title: value.title,
    bodyText: value.body,
    language: value.language ?? "en",
    bodyStatus: "ok",
    publishedAt: value.publishedAt ? new Date(value.publishedAt) : null,
    via: "fetch",
  });
  const input = (await loadAnalyzeInput(material.articleId))!;
  return { analysisInput: input, inputFingerprint: evaluationInputFingerprint(input) };
}
