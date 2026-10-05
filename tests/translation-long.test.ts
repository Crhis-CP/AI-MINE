import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { z } from "zod";
import { chatJson } from "@amp/backend/providers/llm";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { receiptObservedVersion, releaseReceipt } from "@amp/backend/admin/runs";
import { runBodyTranslation, type TranslationRecipe } from "../packages/backend/src/editorial/translation-runtime.ts";
import { readableTranslation, translationSourceManifest } from "../packages/backend/src/editorial/translation-readiness.ts";

const sql = dbOf("enrichment"),
  T = tag(),
  SOURCE = `long-${T}`;
const recipe: TranslationRecipe = {
  id: `long-${T}`,
  model: "deepseek-flash",
  promptVersion: `long-${T}`,
  system: "SELF_AUTHORED fixture; translate only text",
};
let mode = "normal";
let hold: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const requests: { text: string; referenceOnly?: string }[] = [];
const translate = (text: string) =>
  text
    .split(/(<[^>]+>|⟦\d+⟧)/g)
    .map((part) => (!part.trim() || /^(<|⟦)/.test(part) ? part : "自编中文译文。"))
    .join("");
const provider = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content) as (typeof requests)[number];
    requests.push(input);
    const selected = mode,
      waiting = hold;
    waiting?.asked.open();
    if (waiting) await waiting.release.promise;
    if (selected === "reset") return res.destroy();
    const length = selected.includes("length") && (input.text.includes("\n") || selected === "length-child" || selected === "held-length");
    const bad = selected === "bad" || (selected === "length-bad-child" && !input.text.includes("\n"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ text: translate(input.text), ...(bad ? { extra: true } : {}) }) }, finish_reason: length ? "length" : "stop" },
        ],
        ...(selected === "no-usage-length" ? {} : { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
      }),
    );
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${SOURCE},'Self authored long fixture','rss',true)`;
});
after(async () => {
  hold?.release.open();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await stopBoss();
  await closeDb();
  console.log(`LOCAL_MODEL_FIXTURE_CALLS=${requests.length}`);
});
const material = (name: string, html: string) =>
  upsertMaterial({
    sourceId: SOURCE,
    url: `https://fixture.invalid/${T}/${name}`,
    title: name,
    language: "en",
    bodyHtml: sanitizeBody(html),
    bodyText: html.replace(/<[^>]+>/g, " "),
    bodyStatus: "ok",
    via: "fetch",
  });
const stored = async (articleId: string) =>
  (await sql`SELECT revision,body_html,complete,origin,recipe,source_hash,manifest FROM translations WHERE article_id=${articleId}`)[0]!;
const ageRejected = async (articleId: string) => {
  await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
  WHERE receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${articleId}@%`}) AND output_rejected_at IS NOT NULL`;
};
const halves = (name: string) => `<p>Left ${name} ${T}.\nRight ${name} ${T}.</p>`;
async function observedVersion(id: number) {
  const [row] = await sql<{ receiptId: string; attempts: number; updatedAtUtc: string }[]>`SELECT id::text AS "receiptId",attempts,
    pg_catalog.to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtUtc" FROM receipts WHERE id=${id}`;
  return receiptObservedVersion(row!);
}

test("actual long calls preserve units, all ordered coverage and reference-bound cache reuse", async () => {
  mode = "normal";
  const html = sanitizeBody(
    `<p>${Array.from({ length: 20 }, (_, i) => `Line ${i} ${T}. ${"Élément ".repeat(42)}<strong>not</strong> approved.`).join("\n")}</p><table><tr><td>One cell.</td><td>Two cells.</td></tr></table>`,
  );
  const { articleId } = await material("long", html),
    start = requests.length;
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  const row = await stored(articleId),
    plan = translationSourceManifest(html);
  assert.equal(requests.length - start, plan.segments.length);
  assert.ok(plan.segments.length > 2);
  for (const [i, request] of requests.slice(start).entries()) {
    assert.ok(Buffer.byteLength(request.text, "utf8") <= 4000);
    assert.equal(request.referenceOnly ?? "", plan.segments[i]!.reference);
  }
  assert.equal(requests.at(-1)!.text, "<td>One cell.</td><td>Two cells.</td>");
  assert.equal(readableTranslation(html, { revision: 1, recipe: recipe.id }, row as never), row.body_html);
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, plan.segments.length);
  const serial = (middle: string) => `<p>First stable ${T}.</p><p>${middle} ${T}.</p><p>Third stable ${T}.</p><p>Fourth stable ${T}.</p>`;
  const revision = await material("revision", serial("Middle one")),
    prior = requests.length;
  assert.equal((await runBodyTranslation(revision.articleId, recipe)).status, "translated");
  await material("revision", serial("Middle two"));
  assert.equal((await runBodyTranslation(revision.articleId, recipe)).status, "translated");
  assert.equal(requests.length - prior, 6, "only changed text and the following source reference create new requests");
});

test("unbreakable rows/clauses/inline nodes stop before any paid request", async () => {
  const before = requests.length;
  for (const [i, html] of [
    "<p>" + "long ".repeat(1000) + "</p>",
    "<table><tr><td>" + "long ".repeat(1000) + "</td></tr></table>",
    "<li>" + "long\n".repeat(1000) + "</li>",
  ].entries()) {
    const { articleId } = await material(`capacity-${i}`, html);
    assert.equal((await runBodyTranslation(articleId, recipe)).reason, "pending_capacity");
  }
  assert.equal(requests.length, before);
});

test("known truncation makes exactly one durable replacement; all raw attempts and reuse survive", async () => {
  mode = "length-once";
  const html = halves("replace"),
    { articleId } = await material("replace", html),
    start = requests.length;
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, 3);
  const checkpoints =
    await sql`SELECT segment_index,parent_index,replacement_plan,state,receipt_id,attempt_id FROM enrichment.translation_segments WHERE article_id=${articleId} ORDER BY segment_index`;
  assert.deepEqual(
    checkpoints.map((r) => [r.segment_index, r.parent_index, r.state]),
    [
      [0, null, "failed"],
      [1, 0, "complete"],
      [2, 0, "complete"],
    ],
  );
  assert.equal(checkpoints[0]!.replacement_plan.format, "half-v1");
  await assert.rejects(
    sql`UPDATE enrichment.translation_segments SET replacement_plan=${sql.json(checkpoints[0]!.replacement_plan)}
    WHERE article_id=${articleId} AND parent_index=0`,
    { code: "23514" },
  );
  await assert.rejects(
    sql`UPDATE enrichment.translation_segments SET parent_index=999
    WHERE article_id=${articleId} AND parent_index=0`,
    { code: "23503" },
  );
  const receipts =
    await sql`SELECT r.status,a.response->'choices'->0->>'finish_reason' AS finish,a.usage FROM receipts r JOIN receipt_attempts a ON a.id=r.response_attempt_id WHERE r.id=ANY(${checkpoints.map((r) => r.receipt_id)}::bigint[]) ORDER BY r.id`;
  assert.deepEqual(
    receipts.map((r) => [r.status, r.finish]),
    [
      ["received", "length"],
      ["completed", "stop"],
      ["completed", "stop"],
    ],
  );
  assert.ok(receipts.every((r) => r.usage.prompt_tokens === 10));
  const row = await stored(articleId);
  assert.equal(readableTranslation(sanitizeBody(html), { revision: 1, recipe: recipe.id }, row as never), row.body_html);
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, 3);
});

test("replacement failure never derives another branch or stacks bad-output retries", async () => {
  for (const selected of ["length-child", "length-bad-child", "no-usage-length"]) {
    mode = selected;
    const { articleId } = await material(selected, halves(selected)),
      start = requests.length;
    assert.equal((await runBodyTranslation(articleId, recipe)).status, "partial");
    const first = requests.length;
    await ageRejected(articleId);
    assert.equal((await runBodyTranslation(articleId, recipe)).status, "partial");
    assert.equal(requests.length, first);
    assert.equal(first - start, selected === "length-bad-child" ? 3 : selected === "length-child" ? 2 : 1);
    assert.equal((await stored(articleId)).complete, false);
    const parents = await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${articleId} AND replacement_plan IS NOT NULL`;
    assert.equal(parents[0]!.n, selected === "no-usage-length" ? 0 : 1);
  }
});

test("known bad output waits five minutes and cannot switch from retries to truncation replacement", async () => {
  mode = "bad";
  const { articleId } = await material("cooldown", halves("cooldown")),
    start = requests.length;
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "partial");
  assert.equal((await runBodyTranslation(articleId, recipe)).reason, "retry_cooldown");
  assert.equal(requests.length - start, 1);
  await ageRejected(articleId);
  mode = "length-once";
  assert.equal((await runBodyTranslation(articleId, recipe)).reason, "truncated");
  assert.equal(requests.length - start, 2);
  assert.equal((await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${articleId} AND replacement_plan IS NOT NULL`)[0]!.n, 0);
  assert.equal((await runBodyTranslation(articleId, recipe)).reason, "truncated");
  assert.equal(requests.length - start, 2);
});

test("replacement transaction failure and a late revision keep the received parent without extra calls", async () => {
  mode = "length-once";
  const { articleId } = await material("rollback", halves("rollback")),
    name = `long_rollback_${T}`,
    start = requests.length;
  await sql`CREATE FUNCTION ${sql(name)}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.replacement_plan IS NOT NULL THEN RAISE EXCEPTION 'replacement rollback'; END IF; RETURN NEW; END$$`;
  await sql`CREATE TRIGGER ${sql(name)} BEFORE INSERT OR UPDATE ON enrichment.translation_segments FOR EACH ROW EXECUTE FUNCTION ${sql(name)}()`;
  try {
    await assert.rejects(runBodyTranslation(articleId, recipe), /replacement rollback/);
  } finally {
    await sql`DROP TRIGGER ${sql(name)} ON enrichment.translation_segments`;
    await sql`DROP FUNCTION ${sql(name)}()`;
  }
  assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@%`}`)[0]!.status, "received");
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, 3, "replayed parent response is not repurchased");
  mode = "held-length";
  const late = await material("late", halves("late")),
    before = requests.length;
  hold = { asked: gate(), release: gate() };
  const running = runBodyTranslation(late.articleId, recipe);
  await hold.asked.promise;
  await assert.rejects(runBodyTranslation(late.articleId, recipe), /in flight/);
  await material("late", "<p>Changed source.</p>");
  hold.release.open();
  hold = null;
  assert.equal((await running).status, "stale");
  assert.equal(requests.length - before, 1);
  assert.equal((await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${late.articleId}`)[0]!.n, 0);
});

test("unknown prior recipe blocks a new paid key for the same material revision and stage", async () => {
  for (const initial of ["reset", "no-usage-length"]) {
    mode = initial;
    const { articleId } = await material(`unknown-recipe-${initial}`, halves(`unknown-recipe-${initial}`)),
      start = requests.length;
    if (initial === "reset") await assert.rejects(runBodyTranslation(articleId, recipe));
    else assert.equal((await runBodyTranslation(articleId, recipe)).reason, "truncated");
    mode = "normal";
    await assert.rejects(
      runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-changed", promptVersion: recipe.promptVersion + "-changed" }),
      /unknown outcome/,
    );
    assert.equal(requests.length - start, 1);
    assert.equal(
      (await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`)[0]!.status,
      initial === "reset" ? "unknown" : "received",
    );
  }
});

test("A/B sharing an unknown receipt cannot evade the hold by changing B's recipe", async () => {
  const html = halves("shared-unknown"),
    a = await material("shared-a", html),
    b = await material("shared-b", html),
    start = requests.length;
  assert.notEqual(a.articleId, b.articleId);
  mode = "reset";
  await assert.rejects(runBodyTranslation(a.articleId, recipe));
  await assert.rejects(runBodyTranslation(b.articleId, recipe));
  const rows =
    await sql`SELECT s.article_id,s.receipt_id,s.attempt_id,r.subject,r.status FROM enrichment.translation_segments s JOIN receipts r ON r.id=s.receipt_id
    WHERE s.article_id=ANY(${[a.articleId, b.articleId]}::text[]) ORDER BY s.article_id`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.article_id, b.articleId);
  assert.ok(rows.every((row) => row.subject.startsWith(`article:${a.articleId}@1#`)));
  assert.equal(requests.length - start, 1);
  mode = "normal";
  let result: unknown, error: unknown;
  try {
    result = await runBodyTranslation(b.articleId, { ...recipe, id: recipe.id + "-B2", promptVersion: recipe.promptVersion + "-B2" });
  } catch (e) {
    error = e;
  }
  console.log(
    "SHARED_UNKNOWN_PROBE=" +
      JSON.stringify({ a: a.articleId, b: b.articleId, observations: rows, providerHits: requests.length - start, result, error: String(error) }),
  );
  assert.ok(error instanceof Error && /unknown outcome/.test(error.message), "B's observed attempt must remain blocked across recipe keys");
  assert.equal(requests.length - start, 1);
});

test("a shared pending observation closes the pre-catch window; non-billing releases only the confirmed attempt", async () => {
  const html = halves("shared-pending"),
    a = await material("pending-a", html),
    b = await material("pending-b", html),
    start = requests.length;
  mode = "reset";
  hold = { asked: gate(), release: gate() };
  const stopped = assert.rejects(runBodyTranslation(a.articleId, recipe));
  await hold.asked.promise;
  await assert.rejects(runBodyTranslation(b.articleId, recipe), /in flight/);
  assert.equal(
    (await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${b.articleId}`)[0]!.n,
    0,
    "there is no catch-written checkpoint yet",
  );
  const changed = { ...recipe, id: recipe.id + "-pending", promptVersion: recipe.promptVersion + "-pending" };
  await assert.rejects(runBodyTranslation(b.articleId, changed), /in flight/);
  assert.equal(requests.length - start, 1);
  hold.release.open();
  hold = null;
  await stopped;
  const [receipt] = await sql`SELECT id FROM receipts WHERE subject=${`article:${a.articleId}@1#0`}`;
  const old = await observedVersion(receipt!.id);
  const confirm = (version: string) => releaseReceipt(receipt!.id, { billed: false, note: "SELF_AUTHORED non-billing confirmation", version }, "fixture");
  await confirm(old);
  mode = "reset";
  await assert.rejects(runBodyTranslation(b.articleId, recipe));
  assert.equal(requests.length - start, 2);
  await assert.rejects(confirm(old), { code: "conflict" });
  await assert.rejects(runBodyTranslation(b.articleId, changed), /unknown outcome/);
  assert.equal(requests.length - start, 2, "old confirmation cannot unlock the new unknown attempt");
  await confirm(await observedVersion(receipt!.id));
  mode = "normal";
  assert.equal((await runBodyTranslation(b.articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, 3);
  const observations =
    await sql`SELECT receipt_version,attempt_id FROM ai.translation_receipt_observations WHERE scope=${`article:${b.articleId}@1`} ORDER BY receipt_version`;
  assert.deepEqual(
    observations.map((r) => r.receipt_version),
    [1, 2, 3],
  );
  assert.equal(new Set(observations.map((r) => r.attempt_id)).size, 3);
});

test("unbound historical cache records null observation and cannot authorize a changed-key purchase", async () => {
  mode = "normal";
  const html = halves("unbound-shared"),
    a = await material("history-a", html),
    b = await material("history-b", html);
  assert.equal((await runBodyTranslation(a.articleId, recipe)).status, "translated");
  const [receipt] = await sql`SELECT id FROM receipts WHERE subject=${`article:${a.articleId}@1#0`}`;
  await sql`DELETE FROM ai.translation_receipt_observations WHERE receipt_id=${receipt!.id}`;
  await sql`UPDATE receipts SET response_attempt_id=NULL WHERE id=${receipt!.id}`;
  const start = requests.length;
  assert.equal((await runBodyTranslation(b.articleId, recipe)).reason, "unbound historical response");
  assert.equal((await sql`SELECT attempt_id FROM ai.translation_receipt_observations WHERE scope=${`article:${b.articleId}@1`}`)[0]!.attempt_id, null);
  await assert.rejects(
    runBodyTranslation(b.articleId, { ...recipe, id: recipe.id + "-history", promptVersion: recipe.promptVersion + "-history" }),
    /unknown outcome/,
  );
  assert.equal(requests.length, start, "neither MAX(attempt id) nor a new recipe repairs missing response provenance");
});

test("an explicit non-billing decision resolves only the unproved historical counter before new real attempts", async () => {
  const { articleId } = await material("legacy-unknown", `<p>Old input ${T}.</p><p>Following legacy input ${T}.</p>`),
    start = requests.length;
  mode = "reset";
  await assert.rejects(runBodyTranslation(articleId, recipe));
  const [receipt] = await sql`SELECT id FROM receipts WHERE subject=${`article:${articleId}@1#0`}`;
  // A pre-attempt history fixture: no actual attempt evidence is invented during recovery.
  await sql`DELETE FROM ai.translation_receipt_observations WHERE receipt_id=${receipt!.id}`;
  await sql`DELETE FROM receipt_attempts WHERE receipt_id=${receipt!.id}`;
  await assert.rejects(runBodyTranslation(articleId, recipe), /unknown outcome/);
  assert.equal((await sql`SELECT attempt_id FROM ai.translation_receipt_observations WHERE scope=${`article:${articleId}@1`}`)[0]!.attempt_id, null);
  await releaseReceipt(
    receipt!.id,
    { billed: false, note: "SELF_AUTHORED historical non-billing evidence", version: await observedVersion(receipt!.id) },
    "fixture",
  );
  mode = "normal";
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(requests.length - start, 3, "only the explicitly released first request and the following segment are sent");
  const observations =
    await sql`SELECT receipt_version,attempt_id,known_unbilled FROM ai.translation_receipt_observations WHERE scope=${`article:${articleId}@1`} AND receipt_id=${receipt!.id} ORDER BY receipt_version`;
  assert.deepEqual({ ...observations[0]! }, { receipt_version: 1, attempt_id: null, known_unbilled: true });
  assert.match(observations[1]!.attempt_id, /^[1-9][0-9]*$/);
  assert.equal(observations[1]!.receipt_version, 2);
  assert.equal(observations[1]!.known_unbilled, false);
});

test("upgrade recovers an own paid attempt before any segment or observation existed", async () => {
  for (const initial of ["pending", "reset", "no-usage-length", "normal"]) {
    const { articleId } = await material(`pre-observation-${initial}`, `<p>Historical ${initial} ${T}.</p>`),
      stage = `article:${articleId}@1`,
      start = requests.length;
    mode = initial === "pending" ? "reset" : initial;
    if (initial === "pending") hold = { asked: gate(), release: gate() };
    // The old chatJson/paidRequest path has no translation opt-in and writes no observation.
    const stopped = chatJson({
      ...recipe,
      purpose: "translate_body",
      subject: `${stage}#0`,
      user: JSON.stringify({ text: `Legacy ${initial} ${T}.` }),
      schema: z.object({ text: z.string() }),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (hold) await hold.asked.promise;
    else await stopped;
    const [old] = await sql`SELECT r.id::text,r.status,a.id::text AS attempt_id FROM receipts r
      JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts WHERE r.subject=${`${stage}#0`}`;
    assert.equal(old!.status, initial === "pending" ? "pending" : initial === "reset" ? "unknown" : "received");
    assert.equal((await sql`SELECT count(*) AS n FROM ai.translation_receipt_observations WHERE scope=${stage}`)[0]!.n, 0);
    assert.equal((await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${articleId}`)[0]!.n, 0);
    mode = "normal";
    let outcome: unknown, error: unknown;
    try {
      outcome = await runBodyTranslation(articleId, { ...recipe, id: recipe.id + initial, promptVersion: recipe.promptVersion + initial });
    } catch (failure) {
      error = failure;
    } finally {
      hold?.release.open();
      hold = null;
      await stopped;
    }
    console.log("LEGACY_NO_OBSERVATION=" + JSON.stringify({ initial, old, calls: requests.length - start, outcome, error: String(error) }));
    assert.equal(requests.length - start, initial === "normal" ? 2 : 1);
    if (initial === "normal") assert.equal((outcome as { status: string }).status, "translated");
    else assert.match(String(error), initial === "pending" ? /in flight/ : /unknown outcome/);
    const [observed] = await sql`SELECT receipt_version,attempt_id FROM ai.translation_receipt_observations
      WHERE scope=${stage} AND receipt_id=${old!.id}`;
    assert.deepEqual({ ...observed }, { receipt_version: 1, attempt_id: old!.attempt_id });
  }
});

test("upgrade must retain an own-material unknown when old worker persisted no checkpoint or observation", async () => {
  mode = "reset";
  const { articleId } = await material("old-worker-before-catch", `<p>Historical material ${T}.</p>`);
  const start = requests.length;
  await assert.rejects(runBodyTranslation(articleId, recipe));
  assert.equal(requests.length, start + 1);
  const [old] = await sql`SELECT id,status FROM receipts WHERE subject=${`article:${articleId}@1#0`}`;
  assert.equal(old.status, "unknown");
  // These two stores did not exist yet, or had not been written, at the old process exit window.
  // Keep the actual paid receipt and actual attempt intact.
  await sql`DELETE FROM ai.translation_receipt_observations WHERE scope=${`article:${articleId}@1`}`;
  await sql`DELETE FROM enrichment.translation_segments WHERE article_id=${articleId}`;
  mode = "normal";
  let outcome: unknown, error: unknown;
  try {
    outcome = await runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-after-upgrade", promptVersion: recipe.promptVersion + "-after-upgrade" });
  } catch (failure) {
    error = failure;
  }
  console.log("ROOT_LEGACY_NO_OBSERVATION=" + JSON.stringify({ articleId, old, calls: requests.length - start, outcome, error: String(error) }));
  assert.equal(requests.length, start + 1, "unresolved old physical request must block a new paid key even before new observation storage was introduced");
  assert.match(String(error), /unknown outcome/);
});
