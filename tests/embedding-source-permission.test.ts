import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { ensureEmbeddings, EMBEDDING_MODEL } from "@amp/backend/providers/embeddings";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForEmbedding } from "./usage-protection-fixture.ts";

const sent: string[][] = [];
let beforeResponse: (() => Promise<void>) | null = null;
const provider = await stub(async (_hit, request) => {
  const texts = JSON.parse(request.body).input as string[];
  sent.push(texts);
  if (beforeResponse) await beforeResponse();
  return { data: texts.map((_text, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 10, completion_tokens: 0 } };
});
process.env.DASHSCOPE_BASE_URL = provider.url;
process.env.DASHSCOPE_API_KEY = "synthetic-embedding-key";
await installUsageFixtureForEmbedding(EMBEDDING_MODEL);
after(async () => {
  await provider.close();
  await closeDb();
});

async function material(allowed: boolean) {
  const source = `embedding-permit-${tag()}`,
    url = `https://fixture.invalid/${source}`,
    text = `Copper production report ${source}`;
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES(${source},${source},'rss','hot_signal')`;
  let policy = await grantDateFixture(source, [url]);
  const item = await upsertMaterial({ sourceId: source, url, title: text, bodyText: text, via: "fetch" });
  const deny = async () => {
    policy = await saveSourcePolicy(
      source,
      {
        expectedVersion: policy.permission_version,
        policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
        reason: "Synthetic source permission withdrawal",
      },
      "test",
    );
  };
  if (!allowed) await deny();
  return { id: item.articleId, text, source, deny };
}

test("embedding excludes a denied source without blocking the permitted member of the same batch", async () => {
  const denied = await material(false),
    allowed = await material(true);
  const result = await ensureEmbeddings("article", [denied, allowed]);
  assert.deepEqual(sent.at(-1), [allowed.text], "external_model=deny must be checked before the outbound embedding request");
  assert.equal(result.has(denied.id), false);
  assert.deepEqual(result.get(allowed.id), [1, 0]);
  assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id=${denied.id}`).length, 0);
  const [attempt] = await sql`SELECT source_ids FROM ai.usage_attempts WHERE capability='embedding' ORDER BY occurred_at DESC LIMIT 1`;
  assert.deepEqual(attempt.source_ids, [allowed.source]);
});

test("permission revoked while an embedding is in flight prevents storing its result", async () => {
  const item = await material(true);
  beforeResponse = item.deny;
  try {
    await assert.rejects(ensureEmbeddings("article", [item]), /许可|变化/);
    assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id=${item.id}`).length, 0);
  } finally {
    beforeResponse = null;
  }
});
