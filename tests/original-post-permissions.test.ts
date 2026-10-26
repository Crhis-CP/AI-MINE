import { stub, tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { runSelectionPrefilter } from "@amp/backend/editorial/analyze";
import { loadAnalyzeInput, analysisInputIdentity } from "../packages/backend/src/editorial/input.ts";
import { prepareNewsFallback, lockNewsProcessingPermissions } from "../packages/backend/src/providers/news-fallback.ts";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stopBoss, shutdownSignal } from "@amp/backend/jobs/queue";

const received: string[] = [];
let hold: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_n, request) => {
  received.push(request.body);
  const captured = hold;
  captured?.asked.open();
  if (captured) await captured.release.promise;
  return {
    choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "Synthetic permitted material" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
});
Object.assign(process.env, { PREFILTER_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: provider.url, DEEPSEEK_API_KEY: "test-key" });
before(() => installUsageFixtureForModel("deepseek-flash"));
after(async () => {
  hold?.release.open();
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function fixture() {
  const sourceId = `quote-permission-${tag()}`,
    url = `https://source.invalid/parent/${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Synthetic quoted boundary','rss','T1','editorial')`;
  await grantDateFixture(sourceId, [url]);
  const xPost: XPostData = {
    tweetId: tag(),
    authorName: "Author",
    handle: "author",
    text: "铜矿建设公告。",
    quoted: { authorName: "Quoted", handle: "quoted", text: "Independent quoted copper project schedule.", url: "https://source.invalid/outside/quote" },
  };
  return { sourceId, url, title: "铜矿建设公告", xPost, language: "zh", via: "fetch" as const };
}
async function restrict(sourceId: string, externalOnly = false, prefix = "/parent/") {
  const policy = (await readCurrentSourcePolicy(sourceId))!,
    scope = { ...policy.scope, path_prefixes: [prefix] };
  return saveSourcePolicy(
    sourceId,
    {
      policy: externalOnly
        ? {
            ...policy,
            evidence: policy.evidence.flatMap((e) => [
              { ...e, capabilities: e.capabilities.filter((c) => c !== "external_model") },
              { ...e, capabilities: ["external_model"], scope },
            ]),
          }
        : { ...policy, scope, evidence: policy.evidence.map((e) => ({ ...e, scope })) },
      expectedVersion: policy.permission_version,
      reason: "Synthetic quoted resource restriction",
    },
    "test",
  );
}
const saved = async (id: string) => ({ ...(await sql`SELECT revision,content_hash,x_post,body_text,body_html FROM articles WHERE id=${id}`)[0] });

test("out-of-scope quoted fulltext cannot be inserted or partly replace a previously permitted post", async () => {
  const input = await fixture();
  await restrict(input.sourceId);
  await assert.rejects(upsertMaterial(input), /storage permission denied/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${input.sourceId}`)[0].n, 0);
  const allowed = { ...input, xPost: { ...input.xPost, quoted: { ...input.xPost.quoted!, url: "https://source.invalid/parent/quoted" } } };
  const { articleId } = await upsertMaterial(allowed),
    before = await saved(articleId);
  const history = [...(await sql`SELECT revision,x_post FROM article_revisions WHERE article_id=${articleId} ORDER BY revision`)];
  await assert.rejects(upsertMaterial({ ...input, title: "不能部分替换的新标题" }), /storage permission denied/);
  assert.deepEqual(await saved(articleId), before);
  assert.deepEqual([...(await sql`SELECT revision,x_post FROM article_revisions WHERE article_id=${articleId} ORDER BY revision`)], history);
});

test("real model gateway separately fences parent and quoted resource identities before send and result commit", async () => {
  const input = await fixture(),
    original = (await readCurrentSourcePolicy(input.sourceId))!;
  const { articleId } = await upsertMaterial(input);
  const prepare = async () => {
    const article = (await loadAnalyzeInput(articleId))!;
    const permit = await prepareNewsFallback({
      root: shutdownSignal.signal,
      expected: analysisInputIdentity(article),
      current: async () => {
        const current = await loadAnalyzeInput(articleId);
        return current ? analysisInputIdentity(current) : null;
      },
      articles: [article],
    });
    return { article, permit };
  };
  const start = received.length;
  await restrict(input.sourceId);
  let current = await prepare();
  await assert.rejects(runSelectionPrefilter(current.article, { fallbackInput: current.permit }));
  assert.equal(received.length, start, "an allowed parent never authorizes its out-of-scope quotation");
  let policy = (await readCurrentSourcePolicy(input.sourceId))!;
  await saveSourcePolicy(input.sourceId, { policy: original, expectedVersion: policy.permission_version, reason: "Restore local/storage scope" }, "test");
  await restrict(input.sourceId, true);
  current = await prepare();
  await assert.rejects(runSelectionPrefilter(current.article, { fallbackInput: current.permit }));
  assert.equal(received.length, start, "public/local/storage permission does not imply external_model permission");
  await assert.rejects(sql.begin((tx) => lockNewsProcessingPermissions([articleId], tx)));
  policy = (await readCurrentSourcePolicy(input.sourceId))!;
  await saveSourcePolicy(input.sourceId, { policy: original, expectedVersion: policy.permission_version, reason: "Restore both resource grants" }, "test");
  await restrict(input.sourceId, true, "/outside/");
  current = await prepare();
  await assert.rejects(runSelectionPrefilter(current.article, { fallbackInput: current.permit }));
  assert.equal(received.length, start, "the permitted quote cannot replace the parent's resource identity");
  policy = (await readCurrentSourcePolicy(input.sourceId))!;
  await saveSourcePolicy(
    input.sourceId,
    { policy: original, expectedVersion: policy.permission_version, reason: "Restore explicitly permitted quote" },
    "test",
  );
  current = await prepare();
  const result = await runSelectionPrefilter(current.article, { fallbackInput: current.permit });
  assert.equal(result.label, "PASS");
  assert.equal(received.length, start + 1);
  assert.match(received.at(-1)!, /Independent quoted copper project schedule/);
  await restrict(input.sourceId, true);
  await assert.rejects(runSelectionPrefilter(current.article, { fallbackInput: current.permit }));
  await assert.rejects(sql.begin((tx) => lockNewsProcessingPermissions([articleId], tx)));
  assert.equal(received.length, start + 1, "permission changed after preparation blocks both a new send and cached reuse");
  policy = (await readCurrentSourcePolicy(input.sourceId))!;
  await saveSourcePolicy(input.sourceId, { policy: original, expectedVersion: policy.permission_version, reason: "Restore before in-flight check" }, "test");
  current = await prepare();
  hold = { asked: gate(), release: gate() };
  const running = runSelectionPrefilter(current.article, { fallbackInput: current.permit, attemptTag: `inflight-${tag()}` });
  await Promise.race([hold.asked.promise, running.then(() => assert.fail("expected a local model request"))]);
  await restrict(input.sourceId, true);
  hold.release.open();
  hold = null;
  await assert.rejects(running);
  await assert.rejects(sql.begin((tx) => lockNewsProcessingPermissions([articleId], tx)));
  assert.equal(received.length, start + 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${articleId}`)[0].n, 0);
});
