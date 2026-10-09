import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { acquirePolicyOriginal } from "../packages/backend/src/policy/acquire.ts";
import { extractPolicyOriginal, type ExtractionProfile } from "../packages/backend/src/policy/extraction.ts";
import { readPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("policy"),
  url = "https://source.invalid/rule",
  annex = "https://source.invalid/annex.pdf";
const pdf = readFileSync(new URL("./fixtures/policy/text.pdf", import.meta.url));
const html =
  '<article><h1>Rule</h1><table><tr><th>Threshold</th><th>Unit</th></tr><tr><td>10</td><td>mg</td></tr></table><p>Final exception: mining is not waived.</p><a data-annex href="/annex.pdf">Required annex</a></article>';
const profile: ExtractionProfile = {
  bodySelector: "article",
  attachmentSelector: "[data-annex]",
  maxBytes: 100000,
  maxResources: 10,
  maxPages: 10,
  maxTextBytes: 10000,
};
let sourceId: string,
  serial = 0;
after(closeDb);
beforeEach(async () => {
  sourceId = `extract-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Synthetic extraction','external','policy')`;
  await grantDateFixture(sourceId, [url]);
});
const input = () => ({
  sourceId,
  permissionVersion: 1,
  identity: { jurisdiction: "AR", authority: sourceId, documentType: "decree", documentNumber: null, officialUrl: url },
  versionKey: null,
  language: "en",
  kind: "original" as const,
  officialTitle: "Original rule",
  expectedHead: null,
});
function pages(main: string | Buffer = html, attachment = pdf) {
  const calls: string[] = [];
  const get: NonNullable<Parameters<typeof acquirePolicyOriginal>[2]> = async (target, options) => {
    calls.push(target);
    assert.equal(options.maxRedirects, 0);
    const body = target === annex ? attachment : Buffer.isBuffer(main) ? main : Buffer.from(main);
    const headers = new Headers({ "content-type": target === annex || Buffer.isBuffer(main) ? "application/pdf" : "text/html; charset=utf-8" });
    return { url: target, status: 200, headers, body, text: () => body.toString() };
  };
  return { get, calls };
}

test("acquire stores exact originals; HTML keeps table and tail; PDF text has page/coordinates without claiming layout completeness; results are durable and idempotent", async () => {
  const source = pages(),
    saved = await acquirePolicyOriginal(input(), profile, source.get);
  assert.deepEqual(source.calls, [url, annex]);
  const raw = await readPolicyOriginal(saved.expressionId);
  assert.deepEqual(raw!.resources[1].body, pdf);
  const result = await extractPolicyOriginal(saved.expressionId, profile);
  assert.match(result.resources[0]!.nodes.map((node) => node.html).join(""), /<td>10<\/td><td>mg<\/td>/);
  assert.match(result.resources[0]!.nodes.map((node) => node.text).join(""), /Final exception: mining is not waived/);
  assert.deepEqual([...new Set(result.resources[1]!.nodes.map((node) => node.page))], [1, 2]);
  assert.ok(result.resources[1]!.nodes.every((node) => node.transform?.length === 6));
  assert.equal(result.resources[1]!.state, "incomplete");
  assert.match(result.resources[1]!.gaps.join(" "), /版面、表格/);
  assert.deepEqual(await extractPolicyOriginal(saved.expressionId, profile), result);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_extractions WHERE revision_id=${saved.revisionId}`)[0].n, 1);
});

test("fetch denied or out-of-scope attachment never reaches that address; official metadata and private persistence cannot bypass permission", async () => {
  const foreign = pages(html.replace("/annex.pdf", "https://other.invalid/annex.pdf"));
  await assert.rejects(acquirePolicyOriginal(input(), profile, foreign.get), /permission denied/);
  assert.deepEqual(foreign.calls, [url]);
  const current = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(
    sourceId,
    {
      policy: { ...current, permission_version: 2, permissions: { ...current.permissions, fetch: "deny" } },
      expectedVersion: 1,
      reason: "synthetic narrowing",
    },
    "test",
  );
  const stopped = pages();
  await assert.rejects(acquirePolicyOriginal({ ...input(), permissionVersion: 2 }, profile, stopped.get), /fetch/);
  assert.deepEqual(stopped.calls, []);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE source_id=${sourceId}`)[0].n, 0);
});

test("byte, page, text and attachment capacity remain explicit failures, with no truncated qualified text", async () => {
  const oversized = await acquirePolicyOriginal(input(), { ...profile, maxBytes: 5 }, pages().get);
  assert.equal(oversized.state, "blocked_capacity");
  const saved = await acquirePolicyOriginal({ ...input(), expectedHead: oversized.revisionId }, profile, pages().get);
  const onePage = await extractPolicyOriginal(saved.expressionId, { ...profile, maxPages: 1 });
  assert.equal(onePage.resources[1]!.state, "blocked_capacity");
  assert.deepEqual(onePage.resources[1]!.nodes, []);
  const tinyText = await extractPolicyOriginal(saved.expressionId, { ...profile, maxTextBytes: 5 });
  assert.ok(tinyText.resources.every((resource) => resource.state === "blocked_capacity" && !resource.nodes.length));
  const tooMany = await acquirePolicyOriginal({ ...input(), expectedHead: saved.revisionId }, { ...profile, maxResources: 1 }, pages().get);
  assert.equal(tooMany.state, "blocked_capacity");
});

test("corrupt PDF, blank/scanned page, characters lost by cleaning and visual references leave specific gaps", async () => {
  for (const [name, main, pattern] of [
    ["damaged", Buffer.from("%PDF-invalid"), /无法完整解析/],
    ["blank", readFileSync(new URL("./fixtures/policy/empty-page.pdf", import.meta.url)), /第 2 页无可核验文字层/],
    ["visual", '<article><p>Valid text</p><img src="/chart.png"></article>', /未核验图件/],
    ["loss", '<article><div class="promo-box">Binding exception</div><p>Valid text</p></article>', /文字与完整正文选区不一致/],
    ["garbled", "<article><p>Threshold \uFFFD10</p></article>", /字符完整性/],
  ] as const) {
    const saved = await acquirePolicyOriginal({ ...input(), identity: { ...input().identity, documentNumber: name } }, profile, pages(main).get);
    const result = await extractPolicyOriginal(saved.expressionId, profile);
    assert.equal(result.resources[0]!.state, "incomplete");
    assert.match(result.resources[0]!.gaps.join(" "), pattern);
  }
});

test("new originals get distinct extraction records and narrowed current permissions block cached processing", async () => {
  const first = await acquirePolicyOriginal(input(), profile, pages().get);
  await extractPolicyOriginal(first.expressionId, profile);
  const second = await acquirePolicyOriginal({ ...input(), expectedHead: first.revisionId }, profile, pages(html.replace("10</td>", "11</td>")).get);
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal((await extractPolicyOriginal(second.expressionId, profile)).revisionId, second.revisionId);
  const current = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(
    sourceId,
    {
      policy: { ...current, permission_version: 2, permissions: { ...current.permissions, process_locally: "deny" } },
      expectedVersion: 1,
      reason: "synthetic narrowing",
    },
    "test",
  );
  await assert.rejects(extractPolicyOriginal(second.expressionId, profile), /permission version changed/i);
});

test("empty response and unresolvable catalogue stay incomplete; a permission change during fetch prevents persistence", async () => {
  const empty = await acquirePolicyOriginal(input(), profile, pages("").get);
  assert.equal(empty.state, "incomplete");
  const missingLink = await acquirePolicyOriginal(
    { ...input(), expectedHead: empty.revisionId },
    profile,
    pages("<article><p>Body</p><a data-annex>Missing address</a></article>").get,
  );
  const result = await extractPolicyOriginal(missingLink.expressionId, profile);
  assert.equal(result.state, "incomplete");
  assert.deepEqual(result.gaps, ["附件目录尚未闭合"]);
  const source = pages("<article><p>New body</p></article>");
  await assert.rejects(
    acquirePolicyOriginal({ ...input(), expectedHead: missingLink.revisionId }, profile, async (target, options) => {
      const reply = await source.get(target, options),
        current = (await readCurrentSourcePolicy(sourceId))!;
      await saveSourcePolicy(
        sourceId,
        {
          policy: { ...current, permission_version: 2, permissions: { ...current.permissions, store_fulltext: "deny" } },
          expectedVersion: 1,
          reason: "synthetic race",
        },
        "test",
      );
      return reply;
    }),
    /permission version changed/i,
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE source_id=${sourceId}`)[0].n, 2);
});
