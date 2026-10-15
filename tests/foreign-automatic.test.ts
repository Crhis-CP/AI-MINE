import "./setup.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { gate } from "./setup.ts";
import { foreignFixture } from "./foreign-automatic-fixture.ts";

const mixed = [
  ["MIXED_EN", "A copper project named 铜 is not yet approved. The English report states conditions and exceptions."],
  ["MIXED_ES", "La empresa 铜 informa que el proyecto no está aprobado y las condiciones siguen pendientes."],
  ["JAPANESE", "銅鉱山の計画は承認されていません。条件と例外を確認する必要があります。"],
] as const;

async function unidentifiedStage(t: TestContext) {
  const f = await foreignFixture(t, {
    name: "unknown-language-fixture",
    samples: mixed.map(([marker, text]) => ({ marker, title: marker, label: "PASS", body: `${marker} ${text} `.repeat(8) })),
  });
  await f.until("unknown languages recorded", async () => (await f.rows()).length === 3 && (await f.rows()).every((row) => row.processing_state === "failed"));
  for (const row of await f.rows()) {
    assert.equal(row.language, null);
    assert.match(row.processing_error, /language_unidentified/);
    assert.equal((await f.reader.inject(`/api/site/items/${row.id}`)).statusCode, 404);
  }
  assert.equal(f.calls.length, 0, "no classification or translation payment occurs before language is identified");
  assert.equal((await f.sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  await f.until(
    "unknown source settled",
    async () => (await f.sql`SELECT status FROM fetch_runs WHERE source_id='unknown-language-fixture' ORDER BY id DESC LIMIT 1`)[0]?.status === "ok",
  );
  await f.closeSurfaces();
}

test("foreign material is public once it has a Chinese title and guide; a full translation can follow", async (t) => {
  const release = gate();
  t.after(() => release.open());
  await unidentifiedStage(t);
  const markers = ["FOREIGN_LOW", "FOREIGN_SELECTED", "FOREIGN_WITHDRAWN"];
  const f = await foreignFixture(t, {
    name: "foreign-complete-fixture",
    reuseWorker: true,
    language: "EN-us",
    samples: markers.map((marker, i) => ({
      marker,
      title: `Copper processing ${marker}`,
      label: "PASS",
      score: i === 1 ? 80 : 10,
      body:
        `${marker}_FIRST: A self-authored copper processing example. `.repeat(8) +
        "</p><p>" +
        `${marker}_LAST: Final conditions and exceptions apply. `.repeat(4),
    })),
    translate: async (marker, text) => {
      await release.promise;
      return { text: `合成中文全文 ${marker} ${text.includes("_LAST") ? "末段条件与例外" : "首段材料"}，只用于工程验证。` };
    },
  });
  await f.until(
    "analysis complete, guide public, translation held",
    async () =>
      (await f.rows()).length === 3 &&
      (await f.rows()).every((row) => row.processing_state === "analyzed" && row.visibility === "public") &&
      f.calls.some((call) => call.step === "translate"),
  );
  const rows = await f.rows();
  for (const row of rows) {
    assert.equal(row.language, "en-US");
    assert.equal(row.visibility, "public");
    const res = await f.reader.inject(`/api/site/items/${row.id}`);
    assert.equal(res.statusCode, 200, res.body);
    const detail = res.json();
    assert.match(detail.summary, /合成模型导读/);
    assert.ok(detail.links.original);
    assert.equal(detail.body?.zh ?? null, null, "a held translation is not shown as Chinese body text");
    assert.equal(detail.body?.complete ?? false, false);
  }
  const withdrawn = rows.find((row) => row.title.includes("FOREIGN_WITHDRAWN"))!;
  const withdrawal = await f.admin.inject({
    method: "POST",
    url: `/api/admin/content/${withdrawn.id}/visibility`,
    headers: f.headers,
    payload: { visibility: "withdrawn", reason: "synthetic manual withdrawal", version: 0 },
  });
  assert.equal(withdrawal.statusCode, 200, withdrawal.body);
  const before = f.calls.length;
  await f.reader.inject("/api/site/pool");
  await f.reader.inject("/api/v1/items?mode=selected");
  await f.reader.inject("/feed.xml");
  assert.equal(f.calls.length, before, "reader requests never progress the held worker");
  release.open();
  await f.until("selected translation complete", async () => {
    const selected = (await f.rows()).find((row) => row.selected);
    if (!selected) return false;
    const res = await f.reader.inject(`/api/site/items/${selected.id}`);
    return res.statusCode === 200 && res.json().body?.complete === true;
  });
  for (const row of (await f.rows()).filter((row) => row.id !== withdrawn.id)) {
    const res = await f.reader.inject(`/api/site/items/${row.id}`);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json().body;
    assert.equal(body.complete, row.selected);
    if (row.selected) assert.match(body.zh, /末段条件与例外/);
    else assert.equal(body.zh, null);
    assert.equal(body.original, null);
    assert.equal(row.selected, row.title.includes("FOREIGN_SELECTED"));
  }
  assert.ok(!f.calls.some((call) => call.marker === "FOREIGN_LOW" && call.step === "translate"));
  assert.equal((await f.reader.inject(`/api/site/items/${withdrawn.id}`)).statusCode, 404);
  assert.ok(!f.calls.some((call) => call.marker === "FOREIGN_WITHDRAWN" && call.step === "translate"));
  const calls = f.calls.filter((call) => call.step === "translate");
  assert.equal(calls.length, 2);
  const [receipts] =
    await f.sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='translate_body' AND status='completed' AND response_attempt_id IS NOT NULL`;
  assert.equal(receipts.n, 2);
  const snapshot = f.calls.length;
  for (const row of rows) await f.reader.inject(`/api/site/items/${row.id}`);
  assert.equal(f.calls.length, snapshot);
  await f.closeSurfaces();
  const bad = await foreignFixture(t, {
    name: "foreign-bad-fixture",
    reuseWorker: true,
    language: "es",
    samples: [
      {
        marker: "BAD_TRANSLATION",
        score: 80,
        title: "Ensayo de cobre",
        label: "PASS",
        body: "BAD_TRANSLATION: El proyecto de cobre tiene condiciones pendientes. ".repeat(8),
      },
      {
        marker: "SCOPE_UNKNOWN",
        score: 80,
        title: "Datos pendientes",
        label: "UNKNOWN",
        body: "SCOPE_UNKNOWN: Los datos del proyecto requieren comprobación. ".repeat(8),
      },
    ],
    // A selected UNKNOWN case follows the same publication and permitted background translation flow.
    translate: async (marker) => (marker === "SCOPE_UNKNOWN" ? { text: `合成中文全文 ${marker}，只用于工程验证。` } : { text: "Only untranslated English" }),
  });
  await bad.until(
    "bad translation durably rejected",
    async () => (await bad.sql`SELECT count(*)::int AS n FROM enrichment.translation_segments WHERE state='failed'`)[0].n > 0,
  );
  await bad.until("guide stays up and the valid body is complete", async () => {
    const rows = await bad.rows();
    if (rows.length !== 2 || !rows.every((row) => row.processing_state === "analyzed" && row.visibility === "public")) return false;
    const good = rows.find((row) => row.title.includes("Datos"));
    if (!good) return false;
    const res = await bad.reader.inject(`/api/site/items/${good.id}`);
    return res.statusCode === 200 && res.json().body?.complete === true;
  });
  for (const row of await bad.rows()) {
    const res = await bad.reader.inject(`/api/site/items/${row.id}`);
    assert.equal(res.statusCode, 200, row.title);
    const detail = res.json();
    assert.match(detail.summary, /合成模型导读/);
    if (row.title.includes("Ensayo")) assert.equal(detail.body?.zh ?? null, null, "a failed body is not shown as a translation");
    else assert.equal(detail.body.complete, true);
  }
  const badId = (await bad.rows()).find((row) => row.title.includes("Ensayo"))!.id;
  await bad.until(
    "failed job retained for retry",
    async () =>
      (
        await bad.sql`SELECT state FROM pgboss.job
    WHERE name='content.translate' AND data->>'articleId'=${badId} ORDER BY created_on DESC LIMIT 1`
      )[0]?.state === "retry",
  );
  const jobs = await bad.sql`SELECT id FROM pgboss.job WHERE name='content.translate' AND data->>'articleId'=${badId} AND state='retry'`;
  for (const job of jobs) await bad.boss.cancel("content.translate", job.id);
  await bad.closeSurfaces();
  const restricted = await foreignFixture(t, {
    name: "foreign-restricted-fixture",
    reuseWorker: true,
    language: "en",
    siteFulltext: false,
    samples: [
      { marker: "RESTRICTED", title: "Copper notice", label: "PASS", body: "RESTRICTED: A self-authored copper operation reports changes. ".repeat(8) },
    ],
  });
  await restricted.until(
    "summary-only source published as a guide",
    async () => (await restricted.rows())[0]?.processing_state === "analyzed" && (await restricted.rows())[0]?.visibility === "public",
  );
  const [guideRow] = await restricted.rows();
  const guide = await restricted.reader.inject(`/api/site/items/${guideRow.id}`);
  assert.equal(guide.statusCode, 200, guide.body);
  const guideDetail = guide.json();
  assert.match(guideDetail.summary, /合成模型导读/);
  assert.ok(guideDetail.links.original);
  assert.equal(guideDetail.body, null, "site full text stays off, so no body is invented");
  assert.ok(!restricted.calls.some((call) => call.step === "translate"), "a closed full-text switch does not buy a body translation");
});
